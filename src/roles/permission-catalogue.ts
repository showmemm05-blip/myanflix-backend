/**
 * The single source of truth for every permission the platform knows about.
 *
 * Permissions are `MODULE.ACTION` strings generated from the data below —
 * there is deliberately no hand-written enum, so adding a module (or an
 * action to an existing module) is a one-line change here and everything
 * else (the `Permission` union type, `ALL_PERMISSIONS`, the roles-matrix
 * catalogue endpoint, the admin UI) follows automatically.
 *
 * Only actions a module genuinely supports are listed — an action that gates
 * nothing today is still declared when the roles matrix must be able to show
 * it (e.g. `MOVIES.PUBLISH`, which movies reach through `PUT /movies/:id`).
 */
export const PERMISSION_CATALOGUE = [
  { key: 'DASHBOARD', label: 'Dashboard', actions: ['VIEW'] },
  {
    key: 'MOVIES',
    label: 'Movies',
    actions: ['VIEW', 'CREATE', 'EDIT', 'DELETE', 'PUBLISH', 'UNPUBLISH'],
  },
  {
    key: 'SERIES',
    label: 'Series',
    actions: ['VIEW', 'CREATE', 'EDIT', 'DELETE', 'PUBLISH', 'UNPUBLISH'],
  },
  { key: 'MEDIA', label: 'Media', actions: ['VIEW', 'UPLOAD', 'DELETE'] },
  {
    key: 'CATEGORIES',
    label: 'Categories',
    actions: ['VIEW', 'CREATE', 'EDIT', 'DELETE'],
  },
  {
    key: 'USERS',
    label: 'Users',
    actions: ['VIEW', 'EDIT', 'SUSPEND', 'WALLET_ADJUST'],
  },
  {
    key: 'STAFF',
    label: 'Staff',
    actions: ['VIEW', 'CREATE', 'EDIT', 'DELETE'],
  },
  {
    key: 'ROLES',
    label: 'Roles',
    actions: ['VIEW', 'CREATE', 'EDIT', 'DELETE'],
  },
  {
    key: 'DEPOSITS',
    label: 'Deposits',
    actions: ['VIEW', 'APPROVE', 'REJECT', 'CREATE', 'EDIT'],
  },
  {
    key: 'WITHDRAWALS',
    label: 'Withdrawals',
    actions: ['VIEW', 'APPROVE', 'REJECT', 'EDIT'],
  },
  {
    key: 'PAYMENT_METHODS',
    label: 'Payment Methods',
    actions: ['VIEW', 'CREATE', 'EDIT', 'DELETE'],
  },
  {
    key: 'PAYMENT_ACCOUNTS',
    label: 'Payment Accounts',
    actions: ['VIEW', 'CREATE', 'EDIT', 'DELETE', 'LEDGER_MANAGE'],
  },
  {
    key: 'FINANCE',
    label: 'Finance',
    actions: ['VIEW', 'EXPORT', 'SETTINGS_MANAGE'],
  },
  {
    key: 'SUBSCRIPTIONS',
    label: 'Subscriptions',
    actions: ['VIEW', 'CREATE', 'EDIT', 'DELETE'],
  },
  { key: 'PEAK_USERS', label: 'Peak Users', actions: ['VIEW', 'MANAGE'] },
  {
    // VIEW gates every read screen (comments, feedback, active users, watch
    // time, searches, phone/IP). The other three are separately grantable
    // because they are meaningfully more dangerous than looking:
    // COMMENTS_MODERATE deletes/hides other people's words,
    // FEEDBACK_MANAGE writes back triage state, and PII_VIEW is what
    // unmasks phone numbers and IP addresses — without it the tracking
    // service masks them server-side, so a role can be given full
    // visibility into behaviour without being given personal data.
    key: 'TRACKING',
    label: 'Tracking',
    actions: ['VIEW', 'COMMENTS_MODERATE', 'FEEDBACK_MANAGE', 'PII_VIEW'],
  },
  { key: 'SETTINGS', label: 'Settings', actions: ['VIEW', 'MANAGE'] },
] as const;

type Catalogue = typeof PERMISSION_CATALOGUE;
type CatalogueEntry = Catalogue[number];

/** Every module key in the catalogue, as a literal union. */
export type PermissionModule = CatalogueEntry['key'];

type PermissionsOf<T extends CatalogueEntry> = T extends {
  key: infer K extends string;
  actions: readonly (infer A extends string)[];
}
  ? `${K}.${A}`
  : never;

/**
 * `MODULE.ACTION` — derived from PERMISSION_CATALOGUE, so an unknown or
 * misspelled permission is a compile error at every `@RequirePermissions`
 * site without anyone maintaining a parallel enum.
 */
export type Permission = PermissionsOf<CatalogueEntry>;

/** Flat list, in catalogue order (module order, then action order). */
export const ALL_PERMISSIONS: Permission[] = PERMISSION_CATALOGUE.flatMap(
  (module) =>
    module.actions.map((action) => `${module.key}.${action}` as Permission),
);

const PERMISSION_SET: ReadonlySet<string> = new Set<string>(ALL_PERMISSIONS);

/** Narrows an arbitrary string to a known permission (validates API input). */
export function isPermission(value: string): value is Permission {
  return PERMISSION_SET.has(value);
}

/**
 * Filters + de-duplicates an arbitrary string list down to known permissions,
 * returned in catalogue order so stored/returned sets are always comparable.
 */
export function normalizePermissions(values: readonly string[]): Permission[] {
  const wanted = new Set(values);
  return ALL_PERMISSIONS.filter((permission) => wanted.has(permission));
}

/** "WALLET_ADJUST" -> "Wallet Adjust" — a default label for the matrix UI. */
function humanizeAction(action: string): string {
  return action
    .split('_')
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join(' ');
}

export interface PermissionCatalogueAction {
  key: string;
  label: string;
  permission: Permission;
}

export interface PermissionCatalogueModule {
  key: PermissionModule;
  label: string;
  actions: PermissionCatalogueAction[];
}

/** Wire shape served by `GET /roles/catalogue` and rendered as the matrix. */
export function getPermissionCatalogue(): PermissionCatalogueModule[] {
  return PERMISSION_CATALOGUE.map((module) => {
    // Widened from the per-module readonly tuple so `.map` sees one element
    // type instead of a union of tuple types.
    const actions: readonly string[] = module.actions;
    return {
      key: module.key,
      label: module.label,
      actions: actions.map((action) => ({
        key: action,
        label: humanizeAction(action),
        permission: `${module.key}.${action}` as Permission,
      })),
    };
  });
}
