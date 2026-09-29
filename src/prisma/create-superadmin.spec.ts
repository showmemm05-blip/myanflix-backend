import { PassThrough } from 'node:stream';
import * as bcrypt from 'bcrypt';
import { AuditCategory, Role } from '../generated/prisma/client';
import {
  SuperAdminBootstrapError,
  createSuperAdmin,
  parseUsername,
  readPassword,
  validatePassword,
  validateUsername,
} from './create-superadmin';

describe('create-superadmin (H-2)', () => {
  describe('parseUsername', () => {
    it('reads --username <name> and --username=<name>', () => {
      expect(parseUsername(['--username', 'owner'], {})).toBe('owner');
      expect(parseUsername(['--username=owner'], {})).toBe('owner');
    });

    it('falls back to SUPERADMIN_USERNAME', () => {
      expect(parseUsername([], { SUPERADMIN_USERNAME: 'boss' })).toBe('boss');
    });

    it('has no default — a missing username is an error', () => {
      expect(() => parseUsername([], {})).toThrow(SuperAdminBootstrapError);
    });
  });

  describe('validation (the same rules as creating staff)', () => {
    it('usernames: 3-32 letters, digits, dots, underscores', () => {
      expect(() => validateUsername('owner.one')).not.toThrow();
      expect(() => validateUsername('ab')).toThrow(SuperAdminBootstrapError);
      expect(() => validateUsername('has space')).toThrow(
        SuperAdminBootstrapError,
      );
    });

    it('passwords: 8-72 characters, never echoed back', () => {
      expect(() => validatePassword('long-enough')).not.toThrow();
      expect(() => validatePassword('short')).toThrow(/at least 8/);
      expect(() => validatePassword('x'.repeat(73))).toThrow(/72/);
      expect(() => validatePassword('short')).toThrow(
        expect.objectContaining({
          message: expect.not.stringContaining('short') as unknown as string,
        }),
      );
    });
  });

  describe('readPassword', () => {
    function piped(text: string) {
      const stream = new PassThrough();
      stream.end(text);
      return Object.assign(stream, { isTTY: false });
    }

    it('takes the one-time SUPERADMIN_PASSWORD env var first', async () => {
      await expect(
        readPassword({
          env: { SUPERADMIN_PASSWORD: 'from-the-env-var' },
          input: piped('from-stdin\n'),
          output: new PassThrough(),
        }),
      ).resolves.toBe('from-the-env-var');
    });

    it('otherwise reads the first line of piped stdin', async () => {
      await expect(
        readPassword({
          env: {},
          input: piped('piped-password\r\nignored\n'),
          output: new PassThrough(),
        }),
      ).resolves.toBe('piped-password');
    });

    it('an empty pipe is an error, never an empty password', async () => {
      await expect(
        readPassword({ env: {}, input: piped(''), output: new PassThrough() }),
      ).rejects.toThrow(SuperAdminBootstrapError);
    });
  });

  describe('createSuperAdmin', () => {
    let tx: {
      appRole: { findUnique: jest.Mock };
      user: { count: jest.Mock; findUnique: jest.Mock; create: jest.Mock };
      wallet: { create: jest.Mock };
      auditLog: { create: jest.Mock };
    };
    let prisma: { $transaction: jest.Mock };

    beforeEach(() => {
      tx = {
        appRole: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ id: 'role-super', name: 'Super Admin' }),
        },
        user: {
          count: jest.fn().mockResolvedValue(0),
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
            Promise.resolve({
              id: 'new-super',
              displayName: null,
              phone: null,
              email: null,
              status: 'ACTIVE',
              ...data,
            }),
          ),
        },
        wallet: { create: jest.fn().mockResolvedValue({}) },
        auditLog: { create: jest.fn().mockResolvedValue({ id: 'log-1' }) },
      };
      prisma = {
        $transaction: jest.fn((run: (client: typeof tx) => Promise<unknown>) =>
          run(tx),
        ),
      };
    });

    it('creates the Super Admin on the protected AppRole, with a wallet and a system audit row', async () => {
      const result = await createSuperAdmin(prisma as never, {
        username: 'owner',
        password: 'a-strong-password',
      });

      expect(result).toEqual({ id: 'new-super', username: 'owner' });
      const [{ data }] = tx.user.create.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(data).toEqual({
        username: 'owner',
        password: expect.any(String),
        role: Role.SUPER_ADMIN,
        appRoleId: 'role-super',
      });
      await expect(
        bcrypt.compare('a-strong-password', data.password as string),
      ).resolves.toBe(true);
      expect(tx.wallet.create).toHaveBeenCalledWith({
        data: { userId: 'new-super', balance: 0 },
      });

      const [{ data: row }] = tx.auditLog.create.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(row).toEqual(
        expect.objectContaining({
          category: AuditCategory.STAFF,
          action: 'staff.create',
          actorId: null,
          actorUsername: 'system',
          targetType: 'staff',
          targetId: 'new-super',
          targetLabel: '@owner',
          metadata: { trigger: 'create-superadmin' },
        }),
      );
      expect(JSON.stringify(row)).not.toContain('a-strong-password');
      expect(JSON.stringify(row)).not.toContain(data.password as string);
    });

    it('refuses when any Super Admin already exists — by enum or by the protected AppRole', async () => {
      tx.user.count.mockResolvedValue(1);

      await expect(
        createSuperAdmin(prisma as never, {
          username: 'owner',
          password: 'a-strong-password',
        }),
      ).rejects.toThrow(/already exists/);
      expect(tx.user.count).toHaveBeenCalledWith({
        where: {
          OR: [{ role: Role.SUPER_ADMIN }, { appRole: { isProtected: true } }],
        },
      });
      expect(tx.user.create).not.toHaveBeenCalled();
    });

    it('refuses a username that is already taken', async () => {
      tx.user.findUnique.mockResolvedValue({ id: 'someone' });

      await expect(
        createSuperAdmin(prisma as never, {
          username: 'owner',
          password: 'a-strong-password',
        }),
      ).rejects.toThrow(/already taken/);
      expect(tx.user.create).not.toHaveBeenCalled();
    });

    it('refuses on a database the migrations have not built (no SUPER_ADMIN role)', async () => {
      tx.appRole.findUnique.mockResolvedValue(null);

      await expect(
        createSuperAdmin(prisma as never, {
          username: 'owner',
          password: 'a-strong-password',
        }),
      ).rejects.toThrow(/migrat/);
      expect(tx.user.create).not.toHaveBeenCalled();
    });
  });
});
