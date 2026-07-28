import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class RejectDepositDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}
