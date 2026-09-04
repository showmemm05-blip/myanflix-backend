import type { BookAuthor } from '../../generated/prisma/client';
import type { ImageUrlResolver } from '../../books/dto/book-response.dto';

type BookAuthorWithBookCount = BookAuthor & { _count: { books: number } };

/** The slice of an author a book carries as `authorRef`. */
export type BookAuthorRefRow = {
  id: string;
  name: string;
  imageUrl: string | null;
};

export function toBookAuthorRef(
  row: BookAuthorRefRow,
  resolveImageUrl: ImageUrlResolver,
) {
  return {
    id: row.id,
    name: row.name,
    imageUrl: resolveImageUrl(row.imageUrl),
  };
}

export class BookAuthorResponseDto {
  static fromEntity(
    author: BookAuthorWithBookCount,
    resolveImageUrl: ImageUrlResolver,
  ) {
    return {
      id: author.id,
      name: author.name,
      imageUrl: resolveImageUrl(author.imageUrl),
      bio: author.bio,
      // Counted from the relation, never stored — a cached number would
      // drift the first time a book was deleted.
      bookCount: author._count.books,
      createdAt: author.createdAt,
      updatedAt: author.updatedAt,
    };
  }
}
