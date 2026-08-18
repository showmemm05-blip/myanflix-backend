import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, PaymentAccountTransactionType } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateManualPaymentAccountTransactionDto } from './dto/create-manual-payment-account-transaction.dto';

/** Types that increase a PaymentAccount's balance. Everything else decreases it. */
const CREDIT_TYPES = new Set<PaymentAccountTransactionType>([
  PaymentAccountTransactionType.OPENING_BALANCE,
  PaymentAccountTransactionType.MANUAL_CREDIT,
  PaymentAccountTransactionType.DEPOSIT_IN,
  PaymentAccountTransactionType.ADJUSTMENT_CREDIT,
]);

interface ApplyMovementInput {
  type: PaymentAccountTransactionType;
  amount: Prisma.Decimal | number;
  referenceCode: string | null;
  note: string | null;
  relatedDepositId: string | null;
  relatedWithdrawalId: string | null;
  performedByUserId: string | null;
}

/** The narrow shape syncDepositLink/syncWithdrawalLink need from the caller's
 * already-fetched Deposit/Withdrawal row — not the full Prisma model, so the
 * callers don't need to over-select. */
interface LinkableDeposit {
  id: string;
  amount: Prisma.Decimal;
  receivingPaymentAccountId: string | null;
}
interface LinkableWithdrawal {
  id: string;
  amount: Prisma.Decimal;
  transferPaymentAccountId: string | null;
}

/**
 * Owns every balance-affecting write to PaymentAccount — the ledger
 * (PaymentAccountTransaction) is the source of truth, and
 * PaymentAccount.balance/totalIn/totalOut are caches this service is the
 * only writer of. Every public method here must run inside the caller's own
 * `prisma.$transaction`, mirroring WalletService's
 * credit/debitWithinTransaction pattern.
 */
@Injectable()
export class PaymentAccountLedgerService {
  constructor(private readonly prisma: PrismaService) {}

