import { IsBoolean, IsOptional, IsUUID, MaxLength, MinLength, IsString } from 'class-validator';

export class CreateSubtitleDto {
  @IsUUID('4')
  videoId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(10)
  language!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  label!: string;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean = false;
}
