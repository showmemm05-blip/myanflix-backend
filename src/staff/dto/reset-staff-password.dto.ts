import { IsString, MaxLength, MinLength } from 'class-validator';

export class ResetStaffPasswordDto {
  @IsString()
  @MinLength(8, { message: 'password must be at least 8 characters' })
  @MaxLength(72)
  newPassword!: string;
}
