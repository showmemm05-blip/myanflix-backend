import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { RequirePermissions } from '../roles/decorators/permissions.decorator';
import { PermissionsGuard } from '../roles/guards/permissions.guard';
import { XLSX_MIME_TYPE } from './dream-sheet';
import {
  AdminDreamQueryDto,
  ExportDreamsQueryDto,
  ImportDreamsQueryDto,
  UpdateLotteryDreamDto,
} from './dto/lottery-dream.dto';
import { LotteryDreamsService } from './lottery-dreams.service';

/** A dream book as a spreadsheet is well under 200 KB; this is room to spare. */
const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

/**
 * The admin "Lottery > Dreams" page. LOTTERY.VIEW reads (the list and the
 * export), LOTTERY.DREAMS_MANAGE changes (an edit, an import); every
 * change is audited by the service. Pictures go through the existing
 * POST /uploads/image with purpose "lottery". 'export' is a GET and ':id'
 * a PATCH, so the two never compete for a request.
 */
@Controller('lottery/admin/dreams')
@UseGuards(PermissionsGuard)
export class LotteryDreamsAdminController {
  constructor(private readonly dreams: LotteryDreamsService) {}

  @Get()
  @RequirePermissions('LOTTERY.VIEW')
  list(@Query() query: AdminDreamQueryDto) {
    return this.dreams.listAdmin(query);
  }

  /** Every row of one book as an .xlsx download — the import template, pre-filled. */
  @Get('export')
  @RequirePermissions('LOTTERY.VIEW')
  async export(@Query() query: ExportDreamsQueryDto) {
    const file = await this.dreams.export(query.book);
    return new StreamableFile(file, {
      type: XLSX_MIME_TYPE,
      disposition: `attachment; filename="dreams-${query.book}.xlsx"`,
      length: file.length,
    });
  }

  @Patch(':id')
  @RequirePermissions('LOTTERY.DREAMS_MANAGE')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLotteryDreamDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.dreams.update(id, dto, actor);
  }

  /**
   * Multipart field `file`: an .xlsx or a UTF-8 .csv with a header row of
   * book, number, name_en, name_my. `?dryRun=true` previews the counts and
   * writes nothing.
   */
  @Post('import')
  @RequirePermissions('LOTTERY.DREAMS_MANAGE')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_IMPORT_BYTES } }),
  )
  import(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Query() query: ImportDreamsQueryDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    if (!file) {
      throw new BadRequestException(
        'No spreadsheet received (expected field "file")',
      );
    }
    return this.dreams.import(
      file.buffer,
      file.originalname,
      query.dryRun ?? false,
      actor,
    );
  }
}
