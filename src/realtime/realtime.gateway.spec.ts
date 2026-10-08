import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Subject } from 'rxjs';
import type { Socket } from 'socket.io';
import { ClientPlatform, Role, UserStatus } from '../generated/prisma/client';
import { PeakUsersService } from '../peak-users/peak-users.service';
import { UsersService } from '../users/users.service';
import { PermissionResolverService } from '../roles/permission-resolver.service';
import {
  type AccountAccessEvent,
  SessionRevocationService,
} from '../auth/session-revocation.service';
import {
  createRoleAwarePermissionResolver,
  seededRoleRow,
  type TestRoleRow,
} from '../../test/seeded-permission-resolver';
import { RealtimeGateway } from './realtime.gateway';

/** The four built-in roles with their REAL seeded permission sets. */
const SEEDED_ROWS: TestRoleRow[] = [
  seededRoleRow(Role.SUPER_ADMIN),
  seededRoleRow(Role.ADMIN),
  seededRoleRow(Role.CONTENT_UPLOADER),
  seededRoleRow(Role.USER),
];

/**
 * H-3 collaborators every gateway needs: the permission resolver (seeded
 * roles unless a spec passes its own) and the account-access event channel.
 */
function accessProviders(rows: TestRoleRow[] = SEEDED_ROWS) {
  const events = new Subject<AccountAccessEvent>();
  return {
    events,
    providers: [
      {
        provide: PermissionResolverService,
        useValue: createRoleAwarePermissionResolver(rows),
      },
      {
        provide: SessionRevocationService,
        useValue: { events: events.asObservable() },
      },
    ],
  };
}

function makeSocket(
  id: string,
  handshake: {
    platform?: string;
    address?: string;
    headers?: Record<string, string>;
  } = {},
): Socket {
  // A real socket starts in the room named after its own id; join/leave
  // keep `rooms` honest so re-checks can be asserted on it.
  const rooms = new Set<string>([id]);
  return {
    id,
    data: {},
    rooms,
    handshake: {
      auth: { token: 'test-token', platform: handshake.platform },
      headers: handshake.headers ?? {},
      address: handshake.address,
    },
    join: jest.fn((room: string | string[]) => {
      for (const name of Array.isArray(room) ? room : [room]) rooms.add(name);
      return Promise.resolve();
    }),
    leave: jest.fn((room: string) => {
      rooms.delete(room);
      return Promise.resolve();
    }),
    disconnect: jest.fn(),
  } as unknown as Socket;
}

function makeUser(id: string, role: Role) {
  return { id, role, status: UserStatus.ACTIVE };
}

