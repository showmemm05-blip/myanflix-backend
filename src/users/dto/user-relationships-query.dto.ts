import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Deliberately NOT run through `normalizePhone` here (unlike the auth DTOs):
 * the relationship walk keeps the raw spelling for display and does its own
 * digits-only normalization, which also has to accept non-Myanmar strings
 * (a payout `accountNumber` may be a bank account, not a phone).
 */
export class UserRelationshipsQueryDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  phone!: string;
}
