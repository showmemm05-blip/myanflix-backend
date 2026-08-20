import { ArrayUnique, IsArray, IsIn } from 'class-validator';
import { ALL_PERMISSIONS } from '../permission-catalogue';

/** The matrix save: the full desired permission set, not a delta. */
export class ReplaceRolePermissionsDto {
  @IsArray()
  @ArrayUnique()
  @IsIn(ALL_PERMISSIONS, {
    each: true,
    message:
      'each value in permissions must be a known MODULE.ACTION permission',
  })
  permissions!: string[];
}
