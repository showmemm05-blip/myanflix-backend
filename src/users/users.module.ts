import { Module } from '@nestjs/common';
import { RolesModule } from '../roles/roles.module';
import { MoviesModule } from '../movies/movies.module';
import { VideosModule } from '../videos/videos.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [RolesModule, MoviesModule, VideosModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
