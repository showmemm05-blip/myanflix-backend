import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Permission } from '../roles/permission.enum';
import { RequirePermissions } from '../roles/decorators/permissions.decorator';
import { PermissionsGuard } from '../roles/guards/permissions.guard';
import { InitUploadDto } from './dto/init-upload.dto';
import { UploadsService } from './uploads.service';

const MAX_CHUNK_BYTES = 10 * 1024 * 1024; // safety cap, well above the 5 MB default chunk size
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

@Controller('uploads')
@UseGuards(PermissionsGuard)
@RequirePermissions(Permission.VIDEO_UPLOAD)
export class UploadsController {
  constructor(private readonly uploadsService: UploadsService) {}

  @Post('init')
  initUpload(@Body() dto: InitUploadDto) {
    return this.uploadsService.initUpload(dto);
  }

  @Post('image')
  @RequirePermissions(Permission.MOVIE_CREATE)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_IMAGE_BYTES } }))
  async uploadImage(@UploadedFile() file: Express.Multer.File | undefined) {
    if (!file) throw new BadRequestException('No image file received (expected field "file")');
    const url = await this.uploadsService.saveImage(file.originalname, file.buffer);
    return { url };
  }

  @Post(':uploadId/chunk/:chunkNumber')
  @UseInterceptors(FileInterceptor('chunk', { limits: { fileSize: MAX_CHUNK_BYTES } }))
  async uploadChunk(
    @Param('uploadId', ParseUUIDPipe) uploadId: string,
    @Param('chunkNumber', ParseIntPipe) chunkNumber: number,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file) throw new BadRequestException('No chunk file received (expected field "chunk")');

    await this.uploadsService.saveChunk(uploadId, chunkNumber, file.buffer);
    return this.uploadsService.getStatus(uploadId);
  }

  @Get(':uploadId/status')
  getStatus(@Param('uploadId', ParseUUIDPipe) uploadId: string) {
    return this.uploadsService.getStatus(uploadId);
  }

  @Post(':uploadId/complete')
  completeUpload(@Param('uploadId', ParseUUIDPipe) uploadId: string) {
    return this.uploadsService.completeUpload(uploadId);
  }
}
