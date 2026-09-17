import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { RequirePermissions } from '../roles/decorators/permissions.decorator';
import { PermissionsGuard } from '../roles/guards/permissions.guard';
import { getAuditCatalogue } from './audit-actions';
import { AuditService } from './audit.service';
import { AuditQueryDto } from './dto/audit-query.dto';

/**
 * Read side of the staff audit log. Every route needs AUDIT.VIEW, which no
 * seeded role other than the protected SUPER_ADMIN holds — and holding it
 * means seeing staff IPs and user agents raw, so grant it deliberately.
 */
@Controller('audit')
@UseGuards(PermissionsGuard)
@RequirePermissions('AUDIT.VIEW')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  findAll(@Query() query: AuditQueryDto) {
    return this.auditService.findAll(query);
  }

  /** Registered before ':id' so "catalogue" is never parsed as an entry id. */
  @Get('catalogue')
  getCatalogue() {
    return getAuditCatalogue();
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.auditService.findOne(id);
  }
}
