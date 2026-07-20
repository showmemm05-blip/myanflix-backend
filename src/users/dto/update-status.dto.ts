import { IsEnum } from 'class-validator';
import { UserStatus } from '../../generated/prisma/client';

export class UpdateStatusDto {
  @IsEnum(UserStatus)
  status!: UserStatus;
}
