import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../roles/decorators/permissions.decorator';
import { PermissionsGuard } from '../roles/guards/permissions.guard';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { CreateDepositDto } from './dto/create-deposit.dto';
import { CreateManualDepositDto } from './dto/create-manual-deposit.dto';
import { ApproveDepositDto } from './dto/approve-deposit.dto';
import { RejectDepositDto } from './dto/reject-deposit.dto';
import { DepositQueryDto } from './dto/deposit-query.dto';
import { UpdateReceivingAccountDto } from './dto/update-receiving-account.dto';
import { DepositsService } from './deposits.service';

/**
 * No class-level guard here — `create`/`findMine` are self-service (any
 * authenticated role, ownership-scoped by @CurrentUser()), while the admin
 * routes below need DEPOSIT_MANAGE. Applying the permission per-route
 * (rather than at the class level with an override on the self routes)
 * keeps the "which routes actually need it" obvious at a glance.
 */
@Controller('deposits')
export class DepositsController {
  constructor(private readonly depositsService: DepositsService) {}

  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateDepositDto,
  ) {
    return this.depositsService.create(user.id, dto);
  }

  @Get('me')
  findMine(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: DepositQueryDto,
  ) {
    return this.depositsService.findAllForUser(user.id, query);
  }

  @Get()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('DEPOSITS.VIEW')
  findAll(@Query() query: DepositQueryDto) {
    return this.depositsService.findAllAdmin(query);
  }

  @Post('manual')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('DEPOSITS.CREATE')
  createManual(
    @Body() dto: CreateManualDepositDto,
    @CurrentUser() admin: AuthenticatedUser,
  ) {
    return this.depositsService.createManual(dto, admin);
  }

  @Patch(':id/approve')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('DEPOSITS.APPROVE')
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveDepositDto,
    @CurrentUser() admin: AuthenticatedUser,
  ) {
    return this.depositsService.approve(id, admin, dto);
  }

  @Patch(':id/reject')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('DEPOSITS.REJECT')
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: RejectDepositDto,
  ) {
    return this.depositsService.reject(id, admin, dto);
  }

  @Patch(':id/receiving-account')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('DEPOSITS.EDIT')
  updateReceivingAccount(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateReceivingAccountDto,
    @CurrentUser() admin: AuthenticatedUser,
  ) {
    return this.depositsService.updateReceivingAccount(id, dto, admin);
  }
}
