import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class RejectWithdrawalDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}
