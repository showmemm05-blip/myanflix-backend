import {
  IsBoolean,
  IsOptional,
  MaxLength,
  MinLength,
  IsString,
} from 'class-validator';

export class UpdateSubtitleDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(10)
  language?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  label?: string;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}
