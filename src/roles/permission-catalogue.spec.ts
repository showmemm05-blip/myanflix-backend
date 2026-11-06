import {
  ALL_PERMISSIONS,
  PERMISSION_CATALOGUE,
  getPermissionCatalogue,
  normalizePermissions,
} from './permission-catalogue';

describe('permission catalogue', () => {
  it('declares 24 modules and 90 MODULE.ACTION permissions', () => {
    // 76 + DEPOSITS.BANK_EVIDENCE + WITHDRAWALS.BANK_EVIDENCE (bank
    // verification: the balance-revealing screenshot streams) + the
    // BANK_TRANSACTIONS module (VIEW, BANK_EVIDENCE) for the phone-monitor's
    // stored notifications + the HOME module (VIEW, MANAGE) for the
    // "Home promos" admin page + the LOTTERY module (VIEW, DREAMS_MANAGE
    // for the dream books; DRAWS_MANAGE, SETTINGS_MANAGE for the draws;
    // RESULTS_PUBLISH for the results and the awarded prizes;
    // CLAIMS_CONFIRM for paying or rejecting a prize claim).
    expect(PERMISSION_CATALOGUE).toHaveLength(24);
    expect(ALL_PERMISSIONS).toHaveLength(90);
  });

  it('declares the LOTTERY module with exactly VIEW, DREAMS_MANAGE, DRAWS_MANAGE, SETTINGS_MANAGE, RESULTS_PUBLISH and CLAIMS_CONFIRM', () => {
    const lottery = getPermissionCatalogue().find(
      (module) => module.key === 'LOTTERY',
    );
    expect(lottery?.label).toBe('Lottery');
    expect(lottery?.actions.map((action) => action.permission)).toEqual([
      'LOTTERY.VIEW',
      'LOTTERY.DREAMS_MANAGE',
      'LOTTERY.DRAWS_MANAGE',
      'LOTTERY.SETTINGS_MANAGE',
      'LOTTERY.RESULTS_PUBLISH',
      'LOTTERY.CLAIMS_CONFIRM',
    ]);
  });

  it('declares the HOME module with exactly VIEW and MANAGE', () => {
    const home = getPermissionCatalogue().find(
      (module) => module.key === 'HOME',
    );
    expect(home?.label).toBe('Home promos');
    expect(home?.actions.map((action) => action.permission)).toEqual([
      'HOME.VIEW',
      'HOME.MANAGE',
    ]);
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
