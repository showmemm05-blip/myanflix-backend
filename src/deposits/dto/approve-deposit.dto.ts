import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

/**
 * Optional body for approving a deposit. When `paymentAccountId` is present
 * (including explicit `null`), it overrides whatever the depositor declared
 * at submission time — letting the admin pick or clear the credited account
 * right at the moment of approval, since the depositor's own selection isn't
 * always reliably captured. Omitted entirely, DepositsService.approve falls
 * back to Deposit.declaredPaymentAccountId, preserving old-client behavior.
 *
 * M-15/M-7: when the bank saw a DIFFERENT amount than the user typed
 * (receivingAmount ≠ amount) the approval is refused unless
 * `creditBankAmount` is true AND `overrideReason` says why. The wallet is
 * then credited the BANK amount — the money that really arrived — never
 * the typed one, and both amounts plus the reason land in the audit row.
 */
export class ApproveDepositDto {
  @IsOptional()
  @IsUUID('4')
  paymentAccountId?: string | null;

  @IsOptional()
  @IsBoolean()
  creditBankAmount?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  overrideReason?: string;
}
