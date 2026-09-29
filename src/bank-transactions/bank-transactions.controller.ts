import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { RequirePermissions } from '../roles/decorators/permissions.decorator';
import { PermissionsGuard } from '../roles/guards/permissions.guard';
import { BankTransactionsService } from './bank-transactions.service';
import { BankTransactionQueryDto } from './dto/bank-transaction-query.dto';

/**
 * The staff read side of the phone-monitor's stored notifications. Every
 * route is a JWT + permission route (the phone itself only ever reaches
 * /bank-events with its machine token). VIEW gates the list, the devices
 * and the detail; the screenshot stream is behind its own BANK_EVIDENCE
 * because the image shows the business account balance.
 */
@Controller('bank-transactions')
@UseGuards(PermissionsGuard)
export class BankTransactionsController {
  constructor(
    private readonly bankTransactionsService: BankTransactionsService,
  ) {}

  @Get()
  @RequirePermissions('BANK_TRANSACTIONS.VIEW')
  findAll(@Query() query: BankTransactionQueryDto) {
    return this.bankTransactionsService.findAll(query);
  }

  /** Registered before ':id' so "devices" is never parsed as a row id. */
  @Get('devices')
  @RequirePermissions('BANK_TRANSACTIONS.VIEW')
  devices() {
    return this.bankTransactionsService.listDevices();
  }

  @Get(':id')
  @RequirePermissions('BANK_TRANSACTIONS.VIEW')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.bankTransactionsService.findOne(id);
  }

  /**
   * Streamed inline and marked no-store so no proxy or browser cache ever
   * keeps a copy — the same shape as GET /deposits/:id/bank-screenshot.
   */
  @Get(':id/screenshot')
  @RequirePermissions('BANK_TRANSACTIONS.BANK_EVIDENCE')
  async screenshot(
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader('Cache-Control', 'private, no-store');
    return this.bankTransactionsService.getScreenshot(id);
  }
}
