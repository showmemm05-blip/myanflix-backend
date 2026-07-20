import { PartialType } from '@nestjs/mapped-types';
import { IsEnum, IsOptional } from 'class-validator';
import { MovieStatus } from '../../generated/prisma/client';
import { CreateMovieDto } from './create-movie.dto';

export class UpdateMovieDto extends PartialType(CreateMovieDto) {
  @IsOptional()
  @IsEnum(MovieStatus)
  status?: MovieStatus;
}
