import {
  IsBoolean,
  IsOptional,
  MaxLength,
  MinLength,
  IsString,
} from 'class-validator';
import { ToBoolean } from '../../common/decorators/to-boolean.decorator';

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

  /** Same string-to-boolean reading as CreateSubtitleDto (PATCH may send "false"). */
  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  isDefault?: boolean;
}
