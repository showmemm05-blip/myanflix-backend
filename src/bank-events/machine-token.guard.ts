import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { tokensMatch } from '../realtime/realtime.gateway';
import {
  MACHINE_PERMISSIONS,
  MACHINE_PERMISSION_KEY,
  type MachinePermission,
  type MachinePrincipal,
} from './machine-permissions';

/**
 * Bearer-token auth for the phone-monitor. Mounted ONLY on
 * BankEventsController (whose class is @Public() so the global JwtAuthGuard
 * steps aside instead of trying to parse the bearer as a JWT); the machine
 * token is therefore accepted nowhere else, and no JWT is accepted here.
 *
 * On success `request.machine` is set and `request.user` is left undefined,
 * so @CurrentUser() and PermissionsGuard can never mistake the machine for
 * a person.
 */
@Injectable()
export class MachineTokenGuard implements CanActivate {
  constructor(
    private readonly configService: ConfigService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.configService.get<string>('BANK_EVENTS_TOKEN');
    if (!expected) {
      throw new ServiceUnavailableException(
        'Bank event ingestion is not configured',
      );
    }

    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      machine?: MachinePrincipal;
    }>();
    const header = request.headers.authorization;
    const presented =
      typeof header === 'string' && header.startsWith('Bearer ')
        ? header.slice('Bearer '.length).trim()
        : '';
    if (!presented || !tokensMatch(presented, expected)) {
      throw new UnauthorizedException('Invalid machine token');
    }

    const principal: MachinePrincipal = {
      kind: 'phone-monitor',
      permissions: MACHINE_PERMISSIONS,
    };
    const required = this.reflector.getAllAndOverride<
      MachinePermission | undefined
    >(MACHINE_PERMISSION_KEY, [context.getHandler(), context.getClass()]);
    if (required && !principal.permissions.includes(required)) {
      throw new ForbiddenException(
        'The machine token does not carry this permission',
      );
    }

    request.machine = principal;
    return true;
  }
}
