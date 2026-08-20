import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Socket } from 'socket.io';
import { ClientPlatform, Role, UserStatus } from '../generated/prisma/client';
import { PeakUsersService } from '../peak-users/peak-users.service';
import { UsersService } from '../users/users.service';
import { RealtimeGateway } from './realtime.gateway';

function makeSocket(
  id: string,
  handshake: {
    platform?: string;
    address?: string;
    headers?: Record<string, string>;
  } = {},
): Socket {
  return {
    id,
    data: {},
    handshake: {
      auth: { token: 'test-token', platform: handshake.platform },
      headers: handshake.headers ?? {},
      address: handshake.address,
    },
    join: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn(),
  } as unknown as Socket;
}

function makeUser(id: string, role: Role) {
  return { id, role, status: UserStatus.ACTIVE };
}

describe('RealtimeGateway — concurrent USER peak tracking', () => {
  let gateway: RealtimeGateway;
  let usersService: { findByIdOrThrow: jest.Mock };
  let peakUsersService: { recordConcurrent: jest.Mock };
  let jwtService: { verify: jest.Mock };

  beforeEach(async () => {
    usersService = { findByIdOrThrow: jest.fn() };
    peakUsersService = {
      recordConcurrent: jest.fn().mockResolvedValue(undefined),
    };
    jwtService = { verify: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RealtimeGateway,
        { provide: JwtService, useValue: jwtService },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue('test-secret') },
        },
        { provide: UsersService, useValue: usersService },
        { provide: PeakUsersService, useValue: peakUsersService },
      ],
    }).compile();

    gateway = module.get(RealtimeGateway);
  });

  async function connectAs(
    socket: Socket,
    userId: string,
    role: Role,
  ): Promise<void> {
    jwtService.verify.mockReturnValueOnce({ sub: userId });
    usersService.findByIdOrThrow.mockResolvedValueOnce(makeUser(userId, role));
    await gateway.handleConnection(socket);
  }

  it('records the distinct USER count after a successful connection', async () => {
    const socket = makeSocket('s1');

    await connectAs(socket, 'user-1', Role.USER);

    expect(peakUsersService.recordConcurrent).toHaveBeenCalledWith(1);
    expect(socket.disconnect).not.toHaveBeenCalled();
  });

  it('counts a user with two tabs once', async () => {
    await connectAs(makeSocket('s1'), 'user-1', Role.USER);
    await connectAs(makeSocket('s2'), 'user-1', Role.USER);

    expect(peakUsersService.recordConcurrent).toHaveBeenNthCalledWith(1, 1);
    expect(peakUsersService.recordConcurrent).toHaveBeenNthCalledWith(2, 1);
  });

  it('counts distinct users separately', async () => {
    await connectAs(makeSocket('s1'), 'user-1', Role.USER);
    await connectAs(makeSocket('s2'), 'user-2', Role.USER);

    expect(peakUsersService.recordConcurrent).toHaveBeenLastCalledWith(2);
  });

  it('does not count staff sockets (ADMIN / SUPER_ADMIN dashboards)', async () => {
    await connectAs(makeSocket('s1'), 'admin-1', Role.ADMIN);
    await connectAs(makeSocket('s2'), 'super-1', Role.SUPER_ADMIN);

    expect(peakUsersService.recordConcurrent).not.toHaveBeenCalled();
  });

  it('removes the socket on disconnect so the next count excludes it', async () => {
    const socket1 = makeSocket('s1');
    await connectAs(socket1, 'user-1', Role.USER);

    gateway.handleDisconnect(socket1);
    await connectAs(makeSocket('s2'), 'user-2', Role.USER);

    expect(peakUsersService.recordConcurrent).toHaveBeenLastCalledWith(1);
  });

  it('is fire-and-forget — a recordConcurrent failure never breaks the connection', async () => {
    peakUsersService.recordConcurrent.mockRejectedValueOnce(
      new Error('db down'),
    );
    const socket = makeSocket('s1');

    await connectAs(socket, 'user-1', Role.USER);
    // Let the rejected promise's .catch handler run.
    await new Promise(process.nextTick);

    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(socket.join).toHaveBeenCalled();
  });

  it('handles disconnect for sockets that never authenticated without throwing', () => {
    expect(() => gateway.handleDisconnect(makeSocket('ghost'))).not.toThrow();
  });
});

