import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { io, Socket } from 'socket.io-client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { Role, UserStatus } from '../src/generated/prisma/client';

describe('Realtime WebSocket (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let configService: ConfigService;
  let baseUrl: string;

  let userId: string;
  let adminId: string;
  let userToken: string;
  let adminToken: string;

  async function signToken(id: string, email: string): Promise<string> {
    return jwtService.signAsync(
      { sub: id, email },
      { secret: configService.get<string>('JWT_SECRET'), expiresIn: '15m' },
    );
  }

  function connect(token: string): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const client = io(baseUrl, { auth: { token }, transports: ['websocket'], forceNew: true });
      client.on('connect', () => resolve(client));
      client.on('connect_error', (err) => reject(err));
    });
  }

  function waitForEvent<T>(client: Socket, event: string, timeoutMs = 5000): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for "${event}"`)), timeoutMs);
      client.once(event, (payload: T) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    app.useWebSocketAdapter(new IoAdapter(app));
    await app.init();
    await app.listen(0);

    const address = (app.getHttpServer() as import('node:http').Server).address() as AddressInfo;
    baseUrl = `http://localhost:${address.port}`;

    prisma = app.get(PrismaService);
    jwtService = app.get(JwtService);
    configService = app.get(ConfigService);

    const suffix = randomUUID().slice(0, 8);
    const user = await prisma.user.create({
      data: {
        username: `rtuser_${suffix}`,
        email: `rtuser_${suffix}@test.local`,
        password: 'unused-in-these-tests',
        role: Role.USER,
        status: UserStatus.ACTIVE,
      },
    });
    await prisma.wallet.create({ data: { userId: user.id, balance: 0 } });

    const admin = await prisma.user.create({
      data: {
        username: `rtadmin_${suffix}`,
        email: `rtadmin_${suffix}@test.local`,
        password: 'unused-in-these-tests',
        role: Role.ADMIN,
        status: UserStatus.ACTIVE,
      },
    });
    await prisma.wallet.create({ data: { userId: admin.id, balance: 0 } });

    userId = user.id;
    adminId = admin.id;
    userToken = await signToken(user.id, user.email);
    adminToken = await signToken(admin.id, admin.email);
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { userId: { in: [userId, adminId] } } });
    await prisma.transaction.deleteMany({ where: { userId: { in: [userId, adminId] } } });
    await prisma.deposit.deleteMany({ where: { userId: { in: [userId, adminId] } } });
    await prisma.wallet.deleteMany({ where: { userId: { in: [userId, adminId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [userId, adminId] } } });
    await app.close();
  });

  it('rejects a connection with no token', async () => {
    // Socket.IO's transport-level handshake accepts the connection (client
    // sees "connect") before Nest's handleConnection ever runs — auth
    // rejection happens by force-disconnecting shortly after, not by
    // refusing the handshake itself.
    const client = io(baseUrl, { transports: ['websocket'], forceNew: true });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('was never disconnected')), 5000);
        client.on('disconnect', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    } finally {
      client.disconnect();
    }
  });

  it('emits deposit.created to the admins room when a user creates a deposit', async () => {
    const adminSocket = await connect(adminToken);
    const userSocket = await connect(userToken);

    try {
      const eventPromise = waitForEvent<{ id: string; reference: string; userId: string }>(
        adminSocket,
        'deposit.created',
      );

      const createRes = await request(app.getHttpServer())
        .post('/api/deposits')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ amount: 6000, paymentMethod: 'KBZ Pay', reference: '900111' })
        .expect(201);

      const event = await eventPromise;
      expect(event.id).toBe(createRes.body.data.id);
      expect(event.reference).toBe('900111');
      expect(event.userId).toBe(userId);
    } finally {
      adminSocket.disconnect();
      userSocket.disconnect();
    }
  });

  it('a plain user is never placed in the admins room', async () => {
    const userSocket = await connect(userToken);
    const otherUserSocket = await connect(userToken);

    try {
      let receivedByUser = false;
      userSocket.on('deposit.created', () => {
        receivedByUser = true;
      });

      await request(app.getHttpServer())
        .post('/api/deposits')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ amount: 1000, paymentMethod: 'Wave Pay', reference: '900222' })
        .expect(201);

      // Give any (incorrect) admin-room delivery a moment to arrive.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(receivedByUser).toBe(false);
    } finally {
      userSocket.disconnect();
      otherUserSocket.disconnect();
    }
  });

  it('emits deposit.updated, notification.created, and wallet.balanceUpdated to the depositing user on approval', async () => {
    const userSocket = await connect(userToken);

    try {
      const createRes = await request(app.getHttpServer())
        .post('/api/deposits')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ amount: 4500, paymentMethod: 'AYA Pay', reference: '900333' })
        .expect(201);
      const depositId = createRes.body.data.id;

      const depositUpdated = waitForEvent<{ id: string; status: string }>(userSocket, 'deposit.updated');
      const notificationCreated = waitForEvent<{ type: string }>(userSocket, 'notification.created');
      const balanceUpdated = waitForEvent<{ balance: number }>(userSocket, 'wallet.balanceUpdated');

      await request(app.getHttpServer())
        .patch(`/api/deposits/${depositId}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const [updated, notification, balance] = await Promise.all([
        depositUpdated,
        notificationCreated,
        balanceUpdated,
      ]);

      expect(updated.id).toBe(depositId);
      expect(updated.status).toBe('APPROVED');
      expect(notification.type).toBe('DEPOSIT_APPROVED');
      expect(balance.balance).toBe(4500);
    } finally {
      userSocket.disconnect();
    }
  });
});
