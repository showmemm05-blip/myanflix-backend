import { IsInt, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateUploadPlaceholderDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  /** Set for an episode upload — the placeholder becomes an episode of this series instead of a standalone movie. */
  @IsOptional()
  @IsUUID('4')
  seriesId?: string;

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
