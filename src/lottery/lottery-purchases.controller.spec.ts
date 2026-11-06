import { Test, TestingModule } from '@nestjs/testing';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  Injectable,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import request from 'supertest';
import type { App } from 'supertest/types';
import { Role } from '../generated/prisma/client';
import { IS_AUTH_OPTIONAL_KEY } from '../common/decorators/optional-auth.decorator';
import { LotteryPurchasesController } from './lottery-purchases.controller';
import { LotteryPurchasesService } from './lottery-purchases.service';
import { LotteryTicketsController } from './lottery-tickets.controller';
import { LotteryTicketsService } from './lottery-tickets.service';

/**
 * Stands in for the global JwtAuthGuard (the same stand-in as the draws
 * controller spec): `x-test-role` supplies a role; absent = no token =
 * 401, except on an @OptionalAuth route — and none of these routes is
 * one, which is half of what this spec proves.
 */
@Injectable()
class FakeJwtAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      user?: Record<string, unknown>;
    }>();
    const role = req.headers['x-test-role'];
    if (!role) {
      const optional = this.reflector.getAllAndOverride<boolean>(
        IS_AUTH_OPTIONAL_KEY,
        [context.getHandler(), context.getClass()],
      );
      if (optional) return true;
      throw new UnauthorizedException();
    }
    req.user = { id: 'user-1', username: 'user_959', role, appRoleId: null };
    return true;
  }
}

const KEY = '7f3b4d4e-1111-4c2a-9a9a-0123456789ab';

const BASKET = {
  drawNo: 24,
  idempotencyKey: KEY,
  lines: [
    { number: '123456', quantity: 2 },
    { number: '000777', quantity: 3 },
  ],
};

/** Every customer route, with a request that passes validation. */
const ROUTES: Array<{
  method: 'get' | 'post';
  path: string;
  body?: Record<string, unknown>;
}> = [
  { method: 'post', path: '/lottery/purchases', body: BASKET },
  { method: 'get', path: '/lottery/purchases' },
  { method: 'get', path: '/lottery/purchases/LP-261020-0042' },
  { method: 'get', path: '/lottery/tickets' },
  { method: 'get', path: '/lottery/tickets/MFL-24-000468' },
];

