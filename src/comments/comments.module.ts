import { Module } from '@nestjs/common';
import { MinioService } from '../common/storage/minio.service';
import { CommentsController } from './comments.controller';
import { CommentsService } from './comments.service';

/**
 * MinioService has no shared module — it is provided per-module (the pattern
 * VideosModule/SeriesModule established). Needed here to turn a commenter's
 * stored avatar KEY into a per-request URL. PermissionResolverService, used
 * for the moderator branch of delete, comes from the @Global RolesModule.
 */
@Module({
  controllers: [CommentsController],
  providers: [CommentsService, MinioService],
  exports: [CommentsService],
})
export class CommentsModule {}
