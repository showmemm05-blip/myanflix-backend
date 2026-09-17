import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { SkipThrottle } from '@nestjs/throttler';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { RequirePermissions } from '../roles/decorators/permissions.decorator';
import { PermissionsGuard } from '../roles/guards/permissions.guard';
import { InitUploadDto } from './dto/init-upload.dto';
import { UploadImageDto } from './dto/upload-image.dto';
import { ValidateExternalBundleDto } from './dto/validate-external-bundle.dto';
import { UploadsService } from './uploads.service';

const MAX_CHUNK_BYTES = 10 * 1024 * 1024; // safety cap, well above the 5 MB default chunk size
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

@Controller('uploads')
@UseGuards(PermissionsGuard)
@RequirePermissions('MEDIA.UPLOAD')
export class UploadsController {
  constructor(private readonly uploadsService: UploadsService) {}

  @Post('init')
  initUpload(@Body() dto: InitUploadDto) {
    return this.uploadsService.initUpload(dto);
  }

  // Serves poster/cover art for movies, series, episodes AND categories, so
  // it rides the class-level MEDIA.UPLOAD rule rather than a movie-specific
  // one (the old MOVIE_CREATE override resolved to the same three roles).
  //
  // `purpose` (a required form field alongside `file`) is what decides the
  // images/<purpose>/ folder the object lands in — see UploadImageDto for
  // why it has no fallback. The response shape `{ url }` is unchanged.
  @Post('image')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_IMAGE_BYTES } }),
  )
  async uploadImage(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: UploadImageDto,
  ) {
    if (!file)
      throw new BadRequestException(
        'No image file received (expected field "file")',
      );
    const url = await this.uploadsService.saveImage(
      dto.purpose,
      file.originalname,
      file.buffer,
    );
    return { url };
  }

  // chunkNumber travels as a form field, not a URL segment — every chunk
  // then hits the exact same URL, so the browser's CORS preflight cache
  // (keyed per-URL) actually applies across the whole upload instead of
  // forcing a fresh OPTIONS round-trip for every single chunk.
  // No response body: the client already knows what it just sent and never
  // reads this response (chunkNumber travels with each chunk, so nothing
  // here needs echoing back). Returning getStatus() used to run a second
  // session lookup plus a readdir+sort of every chunk received so far on
  // EVERY chunk request — pure O(n) waste per chunk that nothing consumed.
  @Post(':uploadId/chunk')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseInterceptors(
    FileInterceptor('chunk', { limits: { fileSize: MAX_CHUNK_BYTES } }),
  )
  async uploadChunk(
    @Param('uploadId', ParseUUIDPipe) uploadId: string,
    @Body('chunkNumber', ParseIntPipe) chunkNumber: number,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<void> {
    if (!file)
      throw new BadRequestException(
        'No chunk file received (expected field "chunk")',
      );

    await this.uploadsService.saveChunk(uploadId, chunkNumber, file.buffer);
  }

  /** Polled by the admin during an upload — never rate limited. */
  @SkipThrottle()
  @Get(':uploadId/status')
  getStatus(@Param('uploadId', ParseUUIDPipe) uploadId: string) {
    return this.uploadsService.getStatus(uploadId);
  }

  @Post(':uploadId/complete')
  completeUpload(
    @Param('uploadId', ParseUUIDPipe) uploadId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.uploadsService.completeUpload(uploadId, user);
  }

  /** Retries transcoding for a movie whose video failed — no re-upload required. */
  @Post(':movieId/reprocess')
  reprocess(
    @Param('movieId', ParseUUIDPipe) movieId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.uploadsService.reprocessVideo(movieId, user);
  }

  /** Cross-checks an externally-pre-transcoded bundle's uploaded files against what's actually in MinIO. */
  @Post(':movieId/validate-external')
  validateExternal(
    @Param('movieId', ParseUUIDPipe) movieId: string,
    @Body() dto: ValidateExternalBundleDto,
  ) {
    return this.uploadsService.validateExternalBundle(movieId, dto);
  }

  /**
   * Runs automatically once the admin's bundle upload finishes — never runs
   * ffmpeg. Moves the movie to READY_TO_PUBLISH (or FAILED if the bundle is
   * incomplete); it never publishes the movie itself.
   *
   * Only a movie that is UPLOADING or FAILED is finalized. A movie already
   * READY_TO_PUBLISH is replayed idempotently (201 with its existing READY
   * video, nothing created; 409 if it has no READY video). Any other status
   * — PUBLISHED, ARCHIVED, DRAFT, PROCESSING — is a 409 with nothing
   * written, so a live title can never be unpublished or failed from here.
   * Parallel calls for the same movie join a single run.
   */
  @Post(':movieId/finalize')
  finalize(
    @Param('movieId', ParseUUIDPipe) movieId: string,
    @Body() dto: ValidateExternalBundleDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.uploadsService.finalizeExternalUpload(movieId, dto, user);
  }
}
