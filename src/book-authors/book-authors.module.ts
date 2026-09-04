import { Module } from '@nestjs/common';
import { RolesModule } from '../roles/roles.module';
import { VideosModule } from '../videos/videos.module';
import { BookAuthorsController } from './book-authors.controller';
import { BookAuthorsService } from './book-authors.service';

/**
 * VideosModule is imported for MinioService, which it owns and exports — the
 * same reason ActorsModule imports it. Authors need it only to clean up a
 * portrait when one is replaced or its row deleted.
 */
@Module({
  imports: [RolesModule, VideosModule],
  controllers: [BookAuthorsController],
  providers: [BookAuthorsService],
  exports: [BookAuthorsService],
})
export class BookAuthorsModule {}
