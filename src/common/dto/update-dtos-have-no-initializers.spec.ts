import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { UpdateActorDto } from '../../actors/dto/actor.dto';
import { UpdateBookAuthorDto } from '../../book-authors/dto/book-author.dto';
import { UpdateBookCategoryDto } from '../../book-categories/dto/book-category.dto';
import { UpdateBookChapterDto } from '../../books/dto/chapter.dto';
import { UpdateBookPartDto } from '../../books/dto/part.dto';
import { UpdateBookSectionDto } from '../../books/dto/section.dto';
import { UpdateBookDto } from '../../books/dto/update-book.dto';
import { UpdateCategoryDto } from '../../categories/dto/update-category.dto';
import { UpdateLevelDto } from '../../levels/dto/level.dto';
import { UpdateMovieDto } from '../../movies/dto/update-movie.dto';
import { UpdatePaymentAccountDto } from '../../payment-accounts/dto/update-payment-account.dto';
import { UpdatePaymentMethodTypeDto } from '../../payment-accounts/dto/update-payment-method-type.dto';
import { UpdateSeriesDto } from '../../series/dto/update-series.dto';
import { UpdatePlanDto } from '../../subscriptions/dto/update-plan.dto';
import { UpdateSubtitleDto } from '../../subtitles/dto/update-subtitle.dto';

/**
 * Guard for the F-002 pattern: `PartialType(CreateXDto)` copies every
 * class-property initializer of the create DTO into each update instance, and
 * the global ValidationPipe (`transform: true`) builds the DTO with
 * plainToInstance — so a default like `accessType = SUBSCRIPTION` silently
 * lands in every PUT/PATCH body that omits the field. An update DTO must
 * therefore produce NO defined value from an empty body.
 *
 * Assert on defined values, not `Object.keys`: tsconfig targets ES2023, so
 * useDefineForClassFields is on and every declared field becomes an own
 * property holding `undefined` even without an initializer.
 *
 * Query DTOs built on PaginationQueryDto are deliberately absent — `page = 1`
 * and `limit = 20` are wanted on GET and nothing PartialTypes them.
 */
describe('update DTOs carry no class-property initializers', () => {
  it.each([
    ['UpdateActorDto', UpdateActorDto],
    ['UpdateBookAuthorDto', UpdateBookAuthorDto],
    ['UpdateBookCategoryDto', UpdateBookCategoryDto],
    ['UpdateBookChapterDto', UpdateBookChapterDto],
    ['UpdateBookPartDto', UpdateBookPartDto],
    ['UpdateBookSectionDto', UpdateBookSectionDto],
    ['UpdateBookDto', UpdateBookDto],
    ['UpdateCategoryDto', UpdateCategoryDto],
    ['UpdateLevelDto', UpdateLevelDto],
    ['UpdateMovieDto', UpdateMovieDto],
    ['UpdatePaymentAccountDto', UpdatePaymentAccountDto],
    ['UpdatePaymentMethodTypeDto', UpdatePaymentMethodTypeDto],
    ['UpdateSeriesDto', UpdateSeriesDto],
    ['UpdatePlanDto', UpdatePlanDto],
    ['UpdateSubtitleDto', UpdateSubtitleDto],
  ] as const)('%s: an empty body yields no defined field', (_name, Dto) => {
    const instance = plainToInstance(Dto, {}) as Record<string, unknown>;
    const defined = Object.entries(instance).filter(([, v]) => v !== undefined);
    expect(defined).toEqual([]);
  });
});
