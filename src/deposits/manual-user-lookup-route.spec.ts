import { Test, TestingModule } from '@nestjs/testing';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  Injectable,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import request from 'supertest';
import type { App } from 'supertest/types';
import { Role } from '../generated/prisma/client';
import { PermissionResolverService } from '../roles/permission-resolver.service';
import { createSeededPermissionResolver } from '../../test/seeded-permission-resolver';
import { DepositsController } from './deposits.controller';
import { DepositsService } from './deposits.service';

/** `x-test-role` picks the seeded system role; absent = 401. */
@Injectable()
class FakeJwtAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      user?: Record<string, unknown>;
    }>();
    const role = req.headers['x-test-role'];
    if (!role) throw new UnauthorizedException();
    req.user = { id: 'staff-1', username: 'staff', role, appRoleId: null };
    return true;
  }
}

/**
 * H-15: the manual-deposit picker used GET /users (USERS.VIEW), which the
 * seeded Admin role does not hold — the search 403'd, the dialog showed "no
 * users match" and the deposit could never be recorded. Its own lookup runs
 * on DEPOSITS.CREATE, the permission the deposit itself needs.
 */
describe('GET /deposits/manual/users', () => {
  let app: INestApplication<App>;
  let lookup: jest.Mock;
  let findOne: jest.Mock;

  beforeEach(async () => {
    lookup = jest.fn().mockResolvedValue({ items: [] });
    findOne = jest.fn();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [DepositsController],
      providers: [
        {
          provide: DepositsService,
          useValue: {
            lookupUsersForManualDeposit: lookup,
            findOneAdmin: findOne,
          },
        },
        {
          provide: PermissionResolverService,
          useValue: createSeededPermissionResolver(),
        },
        { provide: APP_GUARD, useClass: FakeJwtAuthGuard },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    // The same pipe options as the global one in app.module.ts.
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('answers the seeded Admin (DEPOSITS.CREATE, no USERS.VIEW)', async () => {
    await request(app.getHttpServer())
      .get('/deposits/manual/users')
      .query({ search: 'ko', limit: 5 })
      .set('x-test-role', Role.ADMIN)
      .expect(200);

    expect(findOne).not.toHaveBeenCalled();
    expect(lookup).toHaveBeenCalledWith({ search: 'ko', limit: 5 });
  });

  it('refuses a role without DEPOSITS.CREATE', async () => {
    await request(app.getHttpServer())
      .get('/deposits/manual/users')
      .query({ search: 'ko' })
      .set('x-test-role', Role.CONTENT_UPLOADER)
      .expect(403);
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([
    ['no search', {}],
    ['a blank search', { search: '   ' }],
    ['an over-long search', { search: 'x'.repeat(101) }],
    ['a limit over 20', { search: 'ko', limit: 21 }],
  ])('rejects %s with 400', async (_label, query) => {
    await request(app.getHttpServer())
      .get('/deposits/manual/users')
      .query(query)
      .set('x-test-role', Role.ADMIN)
      .expect(400);
    expect(lookup).not.toHaveBeenCalled();
  });
});