describe('LotteryPurchases / LotteryTickets controllers', () => {
  let app: INestApplication<App>;
  let purchases: Record<'create' | 'list' | 'findOne', jest.Mock>;
  let tickets: Record<'list' | 'findOne', jest.Mock>;

  beforeAll(async () => {
    const page = { items: [], total: 0, page: 1, pageSize: 20 };
    const receipt = { ref: 'LP-261020-0042', drawNo: 24, balanceAfter: 7000 };
    purchases = {
      create: jest.fn().mockResolvedValue(receipt),
      list: jest.fn().mockResolvedValue(page),
      findOne: jest.fn().mockResolvedValue(receipt),
    };
    tickets = {
      list: jest.fn().mockResolvedValue(page),
      findOne: jest.fn().mockResolvedValue({ ticketNo: 'MFL-24-000468' }),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [LotteryPurchasesController, LotteryTicketsController],
      providers: [
        { provide: LotteryPurchasesService, useValue: purchases },
        { provide: LotteryTicketsService, useValue: tickets },
        { provide: APP_GUARD, useClass: FakeJwtAuthGuard },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
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

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  const asUser = (test: request.Test) => test.set('x-test-role', Role.USER);

  const post = (body: unknown) =>
    asUser(request(app.getHttpServer()).post('/lottery/purchases')).send(body);

  describe('auth', () => {
    it.each(ROUTES)(
      '$method $path is 401 for a guest (no @OptionalAuth anywhere)',
      async ({ method, path, body }) => {
        let test = request(app.getHttpServer())[method](path);
        if (body) test = test.send(body);
        await test.expect(401);
        expect(purchases.create).not.toHaveBeenCalled();
        expect(purchases.list).not.toHaveBeenCalled();
        expect(purchases.findOne).not.toHaveBeenCalled();
        expect(tickets.list).not.toHaveBeenCalled();
        expect(tickets.findOne).not.toHaveBeenCalled();
      },
    );

    it.each(ROUTES)(
      '$method $path answers a signed-in customer',
      async ({ method, path, body }) => {
        let test = asUser(request(app.getHttpServer())[method](path));
        if (body) test = test.send(body);
        const response = await test;
        expect(response.status).toBe(method === 'post' ? 201 : 200);
      },
    );
  });

  describe('POST /lottery/purchases', () => {
    it('201s a valid basket, handing the service the signed-in user and the trimmed, coerced lines', async () => {
      const response = await post({
        ...BASKET,
        lines: [
          { number: ' 123456 ', quantity: '2' },
          { number: '000777', quantity: 3 },
        ],
      }).expect(201);

      expect(response.body).toMatchObject({ ref: 'LP-261020-0042' });
      expect(purchases.create).toHaveBeenCalledTimes(1);
      const [user, dto] = purchases.create.mock.calls[0] as [
        { id: string },
        typeof BASKET,
      ];
      expect(user.id).toBe('user-1');
      expect(dto).toEqual({
        drawNo: 24,
        idempotencyKey: KEY,
        lines: [
          { number: '123456', quantity: 2 },
          { number: '000777', quantity: 3 },
        ],
      });
    });

    it.each([
      ['no draw number', { ...BASKET, drawNo: undefined }],
      ['a draw number that is not a whole number', { ...BASKET, drawNo: 1.5 }],
      ['no idempotency key', { ...BASKET, idempotencyKey: undefined }],
      [
        'an idempotency key that is not a uuid',
        { ...BASKET, idempotencyKey: 'retry-1' },
      ],
      ['no lines', { ...BASKET, lines: [] }],
      [
        'more than 50 lines',
        {
          ...BASKET,
          lines: Array.from({ length: 51 }, (_, i) => ({
            number: String(i).padStart(6, '0'),
            quantity: 1,
          })),
        },
      ],
      [
        'the same number twice',
        {
          ...BASKET,
          lines: [
            { number: '123456', quantity: 1 },
            { number: '123456', quantity: 2 },
          ],
        },
      ],
      [
        'a five-digit number',
        { ...BASKET, lines: [{ number: '12345', quantity: 1 }] },
      ],
      [
        'a number with letters',
        { ...BASKET, lines: [{ number: '12a456', quantity: 1 }] },
      ],
      [
        'a quantity of 0',
        { ...BASKET, lines: [{ number: '123456', quantity: 0 }] },
      ],
      [
        'a quantity over 100',
        { ...BASKET, lines: [{ number: '123456', quantity: 101 }] },
      ],
      [
        'a fractional quantity',
        { ...BASKET, lines: [{ number: '123456', quantity: 1.5 }] },
      ],
      ['a line that is not an object', { ...BASKET, lines: ['123456'] }],
      ['a field nobody asked for', { ...BASKET, total: 1 }],
      [
        'a line field nobody asked for',
        { ...BASKET, lines: [{ number: '123456', quantity: 1, price: 1 }] },
      ],
    ])('400s %s', async (_label, body) => {
      await post(body).expect(400);
      expect(purchases.create).not.toHaveBeenCalled();
    });
  });

  describe('GET /lottery/purchases', () => {
    it('pages the caller’s purchases and 400s a page size over 100', async () => {
      await asUser(
        request(app.getHttpServer()).get(
          '/lottery/purchases?page=2&pageSize=5',
        ),
      ).expect(200);
      expect(purchases.list).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({ page: 2, pageSize: 5 }),
      );

      await asUser(
        request(app.getHttpServer()).get('/lottery/purchases?pageSize=101'),
      ).expect(400);
      await asUser(
        request(app.getHttpServer()).get('/lottery/purchases?page=0'),
      ).expect(400);
      expect(purchases.list).toHaveBeenCalledTimes(1);
    });

    it('reads one purchase by ref for the caller only', async () => {
      await asUser(
        request(app.getHttpServer()).get('/lottery/purchases/LP-261020-0042'),
      ).expect(200);
      expect(purchases.findOne).toHaveBeenCalledWith(
        'user-1',
        'LP-261020-0042',
      );
    });
  });

  describe('GET /lottery/tickets', () => {
    it('pages the caller’s tickets, narrowed to one draw, up to 200 a page', async () => {
      await asUser(
        request(app.getHttpServer()).get(
          '/lottery/tickets?drawNo=24&page=3&pageSize=200',
        ),
      ).expect(200);
      expect(tickets.list).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({ drawNo: 24, page: 3, pageSize: 200 }),
      );

      await asUser(request(app.getHttpServer()).get('/lottery/tickets')).expect(
        200,
      );
      expect(tickets.list).toHaveBeenLastCalledWith(
        'user-1',
        expect.objectContaining({ page: 1, pageSize: 20 }),
      );
      const query = tickets.list.mock.calls[1][1] as { drawNo?: number };
      expect(query.drawNo).toBeUndefined();
    });

    it('400s a page size over 200 and a draw number that is not a number', async () => {
      await asUser(
        request(app.getHttpServer()).get('/lottery/tickets?pageSize=201'),
      ).expect(400);
      await asUser(
        request(app.getHttpServer()).get('/lottery/tickets?drawNo=abc'),
      ).expect(400);
      await asUser(
        request(app.getHttpServer()).get('/lottery/tickets?drawNo=0'),
      ).expect(400);
      expect(tickets.list).not.toHaveBeenCalled();
    });

    it('reads one ticket by number for the caller only', async () => {
      await asUser(
        request(app.getHttpServer()).get('/lottery/tickets/MFL-24-000468'),
      ).expect(200);
      expect(tickets.findOne).toHaveBeenCalledWith('user-1', 'MFL-24-000468');
    });
  });
});