describe('RealtimeGateway — live presence (getActiveUsers)', () => {
  let gateway: RealtimeGateway;
  let usersService: { findByIdOrThrow: jest.Mock };
  let jwtService: { verify: jest.Mock };

  beforeEach(async () => {
    usersService = { findByIdOrThrow: jest.fn() };
    jwtService = { verify: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RealtimeGateway,
        { provide: JwtService, useValue: jwtService },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue('test-secret') },
        },
        { provide: UsersService, useValue: usersService },
        {
          provide: PeakUsersService,
          useValue: { recordConcurrent: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    gateway = module.get(RealtimeGateway);
  });

  async function connectAs(
    socket: Socket,
    userId: string,
    role: Role = Role.USER,
  ): Promise<void> {
    jwtService.verify.mockReturnValueOnce({ sub: userId });
    usersService.findByIdOrThrow.mockResolvedValueOnce(makeUser(userId, role));
    await gateway.handleConnection(socket);
  }

  it('reports nobody when no sockets are connected', () => {
    expect(gateway.getActiveUsers()).toEqual([]);
  });

  it('reports one entry per user — two tabs are one active user, not two', async () => {
    await connectAs(makeSocket('s1', { platform: 'WEB' }), 'user-1');
    await connectAs(makeSocket('s2', { platform: 'WEB' }), 'user-1');

    const active = gateway.getActiveUsers();

    expect(active).toHaveLength(1);
    expect(active[0].userId).toBe('user-1');
    expect(active[0].platforms).toEqual([ClientPlatform.WEB]);
  });

  it('reports BOTH platforms for one user signed in on web and mobile', async () => {
    await connectAs(makeSocket('s1', { platform: 'WEB' }), 'user-1');
    await connectAs(makeSocket('s2', { platform: 'MOBILE' }), 'user-1');

    const [active] = gateway.getActiveUsers();

    expect(active.userId).toBe('user-1');
    expect([...active.platforms].sort()).toEqual([
      ClientPlatform.MOBILE,
      ClientPlatform.WEB,
    ]);
  });

  it('lists distinct users separately', async () => {
    await connectAs(makeSocket('s1', { platform: 'WEB' }), 'user-1');
    await connectAs(makeSocket('s2', { platform: 'MOBILE' }), 'user-2');

    expect(gateway.getActiveUsers().map((u) => u.userId).sort()).toEqual([
      'user-1',
      'user-2',
    ]);
  });

  it('excludes staff sockets — operators are not audience', async () => {
    await connectAs(makeSocket('s1', { platform: 'WEB' }), 'admin-1', Role.ADMIN);
    await connectAs(
      makeSocket('s2', { platform: 'WEB' }),
      'super-1',
      Role.SUPER_ADMIN,
    );

    expect(gateway.getActiveUsers()).toEqual([]);
  });

  it('drops a user only when their LAST socket closes', async () => {
    const first = makeSocket('s1', { platform: 'WEB' });
    const second = makeSocket('s2', { platform: 'WEB' });
    await connectAs(first, 'user-1');
    await connectAs(second, 'user-1');

    gateway.handleDisconnect(first);
    expect(gateway.getActiveUsers()).toHaveLength(1);

    gateway.handleDisconnect(second);
    expect(gateway.getActiveUsers()).toEqual([]);
  });

  it('takes the platform from the handshake the clients declare', async () => {
    await connectAs(makeSocket('s1', { platform: 'MOBILE' }), 'user-1');

    expect(gateway.getActiveUsers()[0].platform).toBe(ClientPlatform.MOBILE);
  });

  it('falls back to a user-agent sniff when the handshake declares no platform', async () => {
    await connectAs(
      makeSocket('s1', { headers: { 'user-agent': 'okhttp/4.12.0' } }),
      'user-1',
    );

    expect(gateway.getActiveUsers()[0].platform).toBe(ClientPlatform.MOBILE);
  });

  it('reports UNKNOWN rather than guessing when there is no signal at all', async () => {
    await connectAs(makeSocket('s1'), 'user-1');

    expect(gateway.getActiveUsers()[0].platform).toBe(ClientPlatform.UNKNOWN);
  });

  it('prefers the forwarded client IP over the proxy socket address', async () => {
    await connectAs(
      makeSocket('s1', {
        platform: 'WEB',
        address: '172.18.0.5',
        headers: { 'x-forwarded-for': '203.0.113.7, 172.18.0.5' },
      }),
      'user-1',
    );

    expect(gateway.getActiveUsers()[0].ip).toBe('203.0.113.7');
  });

  it('normalises an IPv4-mapped socket address', async () => {
    await connectAs(
      makeSocket('s1', { platform: 'WEB', address: '::ffff:192.168.1.5' }),
      'user-1',
    );

    expect(gateway.getActiveUsers()[0].ip).toBe('192.168.1.5');
  });

  it('reports `since` as the earliest still-open socket — when the user came online', async () => {
    const first = makeSocket('s1', { platform: 'WEB' });
    await connectAs(first, 'user-1');
    const cameOnline = gateway.getActiveUsers()[0].since;

    await connectAs(makeSocket('s2', { platform: 'MOBILE' }), 'user-1');

    const [active] = gateway.getActiveUsers();
    expect(active.since.getTime()).toBe(cameOnline.getTime());
    // ...while `platform` follows the newest connection.
    expect(active.platform).toBe(ClientPlatform.MOBILE);
  });
});
