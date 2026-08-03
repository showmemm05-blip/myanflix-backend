import { PartialType } from '@nestjs/mapped-types';
import { IsEnum, IsInt, IsOptional, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { MovieStatus } from '../../generated/prisma/client';
import { CreateMovieDto } from './create-movie.dto';

export class UpdateMovieDto extends PartialType(CreateMovieDto) {
  @IsOptional()
  @IsEnum(MovieStatus)
  status?: MovieStatus;

  // Episode position is editable after upload (a mis-numbered folder name
  // shouldn't be permanent) — but which series an episode belongs to is
  // not: moving content between shows is a delete-and-reupload decision,
  // not a field edit.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  seasonNumber?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  episodeNumber?: number;
}
