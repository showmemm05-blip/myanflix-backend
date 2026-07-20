import { Type } from 'class-transformer';
import { IsInt, IsString, IsUUID, Min, MinLength } from 'class-validator';

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
}
