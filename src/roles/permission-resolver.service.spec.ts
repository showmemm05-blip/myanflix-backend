import { Test, TestingModule } from '@nestjs/testing';
import { Role } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ALL_PERMISSIONS } from './permission-catalogue';
import { PermissionResolverService } from './permission-resolver.service';

describe('PermissionResolverService', () => {
  let service: PermissionResolverService;
  let prisma: { appRole: { findUnique: jest.Mock } };

  const customRoleRow = {
    id: 'role-custom',
    key: 'MOVIE_MANAGER',
    name: 'Movie Manager',
    isSystem: false,
    isProtected: false,
    permissions: [
      { permission: 'MOVIES.VIEW' },
      { permission: 'MOVIES.CREATE' },
    ],
  };

  const adminRoleRow = {
    id: 'role-admin',
    key: Role.ADMIN,
    name: 'Admin',
    isSystem: true,
    isProtected: false,
    permissions: [
      { permission: 'MOVIES.VIEW' },
      { permission: 'DEPOSITS.VIEW' },
    ],
  };

  const superAdminRoleRow = {
    id: 'role-super',
    key: Role.SUPER_ADMIN,
    name: 'Super Admin',
    isSystem: true,
    isProtected: true,
    // Deliberately a short list: `isProtected` must win over whatever is stored.
    permissions: [{ permission: 'MOVIES.VIEW' }],
  };

  const rows = [customRoleRow, adminRoleRow, superAdminRoleRow];

  beforeEach(async () => {
    prisma = {
      appRole: {
        findUnique: jest.fn(({ where }: { where: Record<string, string> }) =>
          Promise.resolve(
            rows.find(
              (row) =>
                (where.id !== undefined && row.id === where.id) ||
                (where.key !== undefined && row.key === where.key),
            ) ?? null,
          ),
        ),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PermissionResolverService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get(PermissionResolverService);
  });

  describe('resolution', () => {
    it('resolves an explicitly assigned AppRole by id', async () => {
      const granted = await service.permissionsFor({
        role: Role.CONTENT_UPLOADER,
        appRoleId: 'role-custom',
      });

      expect([...granted].sort()).toEqual(['MOVIES.CREATE', 'MOVIES.VIEW']);
      expect(prisma.appRole.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'role-custom' } }),
      );
    });

    it('falls back to the system role matching the enum when appRoleId is null', async () => {
      const granted = await service.permissionsFor({
        role: Role.ADMIN,
        appRoleId: null,
      });

      expect([...granted].sort()).toEqual(['DEPOSITS.VIEW', 'MOVIES.VIEW']);
      expect(prisma.appRole.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { key: Role.ADMIN } }),
      );
    });

    it('falls back to the enum role when the assigned AppRole no longer exists', async () => {
      const granted = await service.permissionsFor({
        role: Role.ADMIN,
        appRoleId: 'role-deleted',
      });

      expect(granted.has('DEPOSITS.VIEW')).toBe(true);
    });

    it('short-circuits the protected role to every permission, whatever is stored', async () => {
      const granted = await service.permissionsFor({
        role: Role.SUPER_ADMIN,
        appRoleId: 'role-super',
      });

      expect(granted.size).toBe(ALL_PERMISSIONS.length);
      expect(granted.has('ROLES.EDIT')).toBe(true);
      expect(granted.has('USERS.WALLET_ADJUST')).toBe(true);
    });

    it('still grants a super admin everything if the seeded role row is missing', async () => {
      prisma.appRole.findUnique.mockResolvedValue(null);

      const granted = await service.permissionsFor({
        role: Role.SUPER_ADMIN,
        appRoleId: null,
      });

      expect(granted.size).toBe(ALL_PERMISSIONS.length);
    });

    it('grants nothing when a non-super-admin role cannot be resolved', async () => {
      prisma.appRole.findUnique.mockResolvedValue(null);

      const granted = await service.permissionsFor({
        role: Role.USER,
        appRoleId: null,
      });

      expect(granted.size).toBe(0);
    });

    it('can/canAny/canAll agree with the resolved set', async () => {
      const user = { role: Role.CONTENT_UPLOADER, appRoleId: 'role-custom' };

      await expect(service.can(user, 'MOVIES.CREATE')).resolves.toBe(true);
      await expect(service.can(user, 'MOVIES.DELETE')).resolves.toBe(false);
      await expect(
        service.canAny(user, ['MOVIES.DELETE', 'MOVIES.VIEW']),
      ).resolves.toBe(true);
      await expect(
        service.canAny(user, ['MOVIES.DELETE', 'ROLES.EDIT']),
      ).resolves.toBe(false);
      await expect(
        service.canAll(user, ['MOVIES.VIEW', 'MOVIES.CREATE']),
      ).resolves.toBe(true);
      await expect(
        service.canAll(user, ['MOVIES.VIEW', 'MOVIES.DELETE']),
      ).resolves.toBe(false);
    });
  });

  describe('cache', () => {
    const user = { role: Role.CONTENT_UPLOADER, appRoleId: 'role-custom' };

    it('queries the database once and serves later requests from memory', async () => {
      await service.permissionsFor(user);
      await service.permissionsFor(user);
      await service.permissionsFor(user);

      expect(prisma.appRole.findUnique).toHaveBeenCalledTimes(1);
    });

    it('de-duplicates concurrent first loads into a single query', async () => {
      await Promise.all([
        service.permissionsFor(user),
        service.permissionsFor(user),
        service.permissionsFor(user),
      ]);

      expect(prisma.appRole.findUnique).toHaveBeenCalledTimes(1);
    });

    it('serves the id-cached role to a caller arriving through the key fallback', async () => {
      await service.permissionsFor({
        role: Role.ADMIN,
        appRoleId: 'role-admin',
      });
      await service.permissionsFor({ role: Role.ADMIN, appRoleId: null });

      expect(prisma.appRole.findUnique).toHaveBeenCalledTimes(1);
    });

    it('re-reads after invalidate(roleId) — a permission edit is live on the next request', async () => {
      await service.permissionsFor(user);
      expect(prisma.appRole.findUnique).toHaveBeenCalledTimes(1);

      customRoleRow.permissions = [
        { permission: 'MOVIES.VIEW' },
        { permission: 'MOVIES.CREATE' },
        { permission: 'MOVIES.DELETE' },
      ];
      service.invalidate('role-custom');

      const granted = await service.permissionsFor(user);
      expect(prisma.appRole.findUnique).toHaveBeenCalledTimes(2);
      expect(granted.has('MOVIES.DELETE')).toBe(true);

      customRoleRow.permissions = [
        { permission: 'MOVIES.VIEW' },
        { permission: 'MOVIES.CREATE' },
      ];
    });

    it('drops the key mapping too, so the fallback path re-reads after invalidate', async () => {
      await service.permissionsFor({ role: Role.ADMIN, appRoleId: null });
      service.invalidate('role-admin');
      await service.permissionsFor({ role: Role.ADMIN, appRoleId: null });

      expect(prisma.appRole.findUnique).toHaveBeenCalledTimes(2);
    });

    it('invalidateAll() clears every cached role', async () => {
      await service.permissionsFor(user);
      await service.permissionsFor({
        role: Role.ADMIN,
        appRoleId: 'role-admin',
      });
      expect(prisma.appRole.findUnique).toHaveBeenCalledTimes(2);

      service.invalidateAll();

      await service.permissionsFor(user);
      await service.permissionsFor({
        role: Role.ADMIN,
        appRoleId: 'role-admin',
      });
      expect(prisma.appRole.findUnique).toHaveBeenCalledTimes(4);
    });

    it('F9: discards a load that finished after an invalidation instead of caching it', async () => {
      let release!: () => void;
      prisma.appRole.findUnique.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve(customRoleRow);
          }),
      );

      // A request reads the role...
      const inFlight = service.permissionsFor(user);
      // ...an admin revokes something while that read is still open...
      service.invalidate('role-custom');
      // ...and only then does the stale snapshot come back.
      release();
      await inFlight;

      // It must not have been written to the cache: the next request re-reads
      // rather than being served the permissions that were just taken away.
      await service.permissionsFor(user);
      expect(prisma.appRole.findUnique).toHaveBeenCalledTimes(2);
    });

    it('F9: still caches a load that no invalidation raced', async () => {
      await service.permissionsFor(user);
      await service.permissionsFor(user);

      expect(prisma.appRole.findUnique).toHaveBeenCalledTimes(1);
    });

    it('F9/F10: re-reads a cached role once its 60s TTL expires', async () => {
      const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
      try {
        await service.permissionsFor(user);
        expect(prisma.appRole.findUnique).toHaveBeenCalledTimes(1);

        now.mockReturnValue(1_000_000 + 59_000);
        await service.permissionsFor(user);
        expect(prisma.appRole.findUnique).toHaveBeenCalledTimes(1);

        // Past the TTL — the bound on how long another instance's edit can go
        // unnoticed in this process.
        now.mockReturnValue(1_000_000 + 61_000);
        await service.permissionsFor(user);
        expect(prisma.appRole.findUnique).toHaveBeenCalledTimes(2);
      } finally {
        now.mockRestore();
      }
    });

    it('F9/F10: the TTL applies to the key-fallback path too', async () => {
      const now = jest.spyOn(Date, 'now').mockReturnValue(2_000_000);
      try {
        const admin = { role: Role.ADMIN, appRoleId: null };
        await service.permissionsFor(admin);
        now.mockReturnValue(2_000_000 + 61_000);
        await service.permissionsFor(admin);

        expect(prisma.appRole.findUnique).toHaveBeenCalledTimes(2);
      } finally {
        now.mockRestore();
      }
    });

    it('invalidating one role leaves the others cached', async () => {
      await service.permissionsFor(user);
      await service.permissionsFor({
        role: Role.ADMIN,
        appRoleId: 'role-admin',
      });
      expect(prisma.appRole.findUnique).toHaveBeenCalledTimes(2);

      service.invalidate('role-custom');

      await service.permissionsFor({
        role: Role.ADMIN,
        appRoleId: 'role-admin',
      });
      expect(prisma.appRole.findUnique).toHaveBeenCalledTimes(2);
    });
  });
});
