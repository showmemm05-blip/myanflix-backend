import { IsIn } from 'class-validator';
import { UserStatus } from '../../generated/prisma/client';

export class UpdateStaffStatusDto {
  @IsIn([UserStatus.ACTIVE, UserStatus.SUSPENDED])
  status!: UserStatus;
}
