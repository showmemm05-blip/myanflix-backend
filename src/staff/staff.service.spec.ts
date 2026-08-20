import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Role, UserStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { AuthorityService } from '../roles/authority.service';
import { PermissionResolverService } from '../roles/permission-resolver.service';
import {
  createRoleAwarePermissionResolver,
  seededRoleRow,
} from '../../test/seeded-permission-resolver';
import { StaffService } from './staff.service';

/**
 * Focused on the RBAC assignment rules — the two axes (`role` enum and
 * `appRoleId`) must never drift apart, because everything outside RBAC still
 * reads the enum while every permission check reads the AppRole.
 */
describe('StaffService — role assignment', () => {
  let service: StaffService;
  let prisma: {
    user: { findUnique: jest.Mock; update: jest.Mock; count: jest.Mock };
    appRole: { findUnique: jest.Mock };
  };
  let usersService: {
    findByUsername: jest.Mock;
    findByIdOrThrow: jest.Mock;
    create: jest.Mock;
  };
  let resolver: ReturnType<typeof createRoleAwarePermissionResolver>;

  const actor: AuthenticatedUser = {
    id: 'boss-1',
    username: 'boss',
    role: Role.SUPER_ADMIN,
    appRoleId: 'role-super',
  };

  /**
   * A custom-role actor with the whole STAFF module and nothing else — the
   * exact shape the audit used to escalate with (STAFF.CREATE/EDIT/DELETE but
   * no ROLES.*, no USERS.*, and above all not the protected role).
   */
  const staffManager: AuthenticatedUser = {
    id: 'sm-1',
    username: 'staffmgr',
    role: Role.ADMIN,
    appRoleId: 'role-staffmgr',
  };

  const staffRow = {
    id: 'staff-1',
    username: 'editor',
    role: Role.CONTENT_UPLOADER,
    appRoleId: 'role-uploader',
    status: UserStatus.ACTIVE,
    lastLoginAt: null,
    createdAt: new Date('2026-01-01'),
    appRole: {
      id: 'role-uploader',
      key: Role.CONTENT_UPLOADER,
      name: 'Content Uploader',
    },
  };

  const APP_ROLES: Record<string, { id: string; key: string }> = {
    'role-super': { id: 'role-super', key: Role.SUPER_ADMIN },
    'role-admin': { id: 'role-admin', key: Role.ADMIN },
    'role-uploader': { id: 'role-uploader', key: Role.CONTENT_UPLOADER },
    'role-user': { id: 'role-user', key: Role.USER },
    'role-custom': { id: 'role-custom', key: 'MOVIE_MANAGER' },
    'role-staffmgr': { id: 'role-staffmgr', key: 'STAFF_MANAGER' },
    'role-rolemgr': { id: 'role-rolemgr', key: 'ROLE_MANAGER' },
  };

  /** A Super Admin by AppRole, whatever the legacy enum happens to say. */
  const superAdminRow = {
    ...staffRow,
    id: 'staff-1',
    role: Role.SUPER_ADMIN,
    appRoleId: 'role-super',
    appRole: { id: 'role-super', key: Role.SUPER_ADMIN, name: 'Super Admin' },
  };

  beforeEach(async () => {
    prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue(staffRow),
        update: jest.fn().mockResolvedValue(staffRow),
        delete: jest.fn().mockResolvedValue(staffRow),
        count: jest.fn().mockResolvedValue(1),
      },
      appRole: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: 'role-super', key: Role.SUPER_ADMIN, isSystem: true },
          ]),
        findUnique: jest.fn(({ where }: { where: Record<string, string> }) => {
          if (where.id) return Promise.resolve(APP_ROLES[where.id] ?? null);
          const byKey = Object.values(APP_ROLES).find(
            (role) => role.key === where.key,
          );
          return Promise.resolve(byKey ?? null);
        }),
      },
    };
    usersService = {
      findByUsername: jest.fn().mockResolvedValue(null),
      findByIdOrThrow: jest.fn().mockResolvedValue(staffRow),
      create: jest.fn().mockResolvedValue({ id: 'staff-new' }),
    };
    resolver = createRoleAwarePermissionResolver([
      seededRoleRow(Role.SUPER_ADMIN, 'role-super'),
      seededRoleRow(Role.ADMIN, 'role-admin'),
      seededRoleRow(Role.CONTENT_UPLOADER, 'role-uploader'),
      seededRoleRow(Role.USER, 'role-user'),
      {
        id: 'role-custom',
        key: 'MOVIE_MANAGER',
        permissions: ['MOVIES.VIEW', 'MOVIES.CREATE'],
      },
      {
        id: 'role-staffmgr',
        key: 'STAFF_MANAGER',
        permissions: [
          'STAFF.VIEW',
          'STAFF.CREATE',
          'STAFF.EDIT',
          'STAFF.DELETE',
        ],
      },
      {
        id: 'role-rolemgr',
        key: 'ROLE_MANAGER',
        permissions: ['ROLES.VIEW', 'ROLES.EDIT'],
      },
    ]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StaffService,
        // The real AuthorityService: P1/P2 are what these cases are about.
        AuthorityService,
        { provide: PrismaService, useValue: prisma },
        { provide: UsersService, useValue: usersService },
        { provide: PermissionResolverService, useValue: resolver },
      ],
    }).compile();

    service = module.get(StaffService);
  });

  describe('create', () => {
    it('assigns the matching built-in AppRole when only the legacy enum is sent', async () => {
      await service.create(
        { username: 'newbie', password: 'password123', role: Role.ADMIN },
        actor,
      );

      expect(usersService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          username: 'newbie',
          role: Role.ADMIN,
          appRoleId: 'role-admin',
        }),
      );
    });

    it('derives the legacy enum from a built-in appRoleId', async () => {
      await service.create(
        {
          username: 'newbie',
          password: 'password123',
          role: Role.CONTENT_UPLOADER,
          appRoleId: 'role-admin',
        },
        actor,
      );

      expect(usersService.create).toHaveBeenCalledWith(
        expect.objectContaining({ role: Role.ADMIN, appRoleId: 'role-admin' }),
      );
    });

    it('keeps the requested enum tier when the appRoleId names a custom role', async () => {
      await service.create(
        {
          username: 'newbie',
          password: 'password123',
          role: Role.CONTENT_UPLOADER,
          appRoleId: 'role-custom',
        },
        actor,
      );

      expect(usersService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          role: Role.CONTENT_UPLOADER,
          appRoleId: 'role-custom',
        }),
      );
    });

    it('rejects an unknown appRoleId', async () => {
      await expect(
        service.create(
          {
            username: 'newbie',
            password: 'password123',
            role: Role.ADMIN,
            appRoleId: 'role-missing',
          },
          actor,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses to put a staff account on the end-user role', async () => {
      await expect(
        service.create(
          {
            username: 'newbie',
            password: 'password123',
            role: Role.ADMIN,
            appRoleId: 'role-user',
          },
          actor,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('F1: refuses to create a Super Admin without holding the Super Admin role (P2)', async () => {
      await expect(
        service.create(
          {
            username: 'backdoor',
            password: 'password123',
            role: Role.SUPER_ADMIN,
          },
          staffManager,
        ),
      ).rejects.toThrow(
        'Only a Super Admin can create or change a Super Admin account.',
      );
      expect(usersService.create).not.toHaveBeenCalled();
    });

    it('F1: refuses the same escalation dressed up as an appRoleId', async () => {
      await expect(
        service.create(
          {
            username: 'backdoor',
            password: 'password123',
            role: Role.ADMIN,
            appRoleId: 'role-super',
          },
          staffManager,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(usersService.create).not.toHaveBeenCalled();
    });

    it('F1: refuses to create staff on a role that exceeds the creator (P1)', async () => {
      await expect(
        service.create(
          {
            username: 'newbie',
            password: 'password123',
            role: Role.ADMIN,
          },
          staffManager,
        ),
      ).rejects.toThrow(
        /You cannot grant permissions you do not have yourself/,
      );
      expect(usersService.create).not.toHaveBeenCalled();
    });

    it('F1: still lets a Super Admin create a Super Admin', async () => {
      await service.create(
        {
          username: 'deputy',
          password: 'password123',
          role: Role.SUPER_ADMIN,
        },
        actor,
      );

      expect(usersService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          role: Role.SUPER_ADMIN,
          appRoleId: 'role-super',
        }),
      );
    });

    it('F1: still lets a limited creator hand out a role they fully hold', async () => {
      await service.create(
        {
          username: 'deputy',
          password: 'password123',
          role: Role.ADMIN,
          appRoleId: 'role-staffmgr',
        },
        staffManager,
      );

      expect(usersService.create).toHaveBeenCalledWith(
        expect.objectContaining({ appRoleId: 'role-staffmgr' }),
      );
    });
  });

  describe('updateStaffFields', () => {
    it('moves both axes when the legacy enum changes', async () => {
      await service.updateStaffFields('staff-1', { role: Role.ADMIN }, actor);

      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { role: Role.ADMIN, appRoleId: 'role-admin' },
        }),
      );
    });

    it('leaves the enum alone when assigning a custom role', async () => {
      await service.updateStaffFields(
        'staff-1',
        { appRoleId: 'role-custom' },
        actor,
      );

      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { role: Role.CONTENT_UPLOADER, appRoleId: 'role-custom' },
        }),
      );
    });

    it('moves the enum when assigning a built-in role', async () => {
      await service.updateStaffFields(
        'staff-1',
        { appRoleId: 'role-admin' },
        actor,
      );

      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { role: Role.ADMIN, appRoleId: 'role-admin' },
        }),
      );
    });

    it('touches neither axis when only the username changes', async () => {
      await service.updateStaffFields(
        'staff-1',
        { username: 'renamed' },
        actor,
      );

      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { username: 'renamed' } }),
      );
    });

    it('still refuses a self role change, including via appRoleId', async () => {
      await expect(
        service.updateStaffFields(
          'boss-1',
          { appRoleId: 'role-custom' },
          actor,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('still guards the last active Super Admin when demoting via appRoleId', async () => {
      prisma.user.findUnique.mockResolvedValue(superAdminRow);
      prisma.user.count.mockResolvedValue(0);

      await expect(
        service.updateStaffFields(
          'staff-1',
          { appRoleId: 'role-admin' },
          actor,
        ),
      ).rejects.toThrow('At least one active Super Admin must remain.');
    });

    it("F3: refuses to change a Super Admin's role without holding it (P2)", async () => {
      prisma.user.findUnique.mockResolvedValue(superAdminRow);

      await expect(
        service.updateStaffFields(
          'staff-1',
          { role: Role.ADMIN },
          staffManager,
        ),
      ).rejects.toThrow(
        'Only a Super Admin can create or change a Super Admin account.',
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('F1: refuses to promote anyone INTO the Super Admin tier without holding it (P2)', async () => {
      await expect(
        service.updateStaffFields(
          'staff-1',
          { role: Role.SUPER_ADMIN },
          staffManager,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('F6: guards the last Super Admin when the demotion is a custom AppRole that leaves the enum alone', async () => {
      prisma.user.findUnique.mockResolvedValue(superAdminRow);
      prisma.user.count.mockResolvedValue(0);

      // The enum stays SUPER_ADMIN (custom roles never move it), which is
      // exactly why the old enum-only guard never fired here.
      await expect(
        service.updateStaffFields(
          'staff-1',
          { appRoleId: 'role-custom' },
          actor,
        ),
      ).rejects.toThrow('At least one active Super Admin must remain.');
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('F6: counts remaining Super Admins on the effective axis, not the role enum', async () => {
      prisma.user.findUnique.mockResolvedValue(superAdminRow);
      prisma.user.count.mockResolvedValue(1);

      await service.updateStaffFields(
        'staff-1',
        { appRoleId: 'role-custom' },
        actor,
      );

      expect(prisma.user.count).toHaveBeenCalledWith({
        where: {
          status: UserStatus.ACTIVE,
          NOT: { id: 'staff-1' },
          OR: [
            { appRoleId: { in: ['role-super'] } },
            { appRoleId: null, role: Role.SUPER_ADMIN },
          ],
        },
      });
    });

    it('F8: refuses to move the last roles manager onto a role without ROLES.EDIT', async () => {
      prisma.user.findUnique.mockResolvedValue({
        ...staffRow,
        role: Role.ADMIN,
        appRoleId: 'role-rolemgr',
      });
      prisma.appRole.findMany.mockResolvedValue([
        { id: 'role-rolemgr', key: 'ROLE_MANAGER', isSystem: false },
      ]);
      prisma.user.count.mockResolvedValue(0);

      await expect(
        service.updateStaffFields(
          'staff-1',
          { appRoleId: 'role-custom' },
          actor,
        ),
      ).rejects.toThrow(/last account that can manage roles/);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });

  describe('resetPassword (F3)', () => {
    it("F3: refuses to reset a Super Admin's password without holding the role", async () => {
      usersService.findByIdOrThrow.mockResolvedValue(superAdminRow);

      await expect(
        service.resetPassword(
          'staff-1',
          { newPassword: 'takeover123' },
          staffManager,
        ),
      ).rejects.toThrow(
        'Only a Super Admin can create or change a Super Admin account.',
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it("F3: still lets a Super Admin reset a Super Admin's password", async () => {
      usersService.findByIdOrThrow.mockResolvedValue(superAdminRow);

      await service.resetPassword(
        'staff-1',
        { newPassword: 'rotated12345' },
        actor,
      );

      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'staff-1' } }),
      );
    });

    it('F3: leaves an ordinary staff password reset alone', async () => {
      await service.resetPassword(
        'staff-1',
        { newPassword: 'rotated12345' },
        staffManager,
      );

      expect(prisma.user.update).toHaveBeenCalled();
    });
  });

  describe('updateStatus / remove (F3, F8)', () => {
    const roleManagerRow = {
      ...staffRow,
      id: 'staff-9',
      role: Role.ADMIN,
      appRoleId: 'role-rolemgr',
    };

    it('F3: refuses to suspend a Super Admin without holding the role', async () => {
      usersService.findByIdOrThrow.mockResolvedValue(superAdminRow);

      await expect(
        service.updateStatus(
          'staff-1',
          { status: UserStatus.SUSPENDED },
          staffManager,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('F8: refuses to suspend the last account that can manage roles', async () => {
      usersService.findByIdOrThrow.mockResolvedValue(roleManagerRow);
      prisma.appRole.findMany.mockResolvedValue([
        { id: 'role-rolemgr', key: 'ROLE_MANAGER', isSystem: false },
      ]);
      prisma.user.count.mockResolvedValue(0);

      await expect(
        service.updateStatus(
          'staff-9',
          { status: UserStatus.SUSPENDED },
          actor,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('F8: allows the suspend once another active roles manager remains', async () => {
      usersService.findByIdOrThrow.mockResolvedValue(roleManagerRow);
      prisma.appRole.findMany.mockResolvedValue([
        { id: 'role-rolemgr', key: 'ROLE_MANAGER', isSystem: false },
      ]);
      prisma.user.count.mockResolvedValue(1);

      await service.updateStatus(
        'staff-9',
        { status: UserStatus.SUSPENDED },
        actor,
      );

      expect(prisma.user.update).toHaveBeenCalled();
    });

    it('F8: refuses to delete the last account that can manage roles', async () => {
      usersService.findByIdOrThrow.mockResolvedValue(roleManagerRow);
      prisma.appRole.findMany.mockResolvedValue([
        { id: 'role-rolemgr', key: 'ROLE_MANAGER', isSystem: false },
      ]);
      prisma.user.count.mockResolvedValue(0);

      await expect(service.remove('staff-9', actor)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.user.delete).not.toHaveBeenCalled();
    });

    it('F3: refuses to delete a Super Admin without holding the role (P2)', async () => {
      usersService.findByIdOrThrow.mockResolvedValue(superAdminRow);

      await expect(
        service.remove('staff-1', staffManager),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.user.delete).not.toHaveBeenCalled();
    });

    it('leaves an ordinary staff deletion alone', async () => {
      await service.remove('staff-1', staffManager);

      expect(prisma.user.delete).toHaveBeenCalledWith({
        where: { id: 'staff-1' },
      });
    });
  });
});
