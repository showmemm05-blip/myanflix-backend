import { IsEnum } from 'class-validator';
import { Role } from '../../generated/prisma/client';

export class UpdateRoleDto {
  @IsEnum(Role)
  role!: Role;
}
