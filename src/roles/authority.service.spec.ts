import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Role, UserStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  createRoleAwarePermissionResolver,
  seededRoleRow,
} from '../../test/seeded-permission-resolver';
import { AuthorityService } from './authority.service';
import { PermissionResolverService } from './permission-resolver.service';

/**
 * The status-change gate in isolation (F-001). The route-level specs
 * (staff.service.spec.ts, users.service.spec.ts) prove it is wired in; this
 * one pins the rules themselves, including which of them run for which
 * direction of change.
 */
describe('AuthorityService — assertCanChangeStatus', () => {
  let service: AuthorityService;
  let prisma: {
    user: { count: jest.Mock };
    appRole: { findMany: jest.Mock };
  };

  const superAdmin = {
    id: 'boss-1',
    role: Role.SUPER_ADMIN,
    appRoleId: 'role-super',
  };
  const otherSuperAdmin = {
    id: 'boss-2',
    role: Role.SUPER_ADMIN,
    appRoleId: 'role-super',
  };
  /** USERS.SUSPEND and nothing else — the shape the report escalated with. */
  const support = {
    id: 'support-1',
    role: Role.ADMIN,
    appRoleId: 'role-support',
  };
  const subscriber = { id: 'user-1', role: Role.USER, appRoleId: null };

  beforeEach(async () => {
    prisma = {
      user: { count: jest.fn().mockResolvedValue(1) },
      appRole: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: 'role-super', key: Role.SUPER_ADMIN, isSystem: true },
          ]),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthorityService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: PermissionResolverService,
          useValue: createRoleAwarePermissionResolver([
            seededRoleRow(Role.SUPER_ADMIN, 'role-super'),
            seededRoleRow(Role.ADMIN, 'role-admin'),
            seededRoleRow(Role.USER, 'role-user'),
            {
              id: 'role-support',
              key: 'USER_SUPPORT',
              permissions: ['USERS.VIEW', 'USERS.SUSPEND'],
            },
          ]),
        },
      ],
    }).compile();

    service = module.get(AuthorityService);
  });

  it('refuses to change your own status (403), whatever the tier', async () => {
    await expect(
      service.assertCanChangeStatus(support, support, UserStatus.SUSPENDED),
    ).rejects.toThrow(
      new ForbiddenException('You cannot deactivate your own account.'),
    );
    await expect(
      service.assertCanChangeStatus(superAdmin, superAdmin, UserStatus.ACTIVE),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses a non-Super-Admin touching a Super Admin-tier target (P2), in either direction', async () => {
    await expect(
      service.assertCanChangeStatus(support, superAdmin, UserStatus.SUSPENDED),
    ).rejects.toThrow(/Only a Super Admin/);
    await expect(
      service.assertCanChangeStatus(support, superAdmin, UserStatus.ACTIVE),
    ).rejects.toThrow(/Only a Super Admin/);
    expect(prisma.user.count).not.toHaveBeenCalled();
  });

  it('runs both lockout guards on SUSPENDED', async () => {
    await service.assertCanChangeStatus(
      superAdmin,
      otherSuperAdmin,
      UserStatus.SUSPENDED,
    );

    // Once for the last-Super-Admin count, once for the last-roles-manager count.
    expect(prisma.user.count).toHaveBeenCalledTimes(2);
    expect(prisma.user.count).toHaveBeenCalledWith({
      where: {
        status: UserStatus.ACTIVE,
        NOT: { id: 'boss-2' },
        OR: [
          { appRoleId: { in: ['role-super'] } },
          { appRoleId: null, role: Role.SUPER_ADMIN },
        ],
      },
    });
  });

  it('runs the lockout guards on BANNED too — any move away from ACTIVE', async () => {
    prisma.user.count.mockResolvedValue(0);

    await expect(
      service.assertCanChangeStatus(
        superAdmin,
        otherSuperAdmin,
        UserStatus.BANNED,
      ),
    ).rejects.toThrow(
      new ConflictException('At least one active Super Admin must remain.'),
    );
  });

  it('skips the lockout guards when re-activating', async () => {
    prisma.user.count.mockResolvedValue(0);

    await service.assertCanChangeStatus(
      superAdmin,
      otherSuperAdmin,
      UserStatus.ACTIVE,
    );

    expect(prisma.user.count).not.toHaveBeenCalled();
  });

  it('lets a limited actor suspend an ordinary subscriber', async () => {
    await expect(
      service.assertCanChangeStatus(support, subscriber, UserStatus.SUSPENDED),
    ).resolves.toBeUndefined();
    // A subscriber is neither a Super Admin nor a roles manager, so no count.
    expect(prisma.user.count).not.toHaveBeenCalled();
  });
});