describe('RealtimeGateway — concurrent USER peak tracking', () => {
  let gateway: RealtimeGateway;
  let usersService: { findAuthSubject: jest.Mock };
  let peakUsersService: { recordConcurrent: jest.Mock };
  let jwtService: { verify: jest.Mock };

  beforeEach(async () => {
    usersService = { findAuthSubject: jest.fn() };
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
        ...accessProviders().providers,
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
    usersService.findAuthSubject.mockResolvedValueOnce(makeUser(userId, role));
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

  it('keeps a user counted until their LAST socket closes', async () => {
    const tab1 = makeSocket('s1');
    const tab2 = makeSocket('s2');
    await connectAs(tab1, 'user-1', Role.USER);
    await connectAs(tab2, 'user-1', Role.USER);

    gateway.handleDisconnect(tab1);
    await connectAs(makeSocket('s3'), 'user-2', Role.USER);
    expect(peakUsersService.recordConcurrent).toHaveBeenLastCalledWith(2);

    gateway.handleDisconnect(tab2);
    gateway.handleDisconnect(tab2); // a repeated disconnect changes nothing
    await connectAs(makeSocket('s4'), 'user-3', Role.USER);
    expect(peakUsersService.recordConcurrent).toHaveBeenLastCalledWith(2);
  });

  it('refuses the socket when the account no longer exists', async () => {
    const socket = makeSocket('s1');
    jwtService.verify.mockReturnValueOnce({ sub: 'gone' });
    usersService.findAuthSubject.mockResolvedValueOnce(null);

    await gateway.handleConnection(socket);

    expect(socket.disconnect).toHaveBeenCalledWith(true);
    expect(peakUsersService.recordConcurrent).not.toHaveBeenCalled();
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
  let usersService: { findAuthSubject: jest.Mock };
  let jwtService: { verify: jest.Mock };

  beforeEach(async () => {
    usersService = { findAuthSubject: jest.fn() };
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
        ...accessProviders().providers,
        {
          provide: PeakUsersService,
          useValue: {
            recordConcurrent: jest.fn().mockResolvedValue(undefined),
          },
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
    usersService.findAuthSubject.mockResolvedValueOnce(makeUser(userId, role));
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

    expect(
      gateway
        .getActiveUsers()
        .map((u) => u.userId)
        .sort(),
    ).toEqual(['user-1', 'user-2']);
  });

  it('excludes staff sockets — operators are not audience', async () => {
    await connectAs(
      makeSocket('s1', { platform: 'WEB' }),
      'admin-1',
      Role.ADMIN,
    );
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

  it('M-5: ignores X-Forwarded-For from a peer that is not a trusted proxy', async () => {
    const original = process.env.TRUSTED_PROXIES;
    delete process.env.TRUSTED_PROXIES;
    try {
      await connectAs(
        makeSocket('s1', {
          platform: 'WEB',
          address: '198.51.100.4',
          headers: { 'x-forwarded-for': '203.0.113.7' },
        }),
        'user-1',
      );
      expect(gateway.getActiveUsers()[0].ip).toBe('198.51.100.4');
    } finally {
      if (original === undefined) delete process.env.TRUSTED_PROXIES;
      else process.env.TRUSTED_PROXIES = original;
    }
  });

  it('prefers the forwarded client IP when the socket peer is a trusted proxy', async () => {
    const original = process.env.TRUSTED_PROXIES;
    process.env.TRUSTED_PROXIES = '172.18.0.5';
    try {
      await connectAs(
        makeSocket('s1', {
          platform: 'WEB',
          address: '172.18.0.5',
          headers: { 'x-forwarded-for': '203.0.113.7, 172.18.0.5' },
        }),
        'user-1',
      );
      expect(gateway.getActiveUsers()[0].ip).toBe('203.0.113.7');
    } finally {
      if (original === undefined) delete process.env.TRUSTED_PROXIES;
      else process.env.TRUSTED_PROXIES = original;
    }
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

/**
 * The phone-monitor handshake (bank verification). A machine socket is
 * neither a user nor an admin: it joins only its own room, never enters the
 * audience count, and is refused outright when ingestion is switched off.
 */
describe('RealtimeGateway — machine (phone-monitor) sockets', () => {
  const MACHINE_TOKEN = 'm'.repeat(48);
  let gateway: RealtimeGateway;
  let jwtService: { verify: jest.Mock };
  let usersService: { findAuthSubject: jest.Mock };
  let peakUsersService: { recordConcurrent: jest.Mock };
  let env: Record<string, string | undefined>;

  function makeMachineSocket(id: string, machineToken: unknown): Socket {
    return {
      id,
      data: {},
      handshake: {
        auth: { machineToken, platform: 'phone-monitor' },
        headers: {},
      },
      join: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn(),
    } as unknown as Socket;
  }

  beforeEach(async () => {
    env = { JWT_SECRET: 'test-secret', BANK_EVENTS_TOKEN: MACHINE_TOKEN };
    jwtService = { verify: jest.fn() };
    usersService = { findAuthSubject: jest.fn() };
    peakUsersService = {
      recordConcurrent: jest.fn().mockResolvedValue(undefined),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RealtimeGateway,
        { provide: JwtService, useValue: jwtService },
        {
          provide: ConfigService,
          useValue: { get: jest.fn((key: string) => env[key]) },
        },
        { provide: UsersService, useValue: usersService },
        ...accessProviders().providers,
        { provide: PeakUsersService, useValue: peakUsersService },
      ],
    }).compile();
    gateway = module.get(RealtimeGateway);
    gateway.server = {
      to: jest.fn().mockReturnValue({ emit: jest.fn() }),
    } as never;
  });

  it('joins bank-monitors only, never a user room, never the audience count, never the JWT path', async () => {
    const socket = makeMachineSocket('m1', MACHINE_TOKEN);

    await gateway.handleConnection(socket);

    expect(socket.join).toHaveBeenCalledTimes(1);
    expect(socket.join).toHaveBeenCalledWith('bank-monitors');
    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(socket.data.machine).toBe('phone-monitor');
    expect(socket.data.userId).toBeUndefined();
    expect(jwtService.verify).not.toHaveBeenCalled();
    expect(usersService.findAuthSubject).not.toHaveBeenCalled();
    expect(peakUsersService.recordConcurrent).not.toHaveBeenCalled();
    expect(gateway.getActiveUsers()).toEqual([]);
  });

  it('disconnects a wrong machine token', async () => {
    const socket = makeMachineSocket('m1', `${MACHINE_TOKEN}x`);
    await gateway.handleConnection(socket);
    expect(socket.disconnect).toHaveBeenCalledWith(true);
    expect(socket.join).not.toHaveBeenCalled();
  });

  it('refuses every machine handshake while BANK_EVENTS_TOKEN is unset (ingestion off)', async () => {
    env.BANK_EVENTS_TOKEN = undefined;
    const socket = makeMachineSocket('m1', MACHINE_TOKEN);
    await gateway.handleConnection(socket);
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('a machine token presented as the user `token` is not a JWT and is rejected on that path', async () => {
    jwtService.verify.mockImplementation(() => {
      throw new Error('jwt malformed');
    });
    const socket = makeSocket('u1');
    await gateway.handleConnection(socket);
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('broadcasts a payment-accounts change to every connected client, with no payload to trust', () => {
    const emit = jest.fn();
    gateway.server = { emit, to: jest.fn() } as never;

    gateway.notifyPaymentAccountsChanged();

    expect(emit).toHaveBeenCalledWith('payment-accounts.changed', {});
    expect(
      (gateway.server as unknown as { to: jest.Mock }).to,
    ).not.toHaveBeenCalled();
  });

  it('routes verification updates and bank-transaction events to admins only — never bank-monitors, never a user room', () => {
    const emit = jest.fn();
    const to = jest.fn().mockReturnValue({ emit });
    gateway.server = { to } as never;

    const payload = {
      id: 'dep-1',
      matchStatus: 'SUSPICIOUS',
      riskLevel: 'HIGH',
      riskReasons: ['AMOUNT_MISMATCH'],
      receivingAmount: 45000,
      receivingTransactionCode: 'AB12CD',
      receivingTransactionAt: new Date(),
      bankCheckedAt: new Date(),
      hasBankScreenshot: false,
      bankTransactionId: 'tx-1',
      bankCounterparty: null,
    };
    gateway.notifyAdminsDepositVerificationUpdated(payload);
    expect(to).toHaveBeenLastCalledWith('perm:DEPOSITS.VIEW');
    expect(emit).toHaveBeenLastCalledWith('deposit.verification', payload);

    const transaction = {
      id: 'tx-1',
      deviceSerial: 'PIXEL10',
      paymentAccountId: 'acct-1',
      direction: 'RECEIVED',
      amount: 45000,
      currency: 'MMK',
      txCode: 'KBZ20260922AB12CD',
      txCodeLast6: 'AB12CD',
      occurredAt: new Date(),
      postedAt: new Date(),
      counterparty: null,
      detailStatus: 'ok',
      state: 'UNMATCHED',
      view: 'WAITING' as const,
      linkedDepositId: null,
      linkedWithdrawalId: null,
      matchedAt: null,
      hasScreenshot: false,
      createdAt: new Date(),
    };
    gateway.notifyAdminsBankTransactionCreated(transaction);
    expect(to).toHaveBeenLastCalledWith('perm:BANK_TRANSACTIONS.VIEW');
    expect(emit).toHaveBeenLastCalledWith(
      'bank-transaction.created',
      transaction,
    );
    gateway.notifyAdminsBankTransactionUpdated(transaction);
    expect(to).toHaveBeenLastCalledWith('perm:BANK_TRANSACTIONS.VIEW');
    expect(emit).toHaveBeenLastCalledWith(
      'bank-transaction.updated',
      transaction,
    );

    const withdrawalVerification = {
      id: 'wd-1',
      matchStatus: 'MATCHED',
      riskLevel: null,
      riskReasons: [],
      transferAmount: 5000,
      transferTransactionCode: 'ZZ99',
      transferTransactionAt: new Date(),
      bankCheckedAt: new Date(),
      hasBankScreenshot: false,
      bankTransactionId: 'tx-2',
    };
    gateway.notifyAdminsWithdrawalVerificationUpdated(withdrawalVerification);
    expect(to).toHaveBeenLastCalledWith('perm:WITHDRAWALS.VIEW');

    // The phone-monitor room receives nothing since store-first ingestion
    // (the deposit-created nudge is gone), and never a user's room: a user
    // must not see their own fraud score or the business account's money.
    expect(to.mock.calls.flat()).not.toContain('bank-monitors');
    expect(to.mock.calls.flat()).not.toContain('user:user-1');
    expect(gateway).not.toHaveProperty('notifyBankMonitorsNudge');
  });

  it('sends a deposit / withdrawal DECISION (change: status) to the user AND admins', () => {
    const emit = jest.fn();
    const to = jest.fn().mockReturnValue({ emit });
    gateway.server = { to } as never;

    const deposit = {
      id: 'dep-1',
      change: 'status' as const,
      status: 'APPROVED',
      amount: 45000,
      paymentMethod: 'KBZ Pay',
      reference: 'AB12CD',
      approvedAt: new Date(),
    };
    gateway.notifyUserDepositUpdated('user-1', deposit);
    expect(to).toHaveBeenLastCalledWith(['user:user-1', 'perm:DEPOSITS.VIEW']);
    expect(emit).toHaveBeenLastCalledWith('deposit.updated', deposit);

    const withdrawal = {
      id: 'wd-1',
      change: 'status' as const,
      status: 'APPROVED',
      amount: 5000,
      accountType: 'KBZPay',
      accountName: 'Ko Ko',
      accountNumber: '09123456789',
      approvedAt: new Date(),
    };
    gateway.notifyUserWithdrawalUpdated('user-1', withdrawal);
    expect(to).toHaveBeenLastCalledWith([
      'user:user-1',
      'perm:WITHDRAWALS.VIEW',
    ]);
    expect(emit).toHaveBeenLastCalledWith('withdrawal.updated', withdrawal);
  });

  it('sends a receiving / transfer-account edit to admins ONLY, under the same event names', () => {
    const emit = jest.fn();
    const to = jest.fn().mockReturnValue({ emit });
    gateway.server = { to } as never;

    // Which of OUR accounts the money landed in (or was paid from) is
    // bookkeeping the user never sees — and the user's client toasts
    // "Deposit approved" / "Withdrawal approved" on any *.updated whose
    // status is APPROVED, so an admin correcting the account must never
    // enter the user's room.
    const depositEdit = {
      id: 'dep-1',
      change: 'receiving_account' as const,
      status: 'APPROVED',
      amount: 45000,
      paymentMethod: 'KBZ Pay',
      reference: 'AB12CD',
      approvedAt: new Date(),
      receivingAccountType: 'KBZ Pay',
      receivingAccountSubname: 'K1',
      receivingAccountName: 'MyanFlix',
      receivingAccountNumber: '09999999999',
      receivingTransactionCode: 'AB12CD',
      receivingTransactionTime: '06:56:28',
    };
    const withdrawalEdit = {
      id: 'wd-1',
      change: 'transfer_account' as const,
      status: 'APPROVED',
      amount: 5000,
      accountType: 'KBZPay',
      accountName: 'Ko Ko',
      accountNumber: '09123456789',
      approvedAt: new Date(),
      transferAccountType: 'KBZPay',
      transferAccountSubname: 'K1',
      transferAccountName: 'MyanFlix',
      transferAccountNumber: '09999999999',
      transferTransactionCode: 'AB12CD',
      transferTransactionTime: 'Jan 1, 2026 10:00 AM',
    };

    gateway.notifyAdminsDepositUpdated(depositEdit);
    gateway.notifyAdminsWithdrawalUpdated(withdrawalEdit);

    // Same event names the admin table already merges by `id` — but every
    // `to(...)` was the admins room alone, never an array with a user room.
    expect(to.mock.calls).toEqual([
      ['perm:DEPOSITS.VIEW'],
      ['perm:WITHDRAWALS.VIEW'],
    ]);
    expect(emit.mock.calls).toEqual([
      ['deposit.updated', depositEdit],
      ['withdrawal.updated', withdrawalEdit],
    ]);
    expect(to.mock.calls.flat(2)).not.toContain('user:user-1');
    expect(to.mock.calls.flat(2)).not.toContain('bank-monitors');
  });
});

/**
 * H-3: money pushes follow the same permissions as the REST API. Each staff
 * socket joins one room per permission it holds (resolved through its
 * AppRole, not the legacy enum), every event goes only to its room, and the
 * rooms are re-checked when a role's permissions change. Revoked, suspended
 * and deleted accounts lose their sockets.
 */
describe('RealtimeGateway — permission rooms (H-3)', () => {
  let gateway: RealtimeGateway;
  let jwtService: { verify: jest.Mock };
  let usersService: { findAuthSubject: jest.Mock; findById: jest.Mock };
  let access: ReturnType<typeof accessProviders>;

  /** Custom roles the audit named: a narrow content role, and a finance clerk. */
  const ROWS: TestRoleRow[] = [
    ...SEEDED_ROWS,
    {
      id: 'role-movies',
      key: 'MOVIE_MANAGER',
      permissions: ['MOVIES.VIEW', 'MOVIES.EDIT'],
    },
    {
      id: 'role-clerk',
      key: 'DEPOSIT_CLERK',
      permissions: ['DEPOSITS.VIEW', 'DEPOSITS.APPROVE'],
    },
    {
      id: 'role-bank',
      key: 'BANK_WATCHER',
      permissions: ['BANK_TRANSACTIONS.VIEW', 'FINANCE.VIEW'],
    },
  ];

  const MONEY_ROOMS = [
    'perm:DEPOSITS.VIEW',
    'perm:WITHDRAWALS.VIEW',
    'perm:BANK_TRANSACTIONS.VIEW',
    'perm:PAYMENT_ACCOUNTS.VIEW',
    'perm:FINANCE.VIEW',
  ];

  function staff(
    id: string,
    role: Role,
    appRoleId: string | null = null,
    extra: Record<string, unknown> = {},
  ) {
    return { id, role, appRoleId, status: UserStatus.ACTIVE, ...extra };
  }

  async function connect(
    socket: Socket,
    user: ReturnType<typeof staff>,
    payload: Record<string, unknown> = {},
  ): Promise<void> {
    jwtService.verify.mockReturnValueOnce({ sub: user.id, ...payload });
    usersService.findAuthSubject.mockResolvedValueOnce(user);
    await gateway.handleConnection(socket);
  }

  const permRooms = (socket: Socket) =>
    [...socket.rooms].filter((room) => room.startsWith('perm:')).sort();

  beforeEach(async () => {
    jwtService = { verify: jest.fn() };
    usersService = { findAuthSubject: jest.fn(), findById: jest.fn() };
    access = accessProviders(ROWS);

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
          useValue: {
            recordConcurrent: jest.fn().mockResolvedValue(undefined),
          },
        },
        ...access.providers,
      ],
    }).compile();

    gateway = module.get(RealtimeGateway);
    gateway.onModuleInit();
  });

  afterEach(() => gateway.onModuleDestroy());

  it('the seeded ADMIN role joins deposits and withdrawals — but NOT bank transactions, which it may not read', async () => {
    const socket = makeSocket('s1');
    await connect(socket, staff('admin-1', Role.ADMIN));

    expect(permRooms(socket)).toEqual([
      'perm:DEPOSITS.VIEW',
      'perm:WITHDRAWALS.VIEW',
    ]);
    expect(socket.rooms.has('admins')).toBe(false);
    expect(socket.disconnect).not.toHaveBeenCalled();
  });

  it('a Super Admin joins every money room', async () => {
    const socket = makeSocket('s1');
    await connect(socket, staff('super-1', Role.SUPER_ADMIN));

    expect(permRooms(socket)).toEqual([...MONEY_ROOMS].sort());
  });

  it('an ADMIN-enum account moved onto a narrow custom role gets NO money pushes', async () => {
    const socket = makeSocket('s1');
    await connect(socket, staff('admin-2', Role.ADMIN, 'role-movies'));

    expect(permRooms(socket)).toEqual([]);
  });

  it('a CONTENT_UPLOADER-enum account given DEPOSITS.VIEW by a custom role DOES get the deposit pushes', async () => {
    const socket = makeSocket('s1');
    await connect(
      socket,
      staff('clerk-1', Role.CONTENT_UPLOADER, 'role-clerk'),
    );

    expect(permRooms(socket)).toEqual(['perm:DEPOSITS.VIEW']);
  });

  it('a customer socket never joins a permission room', async () => {
    const socket = makeSocket('s1');
    await connect(socket, staff('user-1', Role.USER, 'role-clerk'));

    expect(permRooms(socket)).toEqual([]);
    expect(socket.rooms.has('user:user-1')).toBe(true);
  });

  it("H-21: refuses a handshake whose token predates the account's session revoke", async () => {
    const revokedAt = new Date('2026-09-28T10:00:00.000Z');
    const socket = makeSocket('s1');
    await connect(
      socket,
      staff('admin-1', Role.ADMIN, null, { sessionsRevokedAt: revokedAt }),
      {
        iat: Math.floor(revokedAt.getTime() / 1000) - 30,
        ims: revokedAt.getTime() - 30_000,
      },
    );

    expect(socket.disconnect).toHaveBeenCalledWith(true);
    expect(permRooms(socket)).toEqual([]);
  });

  it('every money event goes to its own permission room only', () => {
    const emit = jest.fn();
    const to = jest.fn().mockReturnValue({ emit });
    gateway.server = { to } as never;

    gateway.notifyAdminsDepositCreated({ id: 'dep-1' } as never);
    gateway.notifyAdminsWithdrawalCreated({ id: 'wd-1' } as never);
    gateway.notifyAdminsPaymentAccountUpdated({ paymentAccountId: 'acct-1' });

    expect(to.mock.calls).toEqual([
      ['perm:DEPOSITS.VIEW'],
      ['perm:WITHDRAWALS.VIEW'],
      [['perm:PAYMENT_ACCOUNTS.VIEW', 'perm:FINANCE.VIEW']],
    ]);
    expect(emit.mock.calls.map(([event]) => event as string)).toEqual([
      'deposit.created',
      'withdrawal.created',
      'payment-account.updated',
    ]);
  });

  it('a revoke closes every socket of that account', () => {
    const disconnectSockets = jest.fn();
    const inRoom = jest.fn().mockReturnValue({ disconnectSockets });
    gateway.server = { in: inRoom } as never;

    access.events.next({ kind: 'user', userId: 'admin-1' });

    expect(inRoom).toHaveBeenCalledWith('user:admin-1');
    expect(disconnectSockets).toHaveBeenCalledWith(true);
  });

  describe('a role permission change re-checks every open staff socket', () => {
    async function flush(): Promise<void> {
      for (let i = 0; i < 10; i += 1) await new Promise(process.nextTick);
    }

    it('drops rooms the role lost and joins rooms it gained, without a reconnect', async () => {
      const socket = makeSocket('s1');
      await connect(
        socket,
        staff('clerk-1', Role.CONTENT_UPLOADER, 'role-clerk'),
      );
      expect(permRooms(socket)).toEqual(['perm:DEPOSITS.VIEW']);

      // The clerk's role is edited: deposits out, bank transactions in.
      const clerkRole = ROWS.find((row) => row.id === 'role-clerk')!;
      const original = clerkRole.permissions;
      (clerkRole as { permissions: readonly string[] }).permissions = [
        'BANK_TRANSACTIONS.VIEW',
      ];
      try {
        usersService.findById.mockResolvedValue(
          staff('clerk-1', Role.CONTENT_UPLOADER, 'role-clerk'),
        );
        gateway.server = {
          fetchSockets: jest.fn().mockResolvedValue([socket]),
        } as never;

        access.events.next({ kind: 'permissions' });
        await flush();

        expect(permRooms(socket)).toEqual(['perm:BANK_TRANSACTIONS.VIEW']);
        expect(socket.leave).toHaveBeenCalledWith('perm:DEPOSITS.VIEW');
        expect(socket.disconnect).not.toHaveBeenCalled();
      } finally {
        (clerkRole as { permissions: readonly string[] }).permissions =
          original;
      }
    });

    it('closes the socket of an account that is no longer active (or no longer exists)', async () => {
      const suspended = makeSocket('s1');
      const deleted = makeSocket('s2');
      await connect(suspended, staff('admin-1', Role.ADMIN));
      await connect(deleted, staff('admin-2', Role.ADMIN));

      usersService.findById.mockImplementation((id: string) =>
        Promise.resolve(
          id === 'admin-1'
            ? staff('admin-1', Role.ADMIN, null, {
                status: UserStatus.SUSPENDED,
              })
            : null,
        ),
      );
      gateway.server = {
        fetchSockets: jest.fn().mockResolvedValue([suspended, deleted]),
      } as never;

      access.events.next({ kind: 'permissions' });
      await flush();

      expect(suspended.disconnect).toHaveBeenCalledWith(true);
      expect(deleted.disconnect).toHaveBeenCalledWith(true);
    });

    it('leaves customer and phone-monitor sockets alone', async () => {
      const customer = makeSocket('s1');
      await connect(customer, staff('user-1', Role.USER));
      const machine = makeSocket('m1');
      machine.data.machine = 'phone-monitor';
      gateway.server = {
        fetchSockets: jest.fn().mockResolvedValue([customer, machine]),
      } as never;

      access.events.next({ kind: 'permissions' });
      await flush();

      expect(usersService.findById).not.toHaveBeenCalled();
      expect(customer.disconnect).not.toHaveBeenCalled();
      expect(machine.disconnect).not.toHaveBeenCalled();
    });
  });
});
