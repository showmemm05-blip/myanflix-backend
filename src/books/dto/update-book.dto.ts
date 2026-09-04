import { OmitType, PartialType } from '@nestjs/mapped-types';
import { CreateBookDto } from './create-book.dto';

/**
 * `type` is not editable (see CreateBookDto.type), and neither `language`
 * nor `status` belongs here any more: both are per-edition, and move through
 * PUT /books/:id/editions/:editionId.
 */
export class UpdateBookDto extends PartialType(
  OmitType(CreateBookDto, ['type', 'language'] as const),
) {}
