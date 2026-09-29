import { Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * GET /deposits/manual/users (H-15) — the manual-deposit picker's search.
 * A term is required (trimmed, so whitespace alone is a 400): the picker
 * looks a customer up, it never lists them. Matched like the Users page
 * search — username, display name, phone.
 */
export class ManualDepositUserLookupDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  search!: string;

  /** A picker shows a handful of matches, never a page of the user base. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  limit?: number;
}
