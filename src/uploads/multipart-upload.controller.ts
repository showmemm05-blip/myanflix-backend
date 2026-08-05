import { Body, Controller, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { MultipartCompleteDto } from './dto/multipart-complete.dto';
import { MultipartInitDto } from './dto/multipart-init.dto';
import { MultipartGetPartUrlsDto } from './dto/multipart-parts.dto';
import { PresignBatchDto } from './dto/presign-batch.dto';
import { MultipartUploadService } from './multipart-upload.service';

/**
 * Direct browser->MinIO upload surface — purely additive alongside
 * UploadsController's backend-relayed chunked-upload endpoints, which stay
 * completely unmodified (see the classic ffmpeg flow it still serves).
 * Permission checks happen inside MultipartUploadService, keyed off each
 * request's `resourceType` (or, for session-scoped routes, the session's
 * own stored resourceType) rather than a single class-level
 * @RequirePermissions — the permission a caller needs depends on which
 * resource type they're uploading, which isn't known at decoration time.
 */
@Controller('uploads')
export class MultipartUploadController {
  constructor(
    private readonly multipartUploadService: MultipartUploadService,
  ) {}

  /** Small files (playlists, subtitles, segments) — one presigned PUT URL per file, no server-side session. */
  @Post('presign-batch')
  presignBatch(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: PresignBatchDto,
  ) {
    return this.multipartUploadService.presignBatch(user.role, dto);
  }

  @Post('multipart/init')
  initMultipart(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: MultipartInitDto,
  ) {
    return this.multipartUploadService.initMultipart(user.role, dto);
  }

  @Post('multipart/:sessionId/parts')
  getPartUrls(
    @CurrentUser() user: AuthenticatedUser,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body() dto: MultipartGetPartUrlsDto,
  ) {
    return this.multipartUploadService.getPartUrls(
      user.role,
      sessionId,
      dto.partNumbers,
    );
  }

  @Post('multipart/:sessionId/complete')
  completeMultipart(
    @CurrentUser() user: AuthenticatedUser,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body() dto: MultipartCompleteDto,
  ) {
    return this.multipartUploadService.completeMultipart(
      user.role,
      sessionId,
      dto.parts,
    );
  }

  @Post('multipart/:sessionId/abort')
  abortMultipart(
    @CurrentUser() user: AuthenticatedUser,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
  ) {
    return this.multipartUploadService.abortMultipart(user.role, sessionId);
  }
}
