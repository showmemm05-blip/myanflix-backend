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
import { Permission } from '../roles/permission.enum';
import { RequirePermissions } from '../roles/decorators/permissions.decorator';
import { PermissionsGuard } from '../roles/guards/permissions.guard';
import { CreateSubtitleDto } from './dto/create-subtitle.dto';
import { UpdateSubtitleDto } from './dto/update-subtitle.dto';
import { SubtitlesService } from './subtitles.service';

const MAX_SUBTITLE_BYTES = 5 * 1024 * 1024; // subtitle files are plain text, always small

@Controller('subtitles')
@UseGuards(PermissionsGuard)
@RequirePermissions(Permission.SUBTITLE_MANAGE)
export class SubtitlesController {
  constructor(private readonly subtitlesService: SubtitlesService) {}

  @Post()
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
  findAllForVideo(@Query('videoId', ParseUUIDPipe) videoId: string) {
    return this.subtitlesService.findAllForVideo(videoId);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSubtitleDto,
  ) {
    return this.subtitlesService.update(id, dto);
  }

  @Patch(':id/set-default')
  setDefault(@Param('id', ParseUUIDPipe) id: string) {
    return this.subtitlesService.setDefault(id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.subtitlesService.remove(id);
  }
}
