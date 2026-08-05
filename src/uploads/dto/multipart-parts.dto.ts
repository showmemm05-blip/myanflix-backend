import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  Min,
} from 'class-validator';

export class MultipartGetPartUrlsDto {
  // Generous over the frontend's sliding-window batch size (~2x its part
  // concurrency) — a backstop against a pathological request, not a tuned limit.
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(64)
  @IsInt({ each: true })
  @Min(1, { each: true })
  partNumbers!: number[];
}
