import { Type } from 'class-transformer';
import {
  IsInt,
  IsNumber,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

/**
 * One position write from a reader. EDITOR books send chapterId alone; PDF
 * books send chapterId AND pageNumber (each chapter is its own converted
 * release, so the page only means something inside its chapter). The service
 * rejects a pageNumber on written editions.
 */
export class UpdateReadingProgressDto {
  @IsOptional()
  @IsUUID('4')
  chapterId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageNumber?: number;

  /**
   * The section the reader was in, when it knows. Optional for every
   * client — a book with no sections never sends it — and validated by the
   * service against the edition (and the chapter, when one is sent).
   */
  @IsOptional()
  @IsUUID('4')
  sectionId?: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  progress!: number;
}
