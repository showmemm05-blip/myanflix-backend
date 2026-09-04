import { Module } from '@nestjs/common';
import { RolesModule } from '../roles/roles.module';
import { VideosModule } from '../videos/videos.module';
import { BookAuthorsModule } from '../book-authors/book-authors.module';
import { BookProcessingService } from './book-processing.service';
import { BooksController } from './books.controller';
import { BooksService } from './books.service';

/**
 * VideosModule is imported for MinioService/StorageService, which it owns
 * and exports (the same reason MoviesModule imports it) — books share the
 * bucket and the key-builder conventions, not the video pipeline itself.
 * BookAuthorsModule exports BookAuthorsService, which resolves the author a
 * book is credited to on create/update.
 */
@Module({
  imports: [RolesModule, VideosModule, BookAuthorsModule],
  controllers: [BooksController],
  providers: [BooksService, BookProcessingService],
  exports: [BooksService, BookProcessingService],
})
export class BooksModule {}
