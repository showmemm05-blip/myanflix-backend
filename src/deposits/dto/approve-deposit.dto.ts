import { IsOptional, IsUUID } from 'class-validator';

/**
 * Optional body for approving a deposit. When `paymentAccountId` is present
 * (including explicit `null`), it overrides whatever the depositor declared
 * at submission time — letting the admin pick or clear the credited account
 * right at the moment of approval, since the depositor's own selection isn't
 * always reliably captured. Omitted entirely, DepositsService.approve falls
 * back to Deposit.declaredPaymentAccountId, preserving old-client behavior.
 */
export class ApproveDepositDto {
  @IsOptional()
  @IsUUID('4')
  paymentAccountId?: string | null;
}
