import { Test, TestingModule } from '@nestjs/testing';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Role, UserStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import {
  createRoleAwarePermissionResolver,
  seededRoleRow,
} from '../../test/seeded-permission-resolver';
import { AuthorityService } from './authority.service';
import { ALL_PERMISSIONS } from './permission-catalogue';
import { PermissionResolverService } from './permission-resolver.service';
import { RolesService } from './roles.service';

describe('RolesService', () => {
  let service: RolesService;
  let prisma: {
    appRole: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
    appRolePermission: { deleteMany: jest.Mock; createMany: jest.Mock };
    user: { count: jest.Mock };
    $transaction: jest.Mock;
  };
  let resolver: ReturnType<typeof createRoleAwarePermissionResolver>;

  /** The default actor: a Super Admin, so P1 never gets in an old test's way. */
  const actor: AuthenticatedUser = {
    id: 'boss-1',
    username: 'boss',
    role: Role.SUPER_ADMIN,
    appRoleId: 'role-super',
  };

  /** A custom-role actor holding exactly what MOVIE_MANAGER holds. */
  const movieManagerActor: AuthenticatedUser = {
    id: 'mm-1',
    username: 'mm',
    role: Role.ADMIN,
    appRoleId: 'role-custom',
  };

  const superAdminRole = {
    id: 'role-super',
    key: Role.SUPER_ADMIN,
    name: 'Super Admin',
    description: null,
    isSystem: true,
    isProtected: true,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    permissions: ALL_PERMISSIONS.map((permission) => ({ permission })),
  };

  const customRole = {
    id: 'role-custom',
    key: 'MOVIE_MANAGER',
    name: 'Movie Manager',
    description: 'Movies only',
    isSystem: false,
    isProtected: false,
    createdAt: new Date('2026-02-01'),
    updatedAt: new Date('2026-02-01'),
    permissions: [
      { permission: 'MOVIES.VIEW' },
      { permission: 'MOVIES.CREATE' },
    ],
  };

  const roleManagerRole = {
    ...customRole,
    id: 'role-manager',
    key: 'ROLE_MANAGER',
    name: 'Role Manager',
    permissions: [{ permission: 'ROLES.VIEW' }, { permission: 'ROLES.EDIT' }],
  };

  beforeEach(async () => {
    prisma = {
      appRole: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn().mockResolvedValue(undefined),
      },
      appRolePermission: {
        deleteMany: jest.fn().mockReturnValue('deleteMany-op'),
        createMany: jest.fn().mockReturnValue('createMany-op'),
      },
      user: { count: jest.fn().mockResolvedValue(0) },
      $transaction: jest.fn().mockResolvedValue([]),
    };
    resolver = createRoleAwarePermissionResolver([
      seededRoleRow(Role.SUPER_ADMIN, 'role-super'),
      seededRoleRow(Role.ADMIN, 'role-admin'),
      {
        id: 'role-custom',
        key: 'MOVIE_MANAGER',
        permissions: ['MOVIES.VIEW', 'MOVIES.CREATE'],
      },
      {
        id: 'role-manager',
        key: 'ROLE_MANAGER',
        permissions: ['ROLES.VIEW', 'ROLES.EDIT'],
      },
    ]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RolesService,
        // The real AuthorityService — P1 is the thing under test in the
        // escalation cases, so mocking it would prove nothing.
        AuthorityService,
        { provide: PrismaService, useValue: prisma },
        { provide: PermissionResolverService, useValue: resolver },
      ],
    }).compile();

    service = module.get(RolesService);
  });

  describe('getCatalogue', () => {
    it('returns all 17 modules and all 65 permissions for the matrix UI', () => {
      const catalogue = service.getCatalogue();

      expect(catalogue.modules).toHaveLength(17);
      expect(catalogue.permissions).toHaveLength(65);
      expect(catalogue.modules[0]).toEqual({
        key: 'DASHBOARD',
        label: 'Dashboard',
        actions: [{ key: 'VIEW', label: 'View', permission: 'DASHBOARD.VIEW' }],
      });
    });
  });

  describe('findAll', () => {
    it('returns each role with its permissions and a user count', async () => {
      prisma.appRole.findMany.mockResolvedValue([customRole]);
      prisma.user.count.mockResolvedValue(3);

      const { items } = await service.findAll();

      expect(items).toHaveLength(1);
      expect(items[0]).toEqual(
        expect.objectContaining({
          id: 'role-custom',
          key: 'MOVIE_MANAGER',
          name: 'Movie Manager',
          isSystem: false,
          isProtected: false,
          permissions: ['MOVIES.VIEW', 'MOVIES.CREATE'],
          userCount: 3,
        }),
      );
    });

    it('counts NULL-appRoleId accounts against the matching system role', async () => {
      prisma.appRole.findMany.mockResolvedValue([superAdminRole]);
      prisma.user.count.mockResolvedValueOnce(1).mockResolvedValueOnce(4);

      const { items } = await service.findAll();

      expect(items[0].userCount).toBe(5);
      expect(prisma.user.count).toHaveBeenNthCalledWith(2, {
        where: { appRoleId: null, role: Role.SUPER_ADMIN },
      });
    });

    it('always reports the protected role as holding every permission', async () => {
      prisma.appRole.findMany.mockResolvedValue([
        { ...superAdminRole, permissions: [{ permission: 'MOVIES.VIEW' }] },
      ]);

      const { items } = await service.findAll();

      expect(items[0].permissions).toEqual(ALL_PERMISSIONS);
    });
  });

  describe('create', () => {
    it('derives an uppercase-snake key from the name and stores the permissions', async () => {
      prisma.appRole.findUnique.mockResolvedValue(null);
      prisma.appRole.create.mockResolvedValue(customRole);

      await service.create(
        {
          name: 'Movie Manager',
          description: 'Movies only',
          permissions: ['MOVIES.CREATE', 'MOVIES.VIEW'],
        },
        actor,
      );

      expect(prisma.appRole.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            key: 'MOVIE_MANAGER',
            name: 'Movie Manager',
            description: 'Movies only',
            isSystem: false,
            isProtected: false,
            permissions: {
              // Normalized into catalogue order, whatever order came in.
              create: [
                { permission: 'MOVIES.VIEW' },
                { permission: 'MOVIES.CREATE' },
              ],
            },
          }),
        }),
      );
    });

    it('suffixes the key until it is unique', async () => {
      prisma.appRole.findUnique
        .mockResolvedValueOnce({ id: 'taken' })
        .mockResolvedValueOnce(null);
      prisma.appRole.create.mockResolvedValue(customRole);

      await service.create({ name: 'Movie Manager' }, actor);

      expect(prisma.appRole.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ key: 'MOVIE_MANAGER_2' }),
        }),
      );
    });

    it('creates with no permissions when none are supplied', async () => {
      prisma.appRole.findUnique.mockResolvedValue(null);
      prisma.appRole.create.mockResolvedValue({
        ...customRole,
        permissions: [],
      });

      const created = await service.create({ name: 'Empty Role' }, actor);

      expect(created.permissions).toEqual([]);
      expect(created.userCount).toBe(0);
    });

    it('F5: refuses to create a role holding more than its creator does (P1)', async () => {
      prisma.appRole.findUnique.mockResolvedValue(null);

      await expect(
        service.create(
          { name: 'Backdoor', permissions: ['MOVIES.VIEW', 'ROLES.EDIT'] },
          movieManagerActor,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.appRole.create).not.toHaveBeenCalled();
    });

    it('F5: allows a creator to hand out exactly what they already hold', async () => {
      prisma.appRole.findUnique.mockResolvedValue(null);
      prisma.appRole.create.mockResolvedValue(customRole);

      await service.create(
        { name: 'Movie Viewer', permissions: ['MOVIES.VIEW'] },
        movieManagerActor,
      );

      expect(prisma.appRole.create).toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('renames a custom role and invalidates its cached permissions', async () => {
      prisma.appRole.findUnique.mockResolvedValue(customRole);
      prisma.appRole.update.mockResolvedValue({
        ...customRole,
        name: 'Film Manager',
      });

      const updated = await service.update('role-custom', {
        name: 'Film Manager',
      });

      expect(updated.name).toBe('Film Manager');
      // The key is immutable — renaming must never move it.
      expect(prisma.appRole.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { name: 'Film Manager' } }),
      );
      expect(resolver.invalidate).toHaveBeenCalledWith('role-custom');
    });

    it('clears the description when an empty string is sent', async () => {
      prisma.appRole.findUnique.mockResolvedValue(customRole);
      prisma.appRole.update.mockResolvedValue(customRole);

      await service.update('role-custom', { description: '   ' });

      expect(prisma.appRole.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { description: null } }),
      );
    });

    it('refuses to edit the protected Super Admin role (409)', async () => {
      prisma.appRole.findUnique.mockResolvedValue(superAdminRole);

      await expect(
        service.update('role-super', { name: 'Owner' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.appRole.update).not.toHaveBeenCalled();
    });

    it('throws 404 for an unknown role', async () => {
      prisma.appRole.findUnique.mockResolvedValue(null);

      await expect(
        service.update('nope', { name: 'Whatever' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('replacePermissions', () => {
    it('writes only the diff and invalidates the resolver cache', async () => {
      prisma.appRole.findUnique.mockResolvedValue(customRole);

      await service.replacePermissions(
        'role-custom',
        ['MOVIES.VIEW', 'MOVIES.DELETE'],
        actor,
      );

      expect(prisma.appRolePermission.createMany).toHaveBeenCalledWith({
        data: [{ roleId: 'role-custom', permission: 'MOVIES.DELETE' }],
        skipDuplicates: true,
      });
      expect(prisma.appRolePermission.deleteMany).toHaveBeenCalledWith({
        where: { roleId: 'role-custom', permission: { in: ['MOVIES.CREATE'] } },
      });
      expect(resolver.invalidate).toHaveBeenCalledWith('role-custom');
    });

    it('skips the write entirely when nothing changed', async () => {
      prisma.appRole.findUnique.mockResolvedValue(customRole);

      await service.replacePermissions(
        'role-custom',
        ['MOVIES.CREATE', 'MOVIES.VIEW'],
        actor,
      );

      expect(prisma.$transaction).not.toHaveBeenCalled();
      // Still invalidated — cheap, and keeps the cache honest if a concurrent
      // write landed between the read and here.
      expect(resolver.invalidate).toHaveBeenCalledWith('role-custom');
    });

    it('refuses to edit the protected Super Admin role (409)', async () => {
      prisma.appRole.findUnique.mockResolvedValue(superAdminRole);

      await expect(
        service.replacePermissions('role-super', ['MOVIES.VIEW'], actor),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    describe('grant ceiling and self-edit (F4)', () => {
      it('F4: refuses to grant a permission the actor does not hold themselves (P1)', async () => {
        prisma.appRole.findUnique.mockResolvedValue(customRole);

        await expect(
          service.replacePermissions(
            'role-custom',
            ['ROLES.VIEW', 'USERS.WALLET_ADJUST'],
            // Assigned to ROLE_MANAGER: holds ROLES.EDIT, so it may reach
            // this route at all — but it has no USERS.* permission to give.
            {
              id: 'rm-1',
              username: 'rm',
              role: Role.ADMIN,
              appRoleId: 'role-manager',
            },
          ),
        ).rejects.toThrow(
          'You cannot grant permissions you do not have yourself: USERS.WALLET_ADJUST.',
        );
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });

      it('F4: refuses to edit the permissions of the role the actor is assigned to', async () => {
        prisma.appRole.findUnique.mockResolvedValue(roleManagerRole);

        await expect(
          service.replacePermissions(
            'role-manager',
            ['ROLES.VIEW', 'ROLES.EDIT'],
            {
              id: 'rm-1',
              username: 'rm',
              role: Role.ADMIN,
              appRoleId: 'role-manager',
            },
          ),
        ).rejects.toThrow(
          'You cannot change the permissions of the role you are assigned to. Ask another administrator.',
        );
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });

      it('F4: a Super Admin is unaffected by the ceiling — the protected role holds everything', async () => {
        prisma.appRole.findUnique.mockResolvedValue(customRole);

        await service.replacePermissions(
          'role-custom',
          ['MOVIES.VIEW', 'USERS.WALLET_ADJUST'],
          actor,
        );

        expect(prisma.$transaction).toHaveBeenCalled();
      });
    });

    describe('lockout guard', () => {
      it('refuses to strip ROLES.EDIT from the last role that can manage roles (409)', async () => {
        prisma.appRole.findUnique.mockResolvedValue(roleManagerRole);
        // No other role that grants ROLES.EDIT (or is protected) has anyone on it.
        prisma.appRole.findMany.mockResolvedValue([
          { id: 'role-super', key: Role.SUPER_ADMIN, isSystem: true },
        ]);
        prisma.user.count.mockResolvedValue(0);

        await expect(
          service.replacePermissions('role-manager', ['ROLES.VIEW'], actor),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });

      it('allows the strip when another role with active members can still manage roles', async () => {
        prisma.appRole.findUnique.mockResolvedValue(roleManagerRole);
        prisma.appRole.findMany.mockResolvedValue([
          { id: 'role-super', key: Role.SUPER_ADMIN, isSystem: true },
        ]);
        prisma.user.count.mockResolvedValue(1);

        await service.replacePermissions('role-manager', ['ROLES.VIEW'], actor);

        expect(prisma.$transaction).toHaveBeenCalled();
        expect(prisma.user.count).toHaveBeenCalledWith({
          where: { appRoleId: 'role-super', status: UserStatus.ACTIVE },
        });
      });

      it('does not fire when the save keeps ROLES.EDIT', async () => {
        prisma.appRole.findUnique.mockResolvedValue(roleManagerRole);

        await service.replacePermissions(
          'role-manager',
          ['ROLES.VIEW', 'ROLES.EDIT', 'ROLES.CREATE'],
          actor,
        );

        expect(prisma.appRole.findMany).not.toHaveBeenCalled();
        expect(prisma.$transaction).toHaveBeenCalled();
      });

      it('does not fire for a role that never had ROLES.EDIT', async () => {
        prisma.appRole.findUnique.mockResolvedValue(customRole);

        await service.replacePermissions('role-custom', ['MOVIES.VIEW'], actor);

        expect(prisma.appRole.findMany).not.toHaveBeenCalled();
      });
    });
  });

  describe('remove', () => {
    it('deletes an unused custom role', async () => {
      prisma.appRole.findUnique.mockResolvedValue(customRole);
      prisma.user.count.mockResolvedValue(0);

      await service.remove('role-custom');

      expect(prisma.appRole.delete).toHaveBeenCalledWith({
        where: { id: 'role-custom' },
      });
      expect(resolver.invalidate).toHaveBeenCalledWith('role-custom');
    });

    it('refuses to delete a role that still has users assigned (409)', async () => {
      prisma.appRole.findUnique.mockResolvedValue(customRole);
      prisma.user.count.mockResolvedValue(2);

      await expect(service.remove('role-custom')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.appRole.delete).not.toHaveBeenCalled();
    });

    it('refuses to delete a built-in role (409)', async () => {
      prisma.appRole.findUnique.mockResolvedValue({
        ...customRole,
        isSystem: true,
        key: Role.ADMIN,
      });

      await expect(service.remove('role-custom')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.appRole.delete).not.toHaveBeenCalled();
    });

    it('throws 404 for an unknown role', async () => {
      prisma.appRole.findUnique.mockResolvedValue(null);

      await expect(service.remove('nope')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
