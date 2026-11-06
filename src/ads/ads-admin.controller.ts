import {
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
  Put,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../roles/decorators/permissions.decorator';
import { PermissionsGuard } from '../roles/guards/permissions.guard';
import { AdAnalyticsService } from './ad-analytics.service';
import {
  AD_IMAGE_UPLOAD_LIMIT_BYTES,
  AdImageService,
} from './ad-image.service';
import { AdSettingsService } from './ad-settings.service';
import { AdVideoService } from './ad-video.service';
import { AdsAdminService } from './ads-admin.service';
import { AdAnalyticsQueryDto } from './dto/ad-analytics.dto';
import { UpdateAdSettingsDto } from './dto/ad-settings.dto';
import {
  AdminAdQueryDto,
  AttachAdVideoDto,
  CreateAdvertisementDto,
  UpdateAdvertisementDto,
} from './dto/advertisement.dto';

/**
 * The admin "Advertisements" page. ADS.VIEW reads (the list, one ad, the
 * analytics), ADS.MANAGE changes (create, edit, attach the video or the
 * corner picture, delete); every change is audited by the services. The
 * video bytes go through the EXISTING presign-batch / multipart routes with
 * resourceType "ad", then `:id/video/attach` checks and moves the file; a
 * corner picture (≤ 3 MB) comes straight in on `:id/image` — the permission
 * guard runs before the upload interceptor, so nobody without ADS.MANAGE
 * gets a file buffered. The static `settings` and
 * `analytics/*` paths are declared before `:id` so ParseUUIDPipe never sees
 * them.
 */
@Controller('ads/admin')
@UseGuards(PermissionsGuard)
export class AdsAdminController {
  constructor(
    private readonly ads: AdsAdminService,
    private readonly video: AdVideoService,
    private readonly image: AdImageService,
    private readonly analytics: AdAnalyticsService,
    private readonly settings: AdSettingsService,
  ) {}

  /** The playback rules (today: minutes before the same title shows an ad again). */
  @Get('settings')
  @RequirePermissions('ADS.VIEW')
  getSettings() {
    return this.settings.get();
  }

  @Put('settings')
  @RequirePermissions('ADS.MANAGE')
  updateSettings(
    @Body() dto: UpdateAdSettingsDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.settings.update(dto, actor);
  }

  @Get('analytics/overview')
  @RequirePermissions('ADS.VIEW')
  overview(@Query() query: AdAnalyticsQueryDto) {
    return this.analytics.overview(query);
  }

  @Get('analytics/ads')
  @RequirePermissions('ADS.VIEW')
  perAd(@Query() query: AdAnalyticsQueryDto) {
    return this.analytics.ads(query);
  }

  @Get('analytics/by-date')
  @RequirePermissions('ADS.VIEW')
  byDate(@Query() query: AdAnalyticsQueryDto) {
    return this.analytics.byDate(query);
  }

  @Get()
  @RequirePermissions('ADS.VIEW')
  list(@Query() query: AdminAdQueryDto) {
    return this.ads.list(query);
  }

  @Post()
  @RequirePermissions('ADS.MANAGE')
  create(
    @Body() dto: CreateAdvertisementDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.ads.create(dto, actor);
  }

  @Get(':id')
  @RequirePermissions('ADS.VIEW')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.ads.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions('ADS.MANAGE')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAdvertisementDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.ads.update(id, dto, actor);
  }

  /** The staged upload becomes the ad's video; answers with the ad as the list shows it. */
  @Post(':id/video/attach')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('ADS.MANAGE')
  async attachVideo(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AttachAdVideoDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    await this.video.attach(id, dto, actor);
    return this.ads.findOne(id);
  }

  /** A corner ad's picture (multipart field "file"); answers with the ad as the list shows it. */
  @Post(':id/image')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('ADS.MANAGE')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: AD_IMAGE_UPLOAD_LIMIT_BYTES, files: 1 },
    }),
  )
  attachImage(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.image.attach(id, file, actor);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('ADS.MANAGE')
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    await this.ads.remove(id, actor);
  }
}
