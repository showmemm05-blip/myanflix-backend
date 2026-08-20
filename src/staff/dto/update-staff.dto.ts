import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { STAFF_ROLES } from './create-staff.dto';

export class UpdateStaffDto {
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(32)
  @Matches(/^[a-zA-Z0-9_.]+$/, {
    message: 'username may only contain letters, numbers, underscores and dots',
  })
  username?: string;

  @IsOptional()
  @IsIn(STAFF_ROLES)
  role?: (typeof STAFF_ROLES)[number];

  /**
   * Granular RBAC role (AppRole.id). Assigning a built-in role also moves the
   * legacy `role` enum to match; assigning a custom role leaves it alone
   * (custom roles are staff-tier by definition).
   */
  @IsOptional()
  @IsUUID()
  appRoleId?: string;
}
