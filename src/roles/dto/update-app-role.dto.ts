import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** Rename / re-describe only — `key`, `isSystem` and `isProtected` are immutable. */
export class UpdateAppRoleDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(48)
  name?: string;

  /** Empty string clears the description. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;
}
