import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import {
  Prisma,
  Role,
  SmsMessageStatus,
  UserStatus,
} from '../generated/prisma/client';
import { SMS_REDACTED } from '../sms/sms.config';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/storage/minio.service';
import { StorageService } from '../common/storage/storage.service';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { AuthorityService } from '../roles/authority.service';
import { PermissionResolverService } from '../roles/permission-resolver.service';
import { AuditService } from '../audit/audit.service';
import { SessionRevocationService } from '../auth/session-revocation.service';
import {
  createRoleAwarePermissionResolver,
  seededRoleRow,
} from '../../test/seeded-permission-resolver';
import { UsersService, walletTotalsFromTypeSums } from './users.service';

/** SessionRevocationService stand-in: records what was revoked and kicked. */
function makeSessions() {
  return {
    revokeAll: jest.fn().mockResolvedValue(undefined),
    revokeAllAndDisconnect: jest.fn().mockResolvedValue(undefined),
    disconnectUser: jest.fn(),
    permissionsChanged: jest.fn(),
  };
}

/**
 * PATCH /users/:id/role is the single most powerful endpoint in the platform —
 * it can mint a Super Admin — and until the audit it ran every one of these
 * changes with nothing but USERS.EDIT and no checks at all (F2/F7). These
 * cases are the staff-route guards, proven on the endpoint that bypassed them.
 */
