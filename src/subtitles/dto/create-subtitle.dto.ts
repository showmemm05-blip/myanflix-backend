import {
  IsBoolean,
  IsOptional,
  IsUUID,
  MaxLength,
  MinLength,
  IsString,
} from 'class-validator';
import { ToBoolean } from '../../common/decorators/to-boolean.decorator';

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

  /**
   * Multipart field — multer delivers it as the string 'true' / 'false', so
   * @ToBoolean reads it properly (the pipe's implicit conversion alone would
   * make Boolean('false') === true). Create-time default is `?? false` in
   * SubtitlesService.create (and Prisma `@default(false)`); no class
   * initializer so a PartialType update DTO could never inherit one.
   */
  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  isDefault?: boolean;
}
