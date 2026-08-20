import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Role, UserStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/storage/minio.service';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { AuthorityService } from '../roles/authority.service';
import { PermissionResolverService } from '../roles/permission-resolver.service';
import {
  createRoleAwarePermissionResolver,
  seededRoleRow,
} from '../../test/seeded-permission-resolver';
import { UsersService } from './users.service';

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
        { provide: PermissionResolverService, useValue: resolver },
      ],
    }).compile();

    service = module.get(UsersService);
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
        {
          provide: PermissionResolverService,
          useValue: createRoleAwarePermissionResolver([]),
        },
      ],
    }).compile();

    service = module.get(UsersService);
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
