import {
  ALL_PERMISSIONS,
  PERMISSION_CATALOGUE,
  getPermissionCatalogue,
  isPermission,
  normalizePermissions,
} from './permission-catalogue';

describe('permission catalogue', () => {
  it('declares 17 modules and 65 MODULE.ACTION permissions', () => {
    expect(PERMISSION_CATALOGUE).toHaveLength(17);
    expect(ALL_PERMISSIONS).toHaveLength(65);
  });

  it('generates every permission as MODULE.ACTION with no duplicates', () => {
    for (const permission of ALL_PERMISSIONS) {
      expect(permission).toMatch(/^[A-Z_]+\.[A-Z_]+$/);
    }
    expect(new Set(ALL_PERMISSIONS).size).toBe(ALL_PERMISSIONS.length);
  });

  it('uses unique module keys', () => {
    const keys = PERMISSION_CATALOGUE.map((module) => module.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  describe('isPermission', () => {
    it('accepts a catalogue value', () => {
      expect(isPermission('MOVIES.PUBLISH')).toBe(true);
    });

    it('rejects an unknown module, an unknown action and the old bundled names', () => {
      expect(isPermission('BOOKS.VIEW')).toBe(false);
      expect(isPermission('MOVIES.ARCHIVE')).toBe(false);
      expect(isPermission('MOVIE_CREATE')).toBe(false);
    });
  });

  describe('normalizePermissions', () => {
    it('drops unknown values so a hand-rolled API payload cannot store junk', () => {
      expect(
        normalizePermissions(['MOVIES.VIEW', 'NOT.REAL', 'MOVIE_CREATE']),
      ).toEqual(['MOVIES.VIEW']);
    });

    it('de-duplicates and returns catalogue order regardless of input order', () => {
      expect(
        normalizePermissions([
          'SERIES.VIEW',
          'MOVIES.CREATE',
          'MOVIES.VIEW',
          'MOVIES.VIEW',
        ]),
      ).toEqual(['MOVIES.VIEW', 'MOVIES.CREATE', 'SERIES.VIEW']);
    });
  });

  describe('getPermissionCatalogue', () => {
    it('pairs every action with its full permission string and a humanized label', () => {
      const users = getPermissionCatalogue().find(
        (module) => module.key === 'USERS',
      );

      expect(users).toEqual({
        key: 'USERS',
        label: 'Users',
        actions: [
          { key: 'VIEW', label: 'View', permission: 'USERS.VIEW' },
          { key: 'EDIT', label: 'Edit', permission: 'USERS.EDIT' },
          { key: 'SUSPEND', label: 'Suspend', permission: 'USERS.SUSPEND' },
          {
            key: 'WALLET_ADJUST',
            label: 'Wallet Adjust',
            permission: 'USERS.WALLET_ADJUST',
          },
        ],
      });
    });

    it('exposes exactly the same permissions as the flat list', () => {
      const fromTree = getPermissionCatalogue().flatMap((module) =>
        module.actions.map((action) => action.permission),
      );
      expect(fromTree).toEqual(ALL_PERMISSIONS);
    });
  });
});