  /** Manual Add/Remove Money — entry point for the admin dialog. Owns its own transaction. */
  async recordManualEntry(
    paymentAccountId: string,
    dto: CreateManualPaymentAccountTransactionDto,
    actorUserId: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const account = await tx.paymentAccount.findUnique({
        where: { id: paymentAccountId },
      });
      if (!account) throw new NotFoundException('Payment account not found');

      return this.applyMovement(tx, paymentAccountId, {
        type: dto.type,
        amount: dto.amount,
        referenceCode: dto.referenceCode ?? null,
        note: dto.note ?? null,
        relatedDepositId: null,
        relatedWithdrawalId: null,
        performedByUserId: actorUserId,
      });
    });
  }

  /**
   * Called from inside DepositsService.updateReceivingAccount's own
   * transaction, right before the Deposit row itself is updated. No-ops if
   * the picked account hasn't actually changed. Otherwise, atomically claims
   * the change on Deposit.receivingPaymentAccountId (same "claim via
   * updateMany guarded on the previously-read value" idiom
   * DepositsService.approve() uses for `status`) so a concurrent second save
   * can't silently double-post — it fails loudly instead. If there was a
   * previous account, reverses it (ADJUSTMENT_DEBIT); if there's a new one,
   * posts DEPOSIT_IN against it. Handles re-linking (pick A, save, reopen,
   * pick B) correctly without needing a uniqueness constraint that would
   * block a legitimate re-link.
   */
  async syncDepositLink(
    tx: Prisma.TransactionClient,
    deposit: LinkableDeposit,
    newPaymentAccountId: string | null,
    referenceCode: string | null,
    actorUserId: string,
  ): Promise<void> {
    if (newPaymentAccountId === deposit.receivingPaymentAccountId) return;

    const claim = await tx.deposit.updateMany({
      where: { id: deposit.id, receivingPaymentAccountId: deposit.receivingPaymentAccountId },
      data: { receivingPaymentAccountId: newPaymentAccountId },
    });
    if (claim.count !== 1) {
      throw new ConflictException(
        "This deposit's receiving account changed concurrently — reload and try again",
      );
    }

    if (deposit.receivingPaymentAccountId) {
      await this.applyMovement(tx, deposit.receivingPaymentAccountId, {
        type: PaymentAccountTransactionType.ADJUSTMENT_DEBIT,
        amount: deposit.amount,
        referenceCode: null,
        note: 'Reversal: deposit re-linked to a different receiving account',
        relatedDepositId: deposit.id,
        relatedWithdrawalId: null,
        performedByUserId: actorUserId,
      });
    }
    if (newPaymentAccountId) {
      await this.applyMovement(tx, newPaymentAccountId, {
        type: PaymentAccountTransactionType.DEPOSIT_IN,
        amount: deposit.amount,
        referenceCode,
        note: null,
        relatedDepositId: deposit.id,
        relatedWithdrawalId: null,
        performedByUserId: actorUserId,
      });
    }
  }

  /** Mirror of syncDepositLink for WithdrawalsService.updateTransferAccount — reversal is ADJUSTMENT_CREDIT, forward is WITHDRAWAL_OUT. */
  async syncWithdrawalLink(
    tx: Prisma.TransactionClient,
    withdrawal: LinkableWithdrawal,
    newPaymentAccountId: string | null,
    referenceCode: string | null,
    actorUserId: string,
  ): Promise<void> {
    if (newPaymentAccountId === withdrawal.transferPaymentAccountId) return;

    const claim = await tx.withdrawal.updateMany({
      where: { id: withdrawal.id, transferPaymentAccountId: withdrawal.transferPaymentAccountId },
      data: { transferPaymentAccountId: newPaymentAccountId },
    });
    if (claim.count !== 1) {
      throw new ConflictException(
        "This withdrawal's transfer account changed concurrently — reload and try again",
      );
    }

    if (withdrawal.transferPaymentAccountId) {
      await this.applyMovement(tx, withdrawal.transferPaymentAccountId, {
        type: PaymentAccountTransactionType.ADJUSTMENT_CREDIT,
        amount: withdrawal.amount,
        referenceCode: null,
        note: 'Reversal: withdrawal re-linked to a different transfer account',
        relatedDepositId: null,
        relatedWithdrawalId: withdrawal.id,
        performedByUserId: actorUserId,
      });
    }
    if (newPaymentAccountId) {
      await this.applyMovement(tx, newPaymentAccountId, {
        type: PaymentAccountTransactionType.WITHDRAWAL_OUT,
        amount: withdrawal.amount,
        referenceCode,
        note: null,
        relatedDepositId: null,
        relatedWithdrawalId: withdrawal.id,
        performedByUserId: actorUserId,
      });
    }
  }

  /**
   * Core primitive — atomic balance increment/decrement + matching ledger
   * row. No `gte` guard on debits (unlike WalletService.debitWithinTransaction):
   * this is an internal bookkeeping ledger, not a user-facing spend limit, and
   * every account starts at balance 0, so blocking a debit here would risk
   * blocking an already-approved withdrawal the moment tracked debits exceed
   * tracked credits — deliberately allowed to go negative instead.
   *
   * `balanceBefore` is derived arithmetically from the just-written
   * `balanceAfter` rather than a separate read-before-write, so it can't race
   * against a concurrent movement on the same account.
   */
  private async applyMovement(
    tx: Prisma.TransactionClient,
    paymentAccountId: string,
    input: ApplyMovementInput,
  ) {
    const isCredit = CREDIT_TYPES.has(input.type);
    const amount = new Prisma.Decimal(input.amount);
    const signed = isCredit ? amount : amount.negated();

    const account = await tx.paymentAccount.update({
      where: { id: paymentAccountId },
      data: {
        balance: { increment: signed },
        ...(isCredit ? { totalIn: { increment: amount } } : { totalOut: { increment: amount } }),
      },
    });

    const balanceAfter = account.balance;
    const balanceBefore = isCredit ? balanceAfter.minus(amount) : balanceAfter.plus(amount);

    const entry = await tx.paymentAccountTransaction.create({
      data: {
        paymentAccountId,
        type: input.type,
        amount,
        balanceBefore,
        balanceAfter,
        referenceCode: input.referenceCode,
        note: input.note,
        relatedDepositId: input.relatedDepositId,
        relatedWithdrawalId: input.relatedWithdrawalId,
        performedByUserId: input.performedByUserId,
      },
    });

    return { account, entry };
  }
}
