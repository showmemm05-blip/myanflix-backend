import type { BookAuthor } from '../../generated/prisma/client';
import type { ImageUrlResolver } from '../../books/dto/book-response.dto';

type BookAuthorWithBookCount = BookAuthor & { _count: { books: number } };

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
