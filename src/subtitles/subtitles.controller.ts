import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { RequirePermissions } from '../roles/decorators/permissions.decorator';
import { PermissionsGuard } from '../roles/guards/permissions.guard';
import { CreateSubtitleDto } from './dto/create-subtitle.dto';
import { UpdateSubtitleDto } from './dto/update-subtitle.dto';
import { SubtitlesService } from './subtitles.service';

const MAX_SUBTITLE_BYTES = 5 * 1024 * 1024; // subtitle files are plain text, always small

/**
 * Subtitles are MEDIA assets, so each route carries the specific MEDIA action
 * it performs instead of the old single SUBTITLE_MANAGE bundle. The catalogue
 * has no MEDIA.EDIT, so metadata edits sit on MEDIA.UPLOAD — the same
 * permission that created the track.
 */
@Controller('subtitles')
@UseGuards(PermissionsGuard)
@RequirePermissions('MEDIA.UPLOAD')
export class SubtitlesController {
  constructor(private readonly subtitlesService: SubtitlesService) {}

  @Post()
  @RequirePermissions('MEDIA.UPLOAD')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_SUBTITLE_BYTES } }),
  )
  create(
    @Body() dto: CreateSubtitleDto,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file)
      throw new BadRequestException(
        'No subtitle file received (expected field "file")',
      );
    return this.subtitlesService.create(dto, file.originalname, file.buffer);
  }

  @Get()
  @RequirePermissions('MEDIA.VIEW')
  findAllForVideo(@Query('videoId', ParseUUIDPipe) videoId: string) {
    return this.subtitlesService.findAllForVideo(videoId);
  }

  @Patch(':id')
  @RequirePermissions('MEDIA.UPLOAD')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSubtitleDto,
  ) {
    return this.subtitlesService.update(id, dto);
  }

  @Patch(':id/set-default')
  @RequirePermissions('MEDIA.UPLOAD')
  setDefault(@Param('id', ParseUUIDPipe) id: string) {
    return this.subtitlesService.setDefault(id);
  }

  @Delete(':id')
  @RequirePermissions('MEDIA.DELETE')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.subtitlesService.remove(id);
  }
}
