import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import type { App } from 'supertest/types';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  Role,
  TransactionType,
  UserStatus,
} from '../src/generated/prisma/client';
import { MONEY_RECORDS_DELETE_MESSAGE } from '../src/users/user-money-records';

/**
 * H-22 against a real database: DELETE /staff/:id never removes money
 * records. An account with any money row answers 409 (suspend instead) and
 * keeps everything; an account with only its empty sign-up wallet is
 * deleted, wallet row included.
 */
describe('DELETE /staff/:id keeps money records (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let configService: ConfigService;

  let superAdminId: string;
  let superAdminToken: string;
  const createdIds: string[] = [];

  async function signToken(id: string): Promise<string> {
    return jwtService.signAsync(
      { sub: id },
      { secret: configService.get<string>('JWT_SECRET'), expiresIn: '15m' },
    );
  }

  async function makeStaff(tag: string) {
    const staff = await prisma.user.create({
      data: {
        username: `${tag}_${randomUUID().slice(0, 8)}`,
        password: 'unused-in-these-tests',
        role: Role.CONTENT_UPLOADER,
        status: UserStatus.ACTIVE,
      },
    });
    await prisma.wallet.create({ data: { userId: staff.id, balance: 0 } });
    createdIds.push(staff.id);
    return staff;
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    // Pipe/filter/interceptor are registered globally by AppModule — see
    // deposits.e2e-spec.ts; do not re-register them.
    app.setGlobalPrefix('api');
    await app.init();

    prisma = app.get(PrismaService);
    jwtService = app.get(JwtService);
    configService = app.get(ConfigService);

    const superAdmin = await prisma.user.create({
      data: {
        username: `staffdel_super_${randomUUID().slice(0, 8)}`,
        password: 'unused-in-these-tests',
        role: Role.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
      },
    });
    superAdminId = superAdmin.id;
    createdIds.push(superAdmin.id);
    superAdminToken = await signToken(superAdmin.id);
  });

  afterAll(async () => {
    // Isolated test database — money rows first, they no longer cascade.
    await prisma.auditLog.deleteMany({ where: { actorId: superAdminId } });
    await prisma.transaction.deleteMany({
      where: { userId: { in: createdIds } },
    });
    await prisma.wallet.deleteMany({ where: { userId: { in: createdIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdIds } } });
    await app.close();
  });

  it('an account with a wallet ledger row: 409 "suspend instead", nothing removed', async () => {
    const staff = await makeStaff('staffdel_money');
    await prisma.transaction.create({
      data: { userId: staff.id, type: TransactionType.DEPOSIT, amount: 1000 },
    });

    const res = await request(app.getHttpServer())
      .delete(`/api/staff/${staff.id}`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .expect(409);

    expect((res.body as { message: string }).message).toBe(
      MONEY_RECORDS_DELETE_MESSAGE,
    );
    expect(await prisma.user.count({ where: { id: staff.id } })).toBe(1);
    expect(await prisma.wallet.count({ where: { userId: staff.id } })).toBe(1);
    expect(
      await prisma.transaction.count({ where: { userId: staff.id } }),
    ).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: { action: 'staff.delete', targetId: staff.id },
      }),
    ).toBe(0);
  });

  it('an account with only its empty wallet: deleted, wallet row included, audited', async () => {
    const staff = await makeStaff('staffdel_empty');

    await request(app.getHttpServer())
      .delete(`/api/staff/${staff.id}`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .expect(200);

    expect(await prisma.user.count({ where: { id: staff.id } })).toBe(0);
    expect(await prisma.wallet.count({ where: { userId: staff.id } })).toBe(0);
    expect(
      await prisma.auditLog.count({
        where: { action: 'staff.delete', targetId: staff.id },
      }),
    ).toBe(1);
  });
});
