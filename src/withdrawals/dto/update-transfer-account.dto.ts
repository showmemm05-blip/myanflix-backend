import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * The account WE sent the money FROM — entirely separate from the user's own
 * withdrawal destination (accountType/accountName/accountNumber on the
 * Withdrawal model), which this never touches.
 */
export class UpdateTransferAccountDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  transferAccountType!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  transferAccountName!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  transferAccountNumber!: string;
}
