import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Min,
  MinLength,
} from 'class-validator';

export class InitUploadDto {
  @IsString()
  @MinLength(1)
  filename!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  filesize!: number;

  @IsUUID('4')
  movieId!: string;

  /**
   * Only set for the externally-pre-transcoded upload flow — where this
   * file lands under `videos/<movieId>/` (e.g. "original.mp4",
   * "hls/720p/index.m3u8", "hls/720p/segment_000.ts"). No ".." or leading
   * "/" — this becomes part of a real storage key, not a query the user
   * types in, but a client bug or a tampered request could still supply a
   * path that escapes the movie's own folder.
   */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @Matches(/^(?!\/)(?!.*\.\.)[\w\-./]+$/, {
    message: 'relativePath must be a relative path with no ".." segments',
  })
  relativePath?: string;
}
