import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';
import { MAX_DURATION_MINUTES } from '../../videos/duration.util';

export class CreateUploadPlaceholderDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  /** Set for an episode upload — the placeholder becomes an episode of this series instead of a standalone movie. */
  @IsOptional()
  @IsUUID('4')
  seriesId?: string;

  /**
   * Whole minutes the uploader probed from the bundle (the rendition
   * playlist's EXTINF sum, or a <video> metadata read of original.mp4).
   * Omitted — never 0 — when the probe failed: 0 is the unknown-runtime
   * sentinel the row is born with in that case, and it is rejected here so
   * no client can ever send "measured, zero".
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_DURATION_MINUTES)
  duration?: number;

  // Season/episode numbers only make sense (and are then required) when a
  // seriesId is present — a standalone movie must not carry either.
  @ValidateIf((dto: CreateUploadPlaceholderDto) => dto.seriesId !== undefined)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  seasonNumber?: number;

  @ValidateIf((dto: CreateUploadPlaceholderDto) => dto.seriesId !== undefined)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  episodeNumber?: number;
}
