import { Module } from '@nestjs/common';
import { RolesModule } from '../roles/roles.module';
import { BookCategoriesController } from './book-categories.controller';
import { BookCategoriesService } from './book-categories.service';

@Module({
  imports: [RolesModule],
  controllers: [BookCategoriesController],
  providers: [BookCategoriesService],
  exports: [BookCategoriesService],
})
export class BookCategoriesModule {}
