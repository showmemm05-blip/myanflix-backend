import {
  ArrayUnique,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ALL_PERMISSIONS } from '../permission-catalogue';

export class CreateAppRoleDto {
  /** Display name. The immutable `key` is derived from it (uppercase snake). */
  @IsString()
  @MinLength(2)
  @MaxLength(48)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;

  /** Optional starting permission set; omitted means "create with none". */
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(ALL_PERMISSIONS, {
    each: true,
    message:
      'each value in permissions must be a known MODULE.ACTION permission',
  })
  permissions?: string[];
}
