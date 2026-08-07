import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { Permission } from '../roles/permission.enum';
import { RequirePermissions } from '../roles/decorators/permissions.decorator';
import { PermissionsGuard } from '../roles/guards/permissions.guard';
import { CreatePlanDto } from './dto/create-plan.dto';
import { UpdatePlanDto } from './dto/update-plan.dto';
import { SubscriptionsService } from './subscriptions.service';

@Controller('subscription-plans')
export class SubscriptionPlansController {
  constructor(private readonly subscriptionsService: SubscriptionsService) {}

  @Get()
  findAll(@CurrentUser() user: AuthenticatedUser) {
    return this.subscriptionsService.findAllPlans(user.role);
  }

  @Post()
  @UseGuards(PermissionsGuard)
  @RequirePermissions(Permission.SUBSCRIPTION_MANAGE)
  create(@Body() dto: CreatePlanDto) {
    return this.subscriptionsService.createPlan(dto);
  }

  @Put(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions(Permission.SUBSCRIPTION_MANAGE)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePlanDto) {
    return this.subscriptionsService.updatePlan(id, dto);
  }
}
