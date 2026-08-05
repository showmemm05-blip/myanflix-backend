import { Type } from 'class-transformer';
import { IsInt, IsString, Matches, Min, MinLength } from 'class-validator';

export class MultipartInitDto {
  @IsString()
  @MinLength(1)
  resourceType!: string;

  @IsString()
  @MinLength(1)
  resourceId!: string;

  @IsString()
  @MinLength(1)
  filename!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  filesize!: number;

  // Unlike the classic chunked flow's InitUploadDto, relativePath is always
  // required here — this whole surface only ever serves the
  // externally-pre-transcoded-style flow, never the ffmpeg one.
  @IsString()
  @MinLength(1)
  @Matches(/^(?!\/)(?!.*\.\.)[\w\-./]+$/, {
    message: 'relativePath must be a relative path with no ".." segments',
  })
  relativePath!: string;
}
