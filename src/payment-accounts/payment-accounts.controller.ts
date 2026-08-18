import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Permission } from '../roles/permission.enum';
import { RequirePermissions } from '../roles/decorators/permissions.decorator';
import { PermissionsGuard } from '../roles/guards/permissions.guard';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { CreatePaymentAccountDto } from './dto/create-payment-account.dto';
import { UpdatePaymentAccountDto } from './dto/update-payment-account.dto';
import { CreatePaymentMethodTypeDto } from './dto/create-payment-method-type.dto';
import { UpdatePaymentMethodTypeDto } from './dto/update-payment-method-type.dto';
import { CreateManualPaymentAccountTransactionDto } from './dto/create-manual-payment-account-transaction.dto';
import { PaymentAccountTransactionQueryDto } from './dto/payment-account-transaction-query.dto';
import { AllPaymentAccountTransactionsQueryDto } from './dto/all-payment-account-transactions-query.dto';
import { PaymentAccountsService } from './payment-accounts.service';

/**
 * No class-level guard — `findAll`/`findTypes` are readable by any
 * authenticated user (the deposit flow needs to show active accounts to
 * pick from), while the mutating routes need PAYMENT_ACCOUNT_MANAGE (Super
 * Admin only, per role-permissions.map.ts). Same per-route pattern as
 * DepositsController/SubscriptionPlansController.
 */
@Controller('payment-accounts')
export class PaymentAccountsController {
  constructor(
    private readonly paymentAccountsService: PaymentAccountsService,
  ) {}

  @Get()
  findAll(@CurrentUser() user: AuthenticatedUser) {
    return this.paymentAccountsService.findAll(user.role);
  }

  /** Must be registered before `:id` so "types" isn't captured as an id. */
  @Get('types')
  findTypes() {
    return this.paymentAccountsService.getTypes();
  }

  @Post('types')
  @UseGuards(PermissionsGuard)
  @RequirePermissions(Permission.PAYMENT_ACCOUNT_MANAGE)
  createType(@Body() dto: CreatePaymentMethodTypeDto) {
    return this.paymentAccountsService.createType(dto);
  }

  @Patch('types/:id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions(Permission.PAYMENT_ACCOUNT_MANAGE)
  updateType(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePaymentMethodTypeDto,
  ) {
    return this.paymentAccountsService.updateType(id, dto);
  }

  @Delete('types/:id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions(Permission.PAYMENT_ACCOUNT_MANAGE)
  removeType(@Param('id', ParseUUIDPipe) id: string) {
    return this.paymentAccountsService.removeType(id);
  }

  /** Central cross-account transaction view — must be registered before `:id` so "transactions" isn't captured as an id. */
  @Get('transactions')
  @UseGuards(PermissionsGuard)
  @RequirePermissions(Permission.PAYMENT_ACCOUNT_MANAGE)
  findAllTransactions(@Query() query: AllPaymentAccountTransactionsQueryDto) {
    return this.paymentAccountsService.getAllTransactions(query);
  }

  @Get(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions(Permission.PAYMENT_ACCOUNT_MANAGE)
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.paymentAccountsService.findOne(id);
  }

  /** Per-account transaction history. */
  @Get(':id/transactions')
  @UseGuards(PermissionsGuard)
  @RequirePermissions(Permission.PAYMENT_ACCOUNT_MANAGE)
  findTransactions(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: PaymentAccountTransactionQueryDto,
  ) {
    return this.paymentAccountsService.getTransactions(id, query);
  }

  /** Manual Add/Remove Money. */
  @Post(':id/transactions')
  @UseGuards(PermissionsGuard)
  @RequirePermissions(Permission.PAYMENT_ACCOUNT_MANAGE)
  recordTransaction(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateManualPaymentAccountTransactionDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.paymentAccountsService.recordTransaction(id, dto, user.id);
  }

  @Post()
  @UseGuards(PermissionsGuard)
  @RequirePermissions(Permission.PAYMENT_ACCOUNT_MANAGE)
  create(
    @Body() dto: CreatePaymentAccountDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.paymentAccountsService.create(dto, user.id);
  }

  @Patch(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions(Permission.PAYMENT_ACCOUNT_MANAGE)
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePaymentAccountDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.paymentAccountsService.update(id, dto, user.id);
  }

  @Delete(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions(Permission.PAYMENT_ACCOUNT_MANAGE)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.paymentAccountsService.remove(id);
  }
}
