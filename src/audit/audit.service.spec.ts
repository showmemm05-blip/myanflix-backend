import { Test, TestingModule } from '@nestjs/testing';
import { Logger, NotFoundException } from '@nestjs/common';
import {
  AuditCategory,
  ClientPlatform,
  Prisma,
  Role,
} from '../generated/prisma/client';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { requestHostContext } from '../common/storage/request-host.context';
import { PrismaService } from '../prisma/prisma.service';
import { ACTOR_CACHE_TTL_MS, AuditService } from './audit.service';

describe('AuditService', () => {
  let service: AuditService;
  let prisma: {
    user: { findUnique: jest.Mock };
    auditLog: {
      create: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      findUnique: jest.Mock;
    };
    $transaction: jest.Mock;
  };

  const admin: AuthenticatedUser = {
    id: 'admin-1',
    username: 'boss',
    role: Role.ADMIN,
    appRoleId: 'role-admin',
  };

  const endUser: AuthenticatedUser = {
    id: 'user-1',
    username: 'viewer',
    role: Role.USER,
    appRoleId: null,
  };

  const createdData = () =>
    (prisma.auditLog.create.mock.calls[0][0] as { data: Record<string, any> })
      .data;

  beforeEach(async () => {
    prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          displayName: 'The Boss',
          appRole: { name: 'Admin' },
        }),
      },
      auditLog: {
        create: jest.fn().mockResolvedValue({ id: 'log-1' }),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      $transaction: jest.fn(async (ops: Promise<unknown>[]) =>
        Promise.all(ops),
      ),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [AuditService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = moduleRef.get(AuditService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  describe('who is recorded', () => {
    it('skips a plain USER actor entirely (no lookup, no write)', async () => {
      await service.record({
        action: 'comment.delete',
        actor: endUser,
        target: { type: 'comment', id: 'c1' },
      });
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('records a USER actor when force is set', async () => {
      await service.record({
        action: 'comment.delete',
        actor: endUser,
        target: { type: 'comment', id: 'c1' },
        force: true,
      });
      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
      expect(createdData()).toMatchObject({
        actorId: 'user-1',
        actorUsername: 'viewer',
        actorRole: Role.USER,
      });
    });

    it('snapshots a staff actor with displayName and appRole name from ONE query', async () => {
      await service.record({
        action: 'movie.create',
        actor: admin,
        target: { type: 'movie', id: 'm1', label: 'Alpha' },
        after: { title: 'Alpha' },
      });

      expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'admin-1' },
        select: { displayName: true, appRole: { select: { name: true } } },
      });
      expect(createdData()).toMatchObject({
        category: AuditCategory.CONTENT,
        action: 'movie.create',
        actorId: 'admin-1',
        actorUsername: 'boss',
        actorDisplayName: 'The Boss',
        actorRole: Role.ADMIN,
        actorAppRoleId: 'role-admin',
        actorAppRoleName: 'Admin',
        targetType: 'movie',
        targetId: 'm1',
        targetLabel: 'Alpha',
      });
    });

    it('records a system event with actor null as "system"', async () => {
      await service.record({
        action: 'movie.publish',
        actor: null,
        target: { type: 'movie', id: 'm1', label: 'Alpha' },
        metadata: { trigger: 'transcode_complete', videoId: 'v1' },
      });

      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(createdData()).toMatchObject({
        actorId: null,
        actorUsername: 'system',
        actorDisplayName: 'System',
        actorRole: null,
        actorAppRoleId: null,
        actorAppRoleName: null,
        metadata: { trigger: 'transcode_complete', videoId: 'v1' },
        ip: null,
        userAgent: null,
        platform: ClientPlatform.UNKNOWN,
      });
    });

    it('caches the actor lookup for 60 s per actor id', async () => {
      jest.useFakeTimers({ now: new Date('2026-09-09T12:00:00Z') });
      const input = {
        action: 'category.create' as const,
        actor: admin,
        target: { type: 'category' as const, id: 'c1' },
        after: { name: 'Drama' },
      };

      await service.record(input);
      await service.record(input);
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);

      await service.record({ ...input, actor: { ...admin, id: 'admin-2' } });
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(2);

      jest.setSystemTime(Date.now() + ACTOR_CACHE_TTL_MS + 1);
      await service.record(input);
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(3);

      service.invalidateActorCache('admin-1');
      await service.record(input);
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(4);
    });

    it('tolerates an actor row that no longer exists', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await service.record({
        action: 'category.create',
        actor: admin,
        target: { type: 'category', id: 'c1' },
        after: { name: 'Drama' },
      });
      expect(createdData()).toMatchObject({
        actorUsername: 'boss',
        actorDisplayName: null,
        actorAppRoleName: null,
      });
    });
  });

  describe('request context', () => {
    it('captures ip, user agent and platform from the current request', async () => {
      await requestHostContext.run(
        {
          hostname: 'localhost',
          ip: '10.0.0.7',
          userAgent: 'Mozilla/5.0 test',
          platform: ClientPlatform.WEB,
        },
        () =>
          service.record({
            action: 'category.create',
            actor: admin,
            target: { type: 'category', id: 'c1' },
            after: { name: 'Drama' },
          }),
      );
      expect(createdData()).toMatchObject({
        ip: '10.0.0.7',
        userAgent: 'Mozilla/5.0 test',
        platform: ClientPlatform.WEB,
      });
    });
  });

  describe('snapshots and changes', () => {
    it('create → after only, changes null', async () => {
      await service.record({
        action: 'category.create',
        actor: admin,
        target: { type: 'category', id: 'c1' },
        after: { name: 'Drama', description: null },
      });
      const data = createdData();
      expect(data.after).toEqual({ name: 'Drama', description: null });
      expect(data.before).toBeUndefined();
      expect(data.changes).toBeUndefined();
    });

    it('delete → before only, changes null', async () => {
      await service.record({
        action: 'category.delete',
        actor: admin,
        target: { type: 'category', id: 'c1' },
        before: { name: 'Drama' },
        metadata: { detachedMovies: 3 },
      });
      const data = createdData();
      expect(data.before).toEqual({ name: 'Drama' });
      expect(data.after).toBeUndefined();
      expect(data.changes).toBeUndefined();
      expect(data.metadata).toEqual({ detachedMovies: 3 });
    });

    it('update → both snapshots plus the differing fields only', async () => {
      await service.record({
        action: 'movie.update',
        actor: admin,
        target: { type: 'movie', id: 'm1', label: 'Alpha' },
        before: {
          title: 'Alpha',
          status: 'DRAFT',
          categories: [
            { id: 'c1', name: 'Action' },
            { id: 'c2', name: 'Drama' },
          ],
        },
        after: {
          title: 'Alpha II',
          status: 'DRAFT',
          categories: [{ id: 'c1', name: 'Action' }],
        },
      });
      expect(createdData().changes).toEqual([
        { field: 'title', from: 'Alpha', to: 'Alpha II' },
        { field: 'categories', from: ['Action', 'Drama'], to: ['Action'] },
      ]);
    });

    it('diffs Dates and Decimals by value and stores them as JSON scalars', async () => {
      await service.record({
        action: 'deposit.approve',
        actor: admin,
        target: { type: 'deposit', id: 'd1' },
        before: {
          status: 'PENDING',
          amount: new Prisma.Decimal('5000'),
          approvedAt: null,
        },
        after: {
          status: 'APPROVED',
          amount: new Prisma.Decimal('5000.00'),
          approvedAt: new Date('2026-09-09T12:00:00.000Z'),
        },
      });
      const data = createdData();
      expect(data.changes).toEqual([
        { field: 'status', from: 'PENDING', to: 'APPROVED' },
        {
          field: 'approvedAt',
          from: null,
          to: '2026-09-09T12:00:00.000Z',
        },
      ]);
      expect(data.after.amount).toBe(5000);
    });

    it('skips a no-op `.update` (empty diff) but keeps a no-op status action', async () => {
      await service.record({
        action: 'movie.update',
        actor: admin,
        target: { type: 'movie', id: 'm1' },
        before: { title: 'Same' },
        after: { title: 'Same' },
      });
      expect(prisma.auditLog.create).not.toHaveBeenCalled();

      await service.record({
        action: 'movie.publish',
        actor: admin,
        target: { type: 'movie', id: 'm1' },
        before: { status: 'PUBLISHED' },
        after: { status: 'PUBLISHED' },
      });
      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
      expect(createdData().changes).toEqual([]);
    });

    it('redacts secret keys and truncates long strings in every column', async () => {
      const long = 'x'.repeat(5000);
      await service.record({
        action: 'staff.update',
        actor: admin,
        target: { type: 'staff', id: 's1', label: '@sam' },
        before: { username: 'sam', password: 'old', bio: long },
        after: { username: 'sam', password: 'new', bio: 'short' },
        metadata: { refreshToken: 'abc', note: 'ok' },
      });
      const data = createdData();
      expect(data.before.password).toBe('[redacted]');
      expect(data.after.password).toBe('[redacted]');
      expect(data.metadata).toEqual({ refreshToken: '[redacted]', note: 'ok' });
      expect(data.before.bio).toEqual({
        _truncated: true,
        length: 5000,
        preview: 'x'.repeat(200),
      });
      // The raw password values differ, so the diff lists the field — but
      // the stored from/to are redacted too.
      expect(data.changes).toEqual([
        { field: 'password', from: '[redacted]', to: '[redacted]' },
        {
          field: 'bio',
          from: { _truncated: true, length: 5000, preview: 'x'.repeat(200) },
          to: 'short',
        },
      ]);
    });
  });

  describe('persistence', () => {
    it('writes through the given transaction client and lets errors propagate', async () => {
      const tx = {
        user: { findUnique: jest.fn().mockResolvedValue(null) },
        auditLog: { create: jest.fn().mockRejectedValue(new Error('tx boom')) },
      } as unknown as Prisma.TransactionClient;

      await expect(
        service.record({
          action: 'role.permissions_change',
          actor: admin,
          target: { type: 'role', id: 'r1', label: 'Editors' },
          before: { permissions: ['A.B'] },
          after: { permissions: ['A.B', 'C.D'] },
          metadata: { added: ['C.D'], removed: [] },
          tx,
        }),
      ).rejects.toThrow('tx boom');

      expect(
        (tx as unknown as { auditLog: { create: jest.Mock } }).auditLog.create,
      ).toHaveBeenCalledTimes(1);
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('outside a transaction a failed write is logged and swallowed', async () => {
      const errorSpy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      prisma.auditLog.create.mockRejectedValue(new Error('db down'));

      await expect(
        service.record({
          action: 'category.create',
          actor: admin,
          target: { type: 'category', id: 'c1' },
          after: { name: 'Drama' },
        }),
      ).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(String(errorSpy.mock.calls[0][0])).toContain(
        'audit write failed for category.create on category:c1',
      );
    });

    it('a failed actor lookup is swallowed too (outside a transaction)', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      prisma.user.findUnique.mockRejectedValue(new Error('lookup failed'));
      await expect(
        service.record({
          action: 'category.create',
          actor: admin,
          target: { type: 'category', id: 'c1' },
          after: { name: 'Drama' },
        }),
      ).resolves.toBeUndefined();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });
  });

  describe('read side', () => {
    it('findAll builds the where clause from every filter and pages', async () => {
      prisma.auditLog.findMany.mockResolvedValue([{ id: 'log-1' }]);
      prisma.auditLog.count.mockResolvedValue(41);

      const result = await service.findAll({
        page: 3,
        limit: 20,
        from: '2026-09-01T00:00:00.000Z',
        to: '2026-09-30T23:59:59.000Z',
        category: AuditCategory.CONTENT,
        action: 'movie.update',
        targetType: 'movie',
        targetId: 'm1',
        actorId: '11111111-1111-4111-8111-111111111111',
        search: '  alpha ',
      });

      expect(result).toEqual({
        items: [{ id: 'log-1' }],
        total: 41,
        page: 3,
        limit: 20,
      });
      const args = prisma.auditLog.findMany.mock.calls[0][0];
      expect(args.where).toEqual({
        createdAt: {
          gte: new Date('2026-09-01T00:00:00.000Z'),
          lte: new Date('2026-09-30T23:59:59.000Z'),
        },
        category: AuditCategory.CONTENT,
        action: 'movie.update',
        targetType: 'movie',
        targetId: 'm1',
        actorId: '11111111-1111-4111-8111-111111111111',
        OR: [
          { targetLabel: { contains: 'alpha', mode: 'insensitive' } },
          { actorUsername: { contains: 'alpha', mode: 'insensitive' } },
          { action: { contains: 'alpha', mode: 'insensitive' } },
        ],
      });
      expect(args.skip).toBe(40);
      expect(args.take).toBe(20);
      expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
      expect(args.include).toEqual({
        actor: {
          select: {
            id: true,
            username: true,
            displayName: true,
            role: true,
            avatar: true,
          },
        },
      });
      expect(prisma.auditLog.count).toHaveBeenCalledWith({ where: args.where });
    });

    it('findAll with no filters uses an empty where and page defaults', async () => {
      await service.findAll({});
      const args = prisma.auditLog.findMany.mock.calls[0][0];
      expect(args.where).toEqual({});
      expect(args.skip).toBe(0);
      expect(args.take).toBe(20);
    });

    it('findOne returns the row or 404s', async () => {
      prisma.auditLog.findUnique.mockResolvedValue({ id: 'log-1' });
      await expect(service.findOne('log-1')).resolves.toEqual({ id: 'log-1' });

      prisma.auditLog.findUnique.mockResolvedValue(null);
      await expect(service.findOne('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
