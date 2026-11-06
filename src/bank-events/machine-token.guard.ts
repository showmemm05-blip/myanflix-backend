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
  BankEventsDeviceBindingService,
  DEVICE_SERIAL_REJECTED,
  DEVICE_SERIAL_REQUIRED,
  isDeviceSerial,
} from './bank-events-device-binding.service';
import {
  MACHINE_PERMISSIONS,
  MACHINE_PERMISSION_KEY,
  type MachinePermission,
  type MachinePrincipal,
} from './machine-permissions';

/** The header carrying the phone-monitor's stable serial (SEC-004). */
export const BANK_EVENTS_DEVICE_SERIAL_HEADER = 'x-device-serial';

type Headers = Record<string, string | string[] | undefined>;

/** The X-Device-Serial value, trimmed; null when missing or malformed. */
export function deviceSerialOf(headers: Headers | undefined): string | null {
  const raw = headers?.[BANK_EVENTS_DEVICE_SERIAL_HEADER];
  return isDeviceSerial(raw) ? raw.trim() : null;
}

/**
 * Bearer-token auth for the phone-monitor. Mounted ONLY on
 * BankEventsController (whose class is @Public() so the global JwtAuthGuard
 * steps aside instead of trying to parse the bearer as a JWT); the machine
 * token is therefore accepted nowhere else, and no JWT is accepted here.
 *
 * Then the token is bound to ONE monitor (SEC-004 / DB-015, the same
 * pattern as the SMS phone's DeviceTokenGuard): every request must carry
 * `X-Device-Serial`, the first serial that presents the right token is
 * pinned, and every other serial is refused with 401 — after the token
 * check, so a wrong token never pins anything and is never recorded as a
 * rejected device. A monitor build that sends no serial gets a clear 401
 * DEVICE_SERIAL_REQUIRED (the owner updates the monitor on the PC); a
 * second monitor gets 401 DEVICE_SERIAL_REJECTED and an audit row
 * (BankEventsDeviceBindingService).
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
    private readonly binding: BankEventsDeviceBindingService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const expected = this.configService.get<string>('BANK_EVENTS_TOKEN');
    if (!expected) {
      throw new ServiceUnavailableException(
        'Bank event ingestion is not configured',
      );
    }

    const request = context.switchToHttp().getRequest<{
      headers: Headers;
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

    const deviceSerial = deviceSerialOf(request.headers);
    if (deviceSerial === null) {
      throw new UnauthorizedException(DEVICE_SERIAL_REQUIRED);
    }
    if (!(await this.binding.admit(deviceSerial))) {
      throw new UnauthorizedException(DEVICE_SERIAL_REJECTED);
    }

    const principal: MachinePrincipal = {
      kind: 'phone-monitor',
      deviceSerial,
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