describe('UsersService — updateRole escalation guards', () => {
  let service: UsersService;
  let prisma: {
    user: { findUnique: jest.Mock; update: jest.Mock; count: jest.Mock };
    appRole: { findUnique: jest.Mock; findMany: jest.Mock };
  };
  let audit: { record: jest.Mock; invalidateActorCache: jest.Mock };
  let sessions: ReturnType<typeof makeSessions>;

  const APP_ROLES: Record<string, { id: string }> = {
    [Role.SUPER_ADMIN]: { id: 'role-super' },
    [Role.ADMIN]: { id: 'role-admin' },
    [Role.CONTENT_UPLOADER]: { id: 'role-uploader' },
    [Role.USER]: { id: 'role-user' },
  };

  /** A Super Admin, by the protected AppRole rather than by the enum alone. */
  const actor: AuthenticatedUser = {
    id: 'boss-1',
    username: 'boss',
    role: Role.SUPER_ADMIN,
    appRoleId: 'role-super',
  };

  /**
   * The custom role the audit escalated with: a plausible "user support" role
   * holding the USERS module and nothing else.
   */
  const support: AuthenticatedUser = {
    id: 'support-1',
    username: 'support',
    role: Role.ADMIN,
    appRoleId: 'role-support',
  };

  const targetUser = {
    id: 'user-1',
    username: 'john',
    role: Role.USER,
    appRoleId: 'role-user',
    status: UserStatus.ACTIVE,
  };

  const superAdminTarget = {
    ...targetUser,
    id: 'other-boss',
    role: Role.SUPER_ADMIN,
    appRoleId: 'role-super',
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    sessions = makeSessions();

    prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue(targetUser),
        update: jest.fn().mockResolvedValue(targetUser),
        count: jest.fn().mockResolvedValue(1),
      },
      appRole: {
        findUnique: jest.fn(({ where }: { where: { key?: string } }) =>
          Promise.resolve(where.key ? (APP_ROLES[where.key] ?? null) : null),
        ),
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: 'role-super', key: Role.SUPER_ADMIN, isSystem: true },
          ]),
      },
    };

    const resolver = createRoleAwarePermissionResolver([
      seededRoleRow(Role.SUPER_ADMIN, 'role-super'),
      seededRoleRow(Role.ADMIN, 'role-admin'),
      seededRoleRow(Role.CONTENT_UPLOADER, 'role-uploader'),
      seededRoleRow(Role.USER, 'role-user'),
      {
        id: 'role-support',
        key: 'USER_SUPPORT',
        permissions: ['USERS.VIEW', 'USERS.EDIT', 'USERS.SUSPEND'],
      },
      {
        id: 'role-rolemgr',
        key: 'ROLE_MANAGER',
        permissions: ['ROLES.VIEW', 'ROLES.EDIT'],
      },
    ]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        // The real AuthorityService — P1/P2 are the subject here.
        AuthorityService,
        { provide: PrismaService, useValue: prisma },
        { provide: MinioService, useValue: {} },
        // Avatar key builder — untouched by the role/status cases here, but
        // a constructor dependency of the service under test.
        StorageService,
        { provide: ConfigService, useValue: { get: () => undefined } },
        {
          provide: AuditService,
          useValue: {
            record: jest.fn().mockResolvedValue(undefined),
            invalidateActorCache: jest.fn(),
          },
        },
        { provide: PermissionResolverService, useValue: resolver },
        { provide: SessionRevocationService, useValue: sessions },
      ],
    }).compile();

    service = module.get(UsersService);
    audit = module.get(AuditService);
  });

  it('F2: refuses self-promotion via PATCH /users/:id/role', async () => {
    await expect(
      service.updateRole(support.id, Role.SUPER_ADMIN, support),
    ).rejects.toThrow(
      'You cannot change your own role. Ask another Super Admin to do this.',
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('F2: refuses self-promotion even to a lesser role — the rule is about the actor, not the tier', async () => {
    await expect(
      service.updateRole(support.id, Role.ADMIN, support),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('F2: refuses to promote a third party to Super Admin without holding it (P2)', async () => {
    await expect(
      service.updateRole('user-1', Role.SUPER_ADMIN, support),
    ).rejects.toThrow(
      'Only a Super Admin can create or change a Super Admin account.',
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('F2: refuses to demote a Super Admin — you may not touch a tier you are not in (P2)', async () => {
    prisma.user.findUnique.mockResolvedValue(superAdminTarget);

    await expect(
      service.updateRole('other-boss', Role.USER, support),
    ).rejects.toThrow(
      'Only a Super Admin can create or change a Super Admin account.',
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('F2: refuses to hand out a role whose permissions the actor lacks (P1)', async () => {
    await expect(
      service.updateRole('user-1', Role.ADMIN, support),
    ).rejects.toThrow(/You cannot grant permissions you do not have yourself/);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('F7: runs the last-Super-Admin guard this endpoint used to bypass', async () => {
    prisma.user.findUnique.mockResolvedValue(superAdminTarget);
    prisma.user.count.mockResolvedValue(0);

    await expect(
      service.updateRole('other-boss', Role.ADMIN, actor),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('F7: allows the demotion once another active Super Admin remains', async () => {
    prisma.user.findUnique.mockResolvedValue(superAdminTarget);
    prisma.user.count.mockResolvedValue(1);

    await service.updateRole('other-boss', Role.ADMIN, actor);

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'other-boss' },
      data: { role: Role.ADMIN, appRoleId: 'role-admin' },
    });
  });

  it('F8: refuses to move the last roles manager off their role', async () => {
    prisma.user.findUnique.mockResolvedValue({
      ...targetUser,
      id: 'rm-1',
      role: Role.ADMIN,
      appRoleId: 'role-rolemgr',
    });
    prisma.appRole.findMany.mockResolvedValue([
      { id: 'role-rolemgr', key: 'ROLE_MANAGER', isSystem: false },
    ]);
    prisma.user.count.mockResolvedValue(0);

    await expect(
      service.updateRole('rm-1', Role.CONTENT_UPLOADER, actor),
    ).rejects.toThrow(/last account that can manage roles/);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('still lets a Super Admin change an ordinary account, moving both axes', async () => {
    await service.updateRole('user-1', Role.CONTENT_UPLOADER, actor);

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { role: Role.CONTENT_UPLOADER, appRoleId: 'role-uploader' },
    });
  });

  it('still lets a limited actor hand out a role they fully hold', async () => {
    await service.updateRole('user-1', Role.USER, support);

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { role: Role.USER, appRoleId: 'role-user' },
    });
  });

  it('F-004: refuses to demote an ADMIN account when the actor does not hold what it loses', async () => {
    prisma.user.findUnique.mockResolvedValue({
      ...targetUser,
      role: Role.ADMIN,
      appRoleId: 'role-admin',
    });

    // USER holds nothing, so the grant side passes; what the account LOSES
    // (the whole seeded Admin set) is what the support role never held.
    await expect(
      service.updateRole('user-1', Role.USER, support),
    ).rejects.toThrow(/You cannot remove permissions/);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  describe('H-21 / H-16: role changes', () => {
    it('signs the account out everywhere when its role changes', async () => {
      await service.updateRole('user-1', Role.CONTENT_UPLOADER, actor);

      expect(sessions.revokeAllAndDisconnect).toHaveBeenCalledWith('user-1');
    });

    it('leaves the sessions alone when nothing actually changed', async () => {
      await service.updateRole('user-1', Role.USER, support);

      expect(sessions.revokeAllAndDisconnect).not.toHaveBeenCalled();
    });

    it('refuses to touch a closed (self-deleted) account', async () => {
      prisma.user.findUnique.mockResolvedValue({
        ...targetUser,
        status: UserStatus.CLOSED,
      });

      await expect(
        service.updateRole('user-1', Role.CONTENT_UPLOADER, actor),
      ).rejects.toThrow(
        new ConflictException(
          'This account was closed by its owner and cannot be changed.',
        ),
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(sessions.revokeAllAndDisconnect).not.toHaveBeenCalled();
    });
  });

  /**
   * PATCH /users/:id/status ran with USERS.SUSPEND alone and no checks at all
   * — F-001: a small custom role could suspend a Super Admin (even the last
   * one) or itself. It now runs the staff route's status-change gate, and a
   * staff-tier target additionally needs STAFF.EDIT.
   */
  describe('UsersService — updateStatus guards (F-001)', () => {
    it('refuses to change your own status', async () => {
      await expect(
        service.updateStatus('support-1', UserStatus.SUSPENDED, support),
      ).rejects.toThrow('You cannot deactivate your own account.');
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('refuses a Super Admin suspending themselves too — the rule is about the actor', async () => {
      await expect(
        service.updateStatus('boss-1', UserStatus.SUSPENDED, actor),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('refuses to suspend a Super Admin without holding the role (P2)', async () => {
      prisma.user.findUnique.mockResolvedValue(superAdminTarget);

      await expect(
        service.updateStatus('other-boss', UserStatus.SUSPENDED, support),
      ).rejects.toThrow(/Only a Super Admin/);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('refuses to re-activate a Super Admin without holding the role — direction-independent', async () => {
      prisma.user.findUnique.mockResolvedValue(superAdminTarget);

      await expect(
        service.updateStatus('other-boss', UserStatus.ACTIVE, support),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('runs the last-Super-Admin guard this endpoint used to bypass', async () => {
      prisma.user.findUnique.mockResolvedValue(superAdminTarget);
      prisma.user.count.mockResolvedValue(0);

      await expect(
        service.updateStatus('other-boss', UserStatus.SUSPENDED, actor),
      ).rejects.toThrow('At least one active Super Admin must remain.');
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('allows the suspend once another active Super Admin remains, and audits it', async () => {
      prisma.user.findUnique.mockResolvedValue(superAdminTarget);
      prisma.user.update.mockResolvedValue({
        ...superAdminTarget,
        status: UserStatus.SUSPENDED,
      });
      prisma.user.count.mockResolvedValue(1);

      await service.updateStatus('other-boss', UserStatus.SUSPENDED, actor);

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'other-boss' },
        data: { status: UserStatus.SUSPENDED },
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'user.status_change' }),
      );
    });

    it('treats BANNED as a deactivation for the lockout guard', async () => {
      prisma.user.findUnique.mockResolvedValue(superAdminTarget);
      prisma.user.count.mockResolvedValue(0);

      await expect(
        service.updateStatus('other-boss', UserStatus.BANNED, actor),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('F8: refuses to suspend the last account that can manage roles', async () => {
      prisma.user.findUnique.mockResolvedValue({
        ...targetUser,
        id: 'rm-1',
        role: Role.ADMIN,
        appRoleId: 'role-rolemgr',
      });
      prisma.appRole.findMany.mockResolvedValue([
        { id: 'role-rolemgr', key: 'ROLE_MANAGER', isSystem: false },
      ]);
      prisma.user.count.mockResolvedValue(0);

      await expect(
        service.updateStatus('rm-1', UserStatus.SUSPENDED, actor),
      ).rejects.toThrow(/last account that can manage roles/);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('still lets a limited actor suspend an ordinary subscriber', async () => {
      prisma.user.update.mockResolvedValue({
        ...targetUser,
        status: UserStatus.SUSPENDED,
      });

      await service.updateStatus('user-1', UserStatus.SUSPENDED, support);

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { status: UserStatus.SUSPENDED },
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'user.status_change' }),
      );
    });

    it('H-21: suspending or banning signs the account out everywhere', async () => {
      for (const status of [UserStatus.SUSPENDED, UserStatus.BANNED]) {
        prisma.user.update.mockResolvedValueOnce({ ...targetUser, status });
        await service.updateStatus('user-1', status, support);
      }

      expect(sessions.revokeAllAndDisconnect).toHaveBeenCalledTimes(2);
      expect(sessions.revokeAllAndDisconnect).toHaveBeenCalledWith('user-1');
    });

    it('H-21: re-activating revokes nothing', async () => {
      prisma.user.findUnique.mockResolvedValue({
        ...targetUser,
        status: UserStatus.SUSPENDED,
      });

      await service.updateStatus('user-1', UserStatus.ACTIVE, support);

      expect(sessions.revokeAllAndDisconnect).not.toHaveBeenCalled();
    });

    it('H-16: a closed account can never be re-activated', async () => {
      prisma.user.findUnique.mockResolvedValue({
        ...targetUser,
        status: UserStatus.CLOSED,
      });

      await expect(
        service.updateStatus('user-1', UserStatus.ACTIVE, actor),
      ).rejects.toThrow(
        'This account was closed by its owner and cannot be changed.',
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('refuses a USERS.SUSPEND-only actor touching a staff account — that is the Staff page', async () => {
      prisma.user.findUnique.mockResolvedValue({
        ...targetUser,
        id: 'staff-1',
        role: Role.CONTENT_UPLOADER,
        appRoleId: 'role-uploader',
      });

      await expect(
        service.updateStatus('staff-1', UserStatus.SUSPENDED, support),
      ).rejects.toThrow(/Staff accounts are managed/);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });
});

/**
 * The admin user list is how staff find a person. Phone signups get a
 * machine-generated username (`user_959…`) and set a real name in their
 * profile, so a search that only matched username/phone could not find them
 * by the name staff actually see on screen.
 */
describe('UsersService — findAll search', () => {
  let service: UsersService;
  let prisma: {
    user: { findMany: jest.Mock; count: jest.Mock };
    wallet: { findMany: jest.Mock };
    transaction: { groupBy: jest.Mock };
    userSubscription: { findMany: jest.Mock };
    $transaction: jest.Mock;
  };

  const blake = {
    id: 'user-1',
    username: 'user_95950495369',
    displayName: 'Blake',
    phone: '+95950495369',
    role: Role.USER,
    status: UserStatus.ACTIVE,
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    prisma = {
      user: {
        findMany: jest.fn().mockResolvedValue([blake]),
        count: jest.fn().mockResolvedValue(1),
      },
      wallet: { findMany: jest.fn().mockResolvedValue([]) },
      transaction: { groupBy: jest.fn().mockResolvedValue([]) },
      userSubscription: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn((arg: unknown) =>
        Promise.all(arg as Promise<unknown>[]),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        AuthorityService,
        { provide: PrismaService, useValue: prisma },
        { provide: MinioService, useValue: {} },
        // Avatar key builder — untouched by the role/status cases here, but
        // a constructor dependency of the service under test.
        StorageService,
        { provide: ConfigService, useValue: { get: () => undefined } },
        {
          provide: AuditService,
          useValue: {
            record: jest.fn().mockResolvedValue(undefined),
            invalidateActorCache: jest.fn(),
          },
        },
        {
          provide: PermissionResolverService,
          useValue: createRoleAwarePermissionResolver([]),
        },
        { provide: SessionRevocationService, useValue: makeSessions() },
      ],
    }).compile();

    service = module.get(UsersService);
  });

  it('reads both wallet totals for the page in ONE grouped query, with the same sums as the old two (bam-09)', async () => {
    prisma.user.findMany.mockResolvedValue([
      blake,
      { ...blake, id: 'user-2', username: 'john' },
      { ...blake, id: 'user-3', username: 'nobody' },
    ]);
    prisma.transaction.groupBy.mockResolvedValue([
      {
        userId: 'user-1',
        type: 'PURCHASE',
        _sum: { amount: new Prisma.Decimal('0.1') },
      },
      {
        userId: 'user-1',
        type: 'SUBSCRIPTION',
        _sum: { amount: new Prisma.Decimal('0.2') },
      },
      {
        userId: 'user-1',
        type: 'DEPOSIT',
        _sum: { amount: new Prisma.Decimal(50000) },
      },
      {
        userId: 'user-2',
        type: 'SUBSCRIPTION',
        _sum: { amount: new Prisma.Decimal(3000) },
      },
    ]);

    const { walletByUserId } = await service.findAll({});

    expect(prisma.transaction.groupBy).toHaveBeenCalledTimes(1);
    expect(prisma.transaction.groupBy).toHaveBeenCalledWith({
      by: ['userId', 'type'],
      where: {
        userId: { in: ['user-1', 'user-2', 'user-3'] },
        type: { in: ['PURCHASE', 'SUBSCRIPTION', 'DEPOSIT'] },
        status: 'COMPLETED',
      },
      _sum: { amount: true },
    });
    // Added as Decimals, so 0.1 + 0.2 is exactly 0.3 — what one SQL SUM
    // over both types returned (plain number addition would give
    // 0.30000000000000004).
    expect(walletByUserId.get('user-1')).toMatchObject({
      totalSpent: 0.3,
      totalDeposited: 50000,
    });
    expect(walletByUserId.get('user-2')).toMatchObject({
      totalSpent: 3000,
      totalDeposited: 0,
    });
    expect(walletByUserId.get('user-3')).toMatchObject({
      totalSpent: 0,
      totalDeposited: 0,
    });
  });

  it('matches the display name case-insensitively, alongside username and phone', async () => {
    await service.findAll({ search: 'blake' });

    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          role: Role.USER,
          OR: [
            { username: { contains: 'blake', mode: 'insensitive' } },
            { displayName: { contains: 'blake', mode: 'insensitive' } },
            { phone: { contains: 'blake' } },
          ],
        },
      }),
    );
  });

  it('applies the same OR to the count, so the pagination total agrees with the page', async () => {
    await service.findAll({ search: 'Blake' });

    expect(prisma.user.count).toHaveBeenCalledWith({
      where: {
        role: Role.USER,
        OR: [
          { username: { contains: 'Blake', mode: 'insensitive' } },
          { displayName: { contains: 'Blake', mode: 'insensitive' } },
          { phone: { contains: 'Blake' } },
        ],
      },
    });
  });

  it('returns the row with displayName intact next to the raw username', async () => {
    const result = await service.findAll({ search: 'Blake' });

    expect(result.items[0]).toMatchObject({
      username: 'user_95950495369',
      displayName: 'Blake',
    });
  });

  it('leaves the where clause search-free when no term is given', async () => {
    await service.findAll({});

    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { role: Role.USER } }),
    );
  });
});

/**
 * The per-user avatar folder exists so an account delete has something to
 * sweep: with the flat key this replaced, only the CURRENT avatar was ever
 * reachable and every replaced one leaked forever.
 */
describe('UsersService — avatar object cleanup', () => {
  let service: UsersService;
  let minio: { deleteByPrefix: jest.Mock };

  const USER_ID = 'a3c9d7f0-1111-2222-3333-444455556666';

  beforeEach(async () => {
    jest.clearAllMocks();
    minio = { deleteByPrefix: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        AuthorityService,
        { provide: PrismaService, useValue: {} },
        { provide: MinioService, useValue: minio },
        StorageService,
        { provide: ConfigService, useValue: { get: () => undefined } },
        {
          provide: AuditService,
          useValue: {
            record: jest.fn().mockResolvedValue(undefined),
            invalidateActorCache: jest.fn(),
          },
        },
        {
          provide: PermissionResolverService,
          useValue: createRoleAwarePermissionResolver([]),
        },
        { provide: SessionRevocationService, useValue: makeSessions() },
      ],
    }).compile();

    service = module.get(UsersService);
  });

  it('deletes every picture the user ever uploaded with one prefix sweep of their own folder', async () => {
    await service.deleteAvatarObjects(USER_ID);

    expect(minio.deleteByPrefix).toHaveBeenCalledWith(
      `images/user/${USER_ID}/`,
    );
  });

  it('swallows a storage failure — the account delete must not fail over orphaned bytes', async () => {
    minio.deleteByPrefix.mockRejectedValue(new Error('minio down'));

    await expect(service.deleteAvatarObjects(USER_ID)).resolves.toBeUndefined();
  });
});

/**
 * PATCH /users/me/password is shared by end users (mobile, website) and by
 * staff (admin navbar dialog / Settings). A staff member's self-change must
 * land in the audit log as `staff.password_change`; the end-user skip lives
 * in AuditService (role USER) and is covered by its own spec. Nothing
 * password-related — plain or hashed — may ever be recorded.
 */
describe('UsersService — changePassword audit', () => {
  let service: UsersService;
  let prisma: {
    user: { findUnique: jest.Mock; update: jest.Mock };
    $transaction: jest.Mock;
  };
  let audit: { record: jest.Mock; invalidateActorCache: jest.Mock };
  let sessions: ReturnType<typeof makeSessions>;

  const CURRENT_PASSWORD = 'current-password';
  const NEW_PASSWORD = 'brand-new-password';
  // Real bcrypt, as users.controller.spec does — 4 rounds keeps it fast; the
  // cost factor itself is not under test here.
  const CURRENT_PASSWORD_HASH = bcrypt.hashSync(CURRENT_PASSWORD, 4);

  const staffRow = {
    id: 'staff-1',
    username: 'editor',
    password: CURRENT_PASSWORD_HASH,
    role: Role.ADMIN,
    appRoleId: 'role-admin',
    status: UserStatus.ACTIVE,
  };

  const staffActor: AuthenticatedUser = {
    id: 'staff-1',
    username: 'editor',
    role: Role.ADMIN,
    appRoleId: 'role-admin',
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue(staffRow),
        update: jest.fn().mockResolvedValue(staffRow),
      },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(
      (run: (tx: typeof prisma) => Promise<unknown>) => run(prisma),
    );
    sessions = makeSessions();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        AuthorityService,
        { provide: PrismaService, useValue: prisma },
        { provide: MinioService, useValue: {} },
        StorageService,
        { provide: ConfigService, useValue: { get: () => undefined } },
        {
          provide: AuditService,
          useValue: {
            record: jest.fn().mockResolvedValue(undefined),
            invalidateActorCache: jest.fn(),
          },
        },
        {
          provide: PermissionResolverService,
          useValue: createRoleAwarePermissionResolver([]),
        },
        { provide: SessionRevocationService, useValue: sessions },
      ],
    }).compile();

    service = module.get(UsersService);
    audit = module.get(AuditService);
  });

  it('staff actor + correct current password: stores a bcrypt hash and records staff.password_change with no values', async () => {
    await service.changePassword(
      'staff-1',
      CURRENT_PASSWORD,
      NEW_PASSWORD,
      staffActor,
    );

    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    const { where, data } = prisma.user.update.mock.calls[0][0] as {
      where: { id: string };
      data: { password: string };
    };
    expect(where).toEqual({ id: 'staff-1' });
    // Hashed, never the plain text — and it verifies against the new password.
    expect(data.password).not.toBe(NEW_PASSWORD);
    expect(await bcrypt.compare(NEW_PASSWORD, data.password)).toBe(true);

    expect(audit.record).toHaveBeenCalledTimes(1);
    const recorded = audit.record.mock.calls[0][0] as Record<string, unknown>;
    expect(recorded).toEqual({
      action: 'staff.password_change',
      actor: staffActor,
      target: { type: 'staff', id: 'staff-1', label: '@editor' },
    });
    // Pure event: not even an explicit-undefined before/after/metadata key.
    expect(Object.keys(recorded).sort()).toEqual(['action', 'actor', 'target']);
    const serialized = JSON.stringify(recorded);
    expect(serialized).not.toContain(NEW_PASSWORD);
    expect(serialized).not.toContain(CURRENT_PASSWORD);
    expect(serialized).not.toContain(data.password);
  });

  it("H-21: signs out every OTHER session in the same transaction, keeping the caller's own", async () => {
    await service.changePassword('staff-1', CURRENT_PASSWORD, NEW_PASSWORD, {
      ...staffActor,
      sessionId: 'rt-mine',
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(sessions.revokeAll).toHaveBeenCalledWith('staff-1', {
      exceptSessionId: 'rt-mine',
      client: prisma,
    });
    // Kicked only after the transaction committed.
    expect(sessions.disconnectUser).toHaveBeenCalledWith('staff-1');
    expect(sessions.revokeAll.mock.invocationCallOrder[0]).toBeLessThan(
      sessions.disconnectUser.mock.invocationCallOrder[0],
    );
  });

  it('H-21: with no session id to keep (an old token), every session goes', async () => {
    await service.changePassword(
      'staff-1',
      CURRENT_PASSWORD,
      NEW_PASSWORD,
      staffActor,
    );

    expect(sessions.revokeAll).toHaveBeenCalledWith('staff-1', {
      exceptSessionId: undefined,
      client: prisma,
    });
  });

  it('no actor: changes the password but records nothing', async () => {
    await service.changePassword('staff-1', CURRENT_PASSWORD, NEW_PASSWORD);

    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('wrong current password: throws BadRequestException before any write or audit call', async () => {
    const attempt = service.changePassword(
      'staff-1',
      'not-my-password',
      NEW_PASSWORD,
      staffActor,
    );

    await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
    await expect(attempt).rejects.toThrow('Your current password is incorrect');
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(sessions.revokeAll).not.toHaveBeenCalled();
    expect(sessions.disconnectUser).not.toHaveBeenCalled();
  });
});

/**
 * H-16: DELETE /users/me. The owner default: refused while money is in the
 * wallet or a deposit/withdrawal is pending; otherwise personal data is
 * anonymised, the account is CLOSED, every session is revoked and every
 * money record is kept (nothing is deleted).
 */
describe('UsersService — deleteOwnAccount (H-16)', () => {
  let service: UsersService;
  let tx: {
    $queryRaw: jest.Mock;
    wallet: { findUnique: jest.Mock };
    deposit: { findFirst: jest.Mock };
    withdrawal: { findFirst: jest.Mock };
    user: { update: jest.Mock; delete: jest.Mock };
    otpCode: { deleteMany: jest.Mock };
    smsMessage: { updateMany: jest.Mock };
    userSession: { updateMany: jest.Mock };
    comment: { updateMany: jest.Mock };
    feedback: { updateMany: jest.Mock };
    searchQuery: { updateMany: jest.Mock };
  };
  let prisma: {
    user: { findUnique: jest.Mock };
    $transaction: jest.Mock;
  };
  let audit: {
    record: jest.Mock;
    invalidateActorCache: jest.Mock;
    anonymiseUser: jest.Mock;
  };
  let sessions: ReturnType<typeof makeSessions>;
  let minio: { deleteByPrefix: jest.Mock };

  const USER_ID = 'a3c9d7f0-1111-2222-3333-444455556666';
  const CLOSED_USERNAME = 'deleted_a3c9d7f0111122223333444455556666';

  const owner = {
    id: USER_ID,
    username: 'user_959123456789',
    password: 'hash',
    phone: '+959123456789',
    email: null,
    googleId: null,
    displayName: 'Ko Ko',
    avatar: `images/user/${USER_ID}/1.jpg`,
    role: Role.USER,
    appRoleId: 'role-user',
    status: UserStatus.ACTIVE,
  };

  const caller: AuthenticatedUser = {
    id: USER_ID,
    username: 'user_959123456789',
    role: Role.USER,
    appRoleId: 'role-user',
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: USER_ID }]),
      wallet: {
        findUnique: jest.fn().mockResolvedValue({ balance: 0 }),
      },
      deposit: { findFirst: jest.fn().mockResolvedValue(null) },
      withdrawal: { findFirst: jest.fn().mockResolvedValue(null) },
      user: { update: jest.fn().mockResolvedValue({}), delete: jest.fn() },
      otpCode: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
      smsMessage: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      userSession: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      comment: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      feedback: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      searchQuery: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(owner) },
      $transaction: jest.fn((run: (client: typeof tx) => Promise<unknown>) =>
        run(tx),
      ),
    };
    audit = {
      record: jest.fn().mockResolvedValue(undefined),
      invalidateActorCache: jest.fn(),
      anonymiseUser: jest.fn().mockResolvedValue(undefined),
    };
    sessions = makeSessions();
    minio = { deleteByPrefix: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        AuthorityService,
        { provide: PrismaService, useValue: prisma },
        { provide: MinioService, useValue: minio },
        StorageService,
        { provide: ConfigService, useValue: { get: () => undefined } },
        { provide: AuditService, useValue: audit },
        {
          provide: PermissionResolverService,
          useValue: createRoleAwarePermissionResolver([]),
        },
        { provide: SessionRevocationService, useValue: sessions },
      ],
    }).compile();

    service = module.get(UsersService);
  });

  it('anonymises the account, closes it and revokes every session — never deleting a row', async () => {
    await service.deleteOwnAccount(caller);

    const [{ where, data }] = tx.user.update.mock.calls[0] as [
      { where: { id: string }; data: Record<string, unknown> },
    ];
    expect(where).toEqual({ id: USER_ID });
    expect(data).toEqual({
      username: CLOSED_USERNAME,
      password: expect.any(String),
      phone: null,
      email: null,
      googleId: null,
      displayName: null,
      avatar: null,
      lastIpAddress: null,
      withdrawalCodeHash: null,
      withdrawalCodeSetAt: null,
      withdrawalCodeFailedCount: 0,
      withdrawalCodeLockedUntil: null,
      status: UserStatus.CLOSED,
    });
    // The stored password is a hash of nothing anyone knows.
    expect(data.password).not.toBe(owner.password);
    await expect(bcrypt.compare('', data.password as string)).resolves.toBe(
      false,
    );

    expect(sessions.revokeAll).toHaveBeenCalledWith(USER_ID, { client: tx });
    expect(tx.user.delete).not.toHaveBeenCalled();
  });

  it('scrubs the traces that identify the person: codes sent to the phone, and IP addresses', async () => {
    await service.deleteOwnAccount(caller);

    expect(tx.otpCode.deleteMany).toHaveBeenCalledWith({
      where: { phone: owner.phone },
    });
    expect(tx.userSession.updateMany).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      data: { ipAddress: null, userAgent: null },
    });
    for (const table of [tx.comment, tx.feedback, tx.searchQuery]) {
      expect(table.updateMany).toHaveBeenCalledWith({
        where: { userId: USER_ID },
        data: { ipAddress: null },
      });
    }
    expect(audit.anonymiseUser).toHaveBeenCalledWith(
      {
        userId: USER_ID,
        previousUsername: owner.username,
        username: CLOSED_USERNAME,
      },
      tx,
    );
  });

  it('B4: cancels the QUEUED SMS to that phone and redacts its number and body from sms_messages, inside the transaction', async () => {
    await service.deleteOwnAccount(caller);

    expect(tx.smsMessage.updateMany).toHaveBeenNthCalledWith(1, {
      where: { phone: owner.phone, status: SmsMessageStatus.QUEUED },
      data: { status: SmsMessageStatus.CANCELLED },
    });
    expect(tx.smsMessage.updateMany).toHaveBeenNthCalledWith(2, {
      where: { phone: owner.phone },
      data: {
        phone: SMS_REDACTED,
        body: SMS_REDACTED,
        redactedAt: expect.any(Date),
      },
    });
  });

  it('B4: an account without a phone has no SMS to redact', async () => {
    prisma.user.findUnique.mockResolvedValue({ ...owner, phone: null });

    await service.deleteOwnAccount(caller);

    expect(tx.smsMessage.updateMany).not.toHaveBeenCalled();
  });

  it('records user.account_delete with the owner as actor, under the anonymised name, inside the transaction', async () => {
    await service.deleteOwnAccount(caller);

    expect(audit.record).toHaveBeenCalledWith({
      action: 'user.account_delete',
      actor: { ...caller, username: CLOSED_USERNAME },
      target: { type: 'user', id: USER_ID, label: `@${CLOSED_USERNAME}` },
      force: true,
      tx,
    });
    // Nothing that names the person reaches the new row.
    expect(JSON.stringify(audit.record.mock.calls[0][0])).not.toMatch(
      /959123456789|Ko Ko/,
    );
  });

  it('B4: writes user.account_delete BEFORE anonymising, so the scrub also takes the IP address and user agent of the deletion request itself', async () => {
    await service.deleteOwnAccount(caller);

    expect(audit.record.mock.invocationCallOrder[0]).toBeLessThan(
      audit.anonymiseUser.mock.invocationCallOrder[0],
    );
  });

  it('kicks every socket and sweeps the avatar folder only after the commit', async () => {
    await service.deleteOwnAccount(caller);

    expect(sessions.disconnectUser).toHaveBeenCalledWith(USER_ID);
    expect(minio.deleteByPrefix).toHaveBeenCalledWith(
      `images/user/${USER_ID}/`,
    );
    expect(audit.invalidateActorCache).toHaveBeenCalledWith(USER_ID);
  });

  it('locks the account row first, so a payment in flight is seen by the checks below', async () => {
    await service.deleteOwnAccount(caller);

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.wallet.findUnique.mock.invocationCallOrder[0],
    );
  });

  describe('refusals (409) — nothing is written', () => {
    function expectNothingWritten() {
      expect(tx.user.update).not.toHaveBeenCalled();
      expect(sessions.revokeAll).not.toHaveBeenCalled();
      expect(sessions.disconnectUser).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(audit.anonymiseUser).not.toHaveBeenCalled();
      expect(minio.deleteByPrefix).not.toHaveBeenCalled();
    }

    it('while the wallet still holds money', async () => {
      tx.wallet.findUnique.mockResolvedValue({ balance: 500 });

      await expect(service.deleteOwnAccount(caller)).rejects.toThrow(
        new ConflictException(
          'Your wallet still has money in it. Withdraw or spend it before deleting your account.',
        ),
      );
      expectNothingWritten();
    });

    it('while a deposit waits for review', async () => {
      tx.deposit.findFirst.mockResolvedValue({ id: 'dep-1' });

      await expect(service.deleteOwnAccount(caller)).rejects.toThrow(
        new ConflictException(
          'You have a deposit waiting for review. Wait until it is approved or rejected before deleting your account.',
        ),
      );
      expect(tx.deposit.findFirst).toHaveBeenCalledWith({
        where: { userId: USER_ID, status: 'PENDING' },
        select: { id: true },
      });
      expectNothingWritten();
    });

    it('while a withdrawal waits for review', async () => {
      tx.withdrawal.findFirst.mockResolvedValue({ id: 'wd-1' });

      await expect(service.deleteOwnAccount(caller)).rejects.toThrow(
        new ConflictException(
          'You have a withdrawal waiting for review. Wait until it is approved or rejected before deleting your account.',
        ),
      );
      expectNothingWritten();
    });

    it('for a staff account (403) — staff are managed from the Staff page', async () => {
      prisma.user.findUnique.mockResolvedValue({
        ...owner,
        role: Role.ADMIN,
      });

      await expect(
        service.deleteOwnAccount({ ...caller, role: Role.ADMIN }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });
});

describe('walletTotalsFromTypeSums (bam-09)', () => {
  const sum = (value: string | null) => ({
    amount: value === null ? null : new Prisma.Decimal(value),
  });

  it('adds PURCHASE and SUBSCRIPTION into "spent" and keeps DEPOSIT apart', () => {
    expect(
      walletTotalsFromTypeSums([
        { type: 'PURCHASE', _sum: sum('1500') },
        { type: 'SUBSCRIPTION', _sum: sum('3000.50') },
        { type: 'DEPOSIT', _sum: sum('10000') },
      ]),
    ).toEqual({ totalSpent: 4500.5, totalDeposited: 10000 });
  });

  it('gives 0 for a total with no rows or a NULL sum, as the old aggregates did', () => {
    expect(walletTotalsFromTypeSums([])).toEqual({
      totalSpent: 0,
      totalDeposited: 0,
    });
    expect(
      walletTotalsFromTypeSums([{ type: 'DEPOSIT', _sum: sum(null) }]),
    ).toEqual({ totalSpent: 0, totalDeposited: 0 });
  });

  it('ignores any other type, should one ever be grouped', () => {
    expect(
      walletTotalsFromTypeSums([
        { type: 'REFUND', _sum: sum('999') },
        { type: 'WITHDRAWAL', _sum: sum('999') },
      ]),
    ).toEqual({ totalSpent: 0, totalDeposited: 0 });
  });
});

describe('UsersService.findAuthSubject (be-cat-16 / db-14)', () => {
  it('reads only the columns an authentication check needs — never the password or withdrawal-code hash', async () => {
    const row = {
      id: 'user-1',
      username: 'blake',
      role: Role.USER,
      appRoleId: null,
      status: UserStatus.ACTIVE,
      sessionsRevokedAt: null,
    };
    const prisma = { user: { findUnique: jest.fn().mockResolvedValue(row) } };
    const service = new UsersService(
      prisma as unknown as PrismaService,
      {} as MinioService,
      {} as StorageService,
      {} as AuthorityService,
      {} as AuditService,
      {} as SessionRevocationService,
    );

    await expect(service.findAuthSubject('user-1')).resolves.toBe(row);
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      select: {
        id: true,
        username: true,
        role: true,
        appRoleId: true,
        status: true,
        sessionsRevokedAt: true,
      },
    });
  });
});
