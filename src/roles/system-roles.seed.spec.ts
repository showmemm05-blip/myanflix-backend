import { Role } from '../generated/prisma/client';
import type { Permission } from './permission-catalogue';
import { ALL_PERMISSIONS } from './permission-catalogue';
import { SYSTEM_ROLE_SEEDS } from './system-roles.seed';

/**
 * Parity proof for the `add_rbac_roles` migration.
 *
 * The non-negotiable of the RBAC refactor is that every existing account
 * keeps EXACTLY the access it had under the old static ROLE_PERMISSIONS map.
 * That map is gone from the codebase, so a frozen snapshot of it lives here
 * next to the route table it gated, and every guarded route is replayed
 * against both worlds for all four system roles.
 *
 * If a seed list or a decorator is ever changed in a way that grants or
 * removes access for a built-in role, exactly one of these cases fails.
 */

type LegacyPermission =
  | 'MOVIE_CREATE'
  | 'MOVIE_UPDATE'
  | 'MOVIE_DELETE'
  | 'VIDEO_UPLOAD'
  | 'USER_MANAGE'
  | 'FINANCE_VIEW'
  | 'DEPOSIT_MANAGE'
  | 'WITHDRAWAL_MANAGE'
  | 'SUBTITLE_MANAGE'
  | 'SERIES_MANAGE'
  | 'SUBSCRIPTION_MANAGE'
  | 'STAFF_MANAGE'
  | 'PAYMENT_ACCOUNT_MANAGE'
  | 'FINANCE_SETTINGS_MANAGE'
  | 'PEAK_USERS_MANAGE'
  | 'WALLET_ADJUST';

const ALL_LEGACY_PERMISSIONS: LegacyPermission[] = [
  'MOVIE_CREATE',
  'MOVIE_UPDATE',
  'MOVIE_DELETE',
  'VIDEO_UPLOAD',
  'USER_MANAGE',
  'FINANCE_VIEW',
  'DEPOSIT_MANAGE',
  'WITHDRAWAL_MANAGE',
  'SUBTITLE_MANAGE',
  'SERIES_MANAGE',
  'SUBSCRIPTION_MANAGE',
  'STAFF_MANAGE',
  'PAYMENT_ACCOUNT_MANAGE',
  'FINANCE_SETTINGS_MANAGE',
  'PEAK_USERS_MANAGE',
  'WALLET_ADJUST',
];

/** Verbatim snapshot of role-permissions.map.ts as it stood before this refactor. */
const LEGACY_ROLE_PERMISSIONS: Record<Role, LegacyPermission[]> = {
  [Role.SUPER_ADMIN]: ALL_LEGACY_PERMISSIONS,
  [Role.ADMIN]: [
    'MOVIE_CREATE',
    'MOVIE_UPDATE',
    'MOVIE_DELETE',
    'VIDEO_UPLOAD',
    'DEPOSIT_MANAGE',
    'WITHDRAWAL_MANAGE',
    'SUBTITLE_MANAGE',
    'SERIES_MANAGE',
    'SUBSCRIPTION_MANAGE',
  ],
  [Role.CONTENT_UPLOADER]: [
    'MOVIE_CREATE',
    'MOVIE_UPDATE',
    'VIDEO_UPLOAD',
    'SUBTITLE_MANAGE',
    'SERIES_MANAGE',
  ],
  [Role.USER]: [],
};

interface GuardedRoute {
  route: string;
  /** What gated it before (null = the route had no permission gate). */
  legacy: LegacyPermission | null;
  /** What gates it now (null = still no permission gate). */
  granular: Permission | null;
}

/**
 * Every route that carries a permission gate, decorator or otherwise —
 * including the 26 routes that used to inherit a class-level decorator and
 * the multipart-upload routes gated inside ResourceUploadTypeRegistry.
 */
const GUARDED_ROUTES: GuardedRoute[] = [
  // series
  {
    route: 'GET /series/episodes',
    legacy: 'SERIES_MANAGE',
    granular: 'SERIES.VIEW',
  },
  {
    route: 'GET /series/episodes/count',
    legacy: 'SERIES_MANAGE',
    granular: 'SERIES.VIEW',
  },
  { route: 'POST /series', legacy: 'SERIES_MANAGE', granular: 'SERIES.CREATE' },
  {
    route: 'PUT /series/:id',
    legacy: 'SERIES_MANAGE',
    granular: 'SERIES.EDIT',
  },
  {
    route: 'PATCH /series/:id/status',
    legacy: 'SERIES_MANAGE',
    granular: 'SERIES.PUBLISH',
  },
  {
    route: 'DELETE /series/:id',
    legacy: 'SERIES_MANAGE',
    granular: 'SERIES.DELETE',
  },
  // payment accounts + methods
  {
    route: 'POST /payment-accounts/types',
    legacy: 'PAYMENT_ACCOUNT_MANAGE',
    granular: 'PAYMENT_METHODS.CREATE',
  },
  {
    route: 'PATCH /payment-accounts/types/:id',
    legacy: 'PAYMENT_ACCOUNT_MANAGE',
    granular: 'PAYMENT_METHODS.EDIT',
  },
  {
    route: 'DELETE /payment-accounts/types/:id',
    legacy: 'PAYMENT_ACCOUNT_MANAGE',
    granular: 'PAYMENT_METHODS.DELETE',
  },
  {
    route: 'GET /payment-accounts/transactions',
    legacy: 'PAYMENT_ACCOUNT_MANAGE',
    granular: 'PAYMENT_ACCOUNTS.LEDGER_MANAGE',
  },
  {
    route: 'GET /payment-accounts/:id',
    legacy: 'PAYMENT_ACCOUNT_MANAGE',
    granular: 'PAYMENT_ACCOUNTS.VIEW',
  },
  {
    route: 'GET /payment-accounts/:id/transactions',
    legacy: 'PAYMENT_ACCOUNT_MANAGE',
    granular: 'PAYMENT_ACCOUNTS.LEDGER_MANAGE',
  },
  {
    route: 'POST /payment-accounts/:id/transactions',
    legacy: 'PAYMENT_ACCOUNT_MANAGE',
    granular: 'PAYMENT_ACCOUNTS.LEDGER_MANAGE',
  },
  {
    route: 'POST /payment-accounts',
    legacy: 'PAYMENT_ACCOUNT_MANAGE',
    granular: 'PAYMENT_ACCOUNTS.CREATE',
  },
  {
    route: 'PATCH /payment-accounts/:id',
    legacy: 'PAYMENT_ACCOUNT_MANAGE',
    granular: 'PAYMENT_ACCOUNTS.EDIT',
  },
  {
    route: 'DELETE /payment-accounts/:id',
    legacy: 'PAYMENT_ACCOUNT_MANAGE',
    granular: 'PAYMENT_ACCOUNTS.DELETE',
  },
  // peak users
  {
    route: 'GET /peak-users/admin',
    legacy: 'PEAK_USERS_MANAGE',
    granular: 'PEAK_USERS.VIEW',
  },
  {
    route: 'PATCH /peak-users/additional',
    legacy: 'PEAK_USERS_MANAGE',
    granular: 'PEAK_USERS.MANAGE',
  },
  // uploads (class-level VIDEO_UPLOAD, expanded)
  {
    route: 'POST /uploads/init',
    legacy: 'VIDEO_UPLOAD',
    granular: 'MEDIA.UPLOAD',
  },
  {
    route: 'POST /uploads/:uploadId/chunk',
    legacy: 'VIDEO_UPLOAD',
    granular: 'MEDIA.UPLOAD',
  },
  {
    route: 'GET /uploads/:uploadId/status',
    legacy: 'VIDEO_UPLOAD',
    granular: 'MEDIA.UPLOAD',
  },
  {
    route: 'POST /uploads/:uploadId/complete',
    legacy: 'VIDEO_UPLOAD',
    granular: 'MEDIA.UPLOAD',
  },
  {
    route: 'POST /uploads/:movieId/reprocess',
    legacy: 'VIDEO_UPLOAD',
    granular: 'MEDIA.UPLOAD',
  },
  {
    route: 'POST /uploads/:movieId/validate-external',
    legacy: 'VIDEO_UPLOAD',
    granular: 'MEDIA.UPLOAD',
  },
  {
    route: 'POST /uploads/:movieId/finalize',
    legacy: 'VIDEO_UPLOAD',
    granular: 'MEDIA.UPLOAD',
  },
  {
    route: 'POST /uploads/image',
    legacy: 'MOVIE_CREATE',
    granular: 'MEDIA.UPLOAD',
  },
  // multipart uploads — gated by ResourceUploadTypeRegistry, not a decorator
  {
    route: 'POST /uploads/presign-batch',
    legacy: 'VIDEO_UPLOAD',
    granular: 'MEDIA.UPLOAD',
  },
  {
    route: 'POST /uploads/multipart/init',
    legacy: 'VIDEO_UPLOAD',
    granular: 'MEDIA.UPLOAD',
  },
  {
    route: 'POST /uploads/multipart/:sessionId/parts',
    legacy: 'VIDEO_UPLOAD',
    granular: 'MEDIA.UPLOAD',
  },
  {
    route: 'POST /uploads/multipart/:sessionId/complete',
    legacy: 'VIDEO_UPLOAD',
    granular: 'MEDIA.UPLOAD',
  },
  {
    route: 'POST /uploads/multipart/:sessionId/abort',
    legacy: 'VIDEO_UPLOAD',
    granular: 'MEDIA.UPLOAD',
  },
  // finance settings
  {
    route: 'PATCH /finance-settings',
    legacy: 'FINANCE_SETTINGS_MANAGE',
    granular: 'FINANCE.SETTINGS_MANAGE',
  },
  // subscription plans
  {
    route: 'POST /subscription-plans',
    legacy: 'SUBSCRIPTION_MANAGE',
    granular: 'SUBSCRIPTIONS.CREATE',
  },
  {
    route: 'PUT /subscription-plans/:id',
    legacy: 'SUBSCRIPTION_MANAGE',
    granular: 'SUBSCRIPTIONS.EDIT',
  },
  // deposits
  {
    route: 'GET /deposits',
    legacy: 'DEPOSIT_MANAGE',
    granular: 'DEPOSITS.VIEW',
  },
  {
    route: 'POST /deposits/manual',
    legacy: 'DEPOSIT_MANAGE',
    granular: 'DEPOSITS.CREATE',
  },
  {
    route: 'PATCH /deposits/:id/approve',
    legacy: 'DEPOSIT_MANAGE',
    granular: 'DEPOSITS.APPROVE',
  },
  {
    route: 'PATCH /deposits/:id/reject',
    legacy: 'DEPOSIT_MANAGE',
    granular: 'DEPOSITS.REJECT',
  },
  {
    route: 'PATCH /deposits/:id/receiving-account',
    legacy: 'DEPOSIT_MANAGE',
    granular: 'DEPOSITS.EDIT',
  },
  // transactions / finance / analytics
  {
    route: 'GET /transactions',
    legacy: 'FINANCE_VIEW',
    granular: 'FINANCE.VIEW',
  },
  {
    route: 'GET /finance/dashboard',
    legacy: 'FINANCE_VIEW',
    granular: 'FINANCE.VIEW',
  },
  {
    route: 'GET /finance/revenue-trend',
    legacy: 'FINANCE_VIEW',
    granular: 'FINANCE.VIEW',
  },
  {
    route: 'GET /analytics/overview',
    legacy: 'FINANCE_VIEW',
    granular: 'FINANCE.VIEW',
  },
  {
    route: 'GET /analytics/user-growth',
    legacy: 'FINANCE_VIEW',
    granular: 'FINANCE.VIEW',
  },
  // videos
  {
    route: 'GET /videos/status/:movieId',
    legacy: 'VIDEO_UPLOAD',
    granular: 'MEDIA.VIEW',
  },
  // users (class-level USER_MANAGE, expanded)
  { route: 'GET /users', legacy: 'USER_MANAGE', granular: 'USERS.VIEW' },
  {
    route: 'GET /users/relationships',
    legacy: 'USER_MANAGE',
    granular: 'USERS.VIEW',
  },
  { route: 'GET /users/:id', legacy: 'USER_MANAGE', granular: 'USERS.VIEW' },
  {
    route: 'GET /users/:id/purchases',
    legacy: 'USER_MANAGE',
    granular: 'USERS.VIEW',
  },
  {
    route: 'GET /users/:id/watch-history',
    legacy: 'USER_MANAGE',
    granular: 'USERS.VIEW',
  },
  {
    route: 'PATCH /users/:id/role',
    legacy: 'USER_MANAGE',
    granular: 'USERS.EDIT',
  },
  {
    route: 'PATCH /users/:id/status',
    legacy: 'USER_MANAGE',
    granular: 'USERS.SUSPEND',
  },
  {
    route: 'POST /users/:id/wallet-adjustments',
    legacy: 'WALLET_ADJUST',
    granular: 'USERS.WALLET_ADJUST',
  },
  {
    route: 'GET /users/:id/wallet-adjustments',
    legacy: 'WALLET_ADJUST',
    granular: 'USERS.WALLET_ADJUST',
  },
  { route: 'GET /users/me', legacy: null, granular: null },
  { route: 'POST /users/me/avatar', legacy: null, granular: null },
  { route: 'DELETE /users/me/avatar', legacy: null, granular: null },
  // withdrawals
  {
    route: 'GET /withdrawals',
    legacy: 'WITHDRAWAL_MANAGE',
    granular: 'WITHDRAWALS.VIEW',
  },
  {
    route: 'PATCH /withdrawals/:id/approve',
    legacy: 'WITHDRAWAL_MANAGE',
    granular: 'WITHDRAWALS.APPROVE',
  },
  {
    route: 'PATCH /withdrawals/:id/reject',
    legacy: 'WITHDRAWAL_MANAGE',
    granular: 'WITHDRAWALS.REJECT',
  },
  {
    route: 'PATCH /withdrawals/:id/transfer-account',
    legacy: 'WITHDRAWAL_MANAGE',
    granular: 'WITHDRAWALS.EDIT',
  },
  // staff (class-level STAFF_MANAGE, expanded)
  { route: 'GET /staff', legacy: 'STAFF_MANAGE', granular: 'STAFF.VIEW' },
  { route: 'POST /staff', legacy: 'STAFF_MANAGE', granular: 'STAFF.CREATE' },
  { route: 'PATCH /staff/:id', legacy: 'STAFF_MANAGE', granular: 'STAFF.EDIT' },
  {
    route: 'PATCH /staff/:id/password',
    legacy: 'STAFF_MANAGE',
    granular: 'STAFF.EDIT',
  },
  {
    route: 'PATCH /staff/:id/status',
    legacy: 'STAFF_MANAGE',
    granular: 'STAFF.EDIT',
  },
  {
    route: 'DELETE /staff/:id',
    legacy: 'STAFF_MANAGE',
    granular: 'STAFF.DELETE',
  },
  // movies
  { route: 'POST /movies', legacy: 'MOVIE_CREATE', granular: 'MOVIES.CREATE' },
  {
    route: 'POST /movies/upload-placeholder',
    legacy: 'MOVIE_CREATE',
    granular: 'MOVIES.CREATE',
  },
  { route: 'PUT /movies/:id', legacy: 'MOVIE_UPDATE', granular: 'MOVIES.EDIT' },
  {
    route: 'DELETE /movies/:id',
    legacy: 'MOVIE_DELETE',
    granular: 'MOVIES.DELETE',
  },
  // subtitles (class-level SUBTITLE_MANAGE, expanded)
  {
    route: 'POST /subtitles',
    legacy: 'SUBTITLE_MANAGE',
    granular: 'MEDIA.UPLOAD',
  },
  {
    route: 'GET /subtitles',
    legacy: 'SUBTITLE_MANAGE',
    granular: 'MEDIA.VIEW',
  },
  {
    route: 'PATCH /subtitles/:id',
    legacy: 'SUBTITLE_MANAGE',
    granular: 'MEDIA.UPLOAD',
  },
  {
    route: 'PATCH /subtitles/:id/set-default',
    legacy: 'SUBTITLE_MANAGE',
    granular: 'MEDIA.UPLOAD',
  },
  {
    route: 'DELETE /subtitles/:id',
    legacy: 'SUBTITLE_MANAGE',
    granular: 'MEDIA.DELETE',
  },
  // categories
  {
    route: 'POST /categories',
    legacy: 'MOVIE_CREATE',
    granular: 'CATEGORIES.CREATE',
  },
  {
    route: 'PUT /categories/:id',
    legacy: 'MOVIE_UPDATE',
    granular: 'CATEGORIES.EDIT',
  },
  {
    route: 'DELETE /categories/:id',
    legacy: 'MOVIE_DELETE',
    granular: 'CATEGORIES.DELETE',
  },
];

/**
 * Routes introduced AFTER the RBAC migration, so there is no pre-RBAC world
 * for them to be at parity with — nothing could have granted access to a
 * screen that did not exist, and listing them above with `legacy: null`
 * would assert the opposite ("everyone could reach this before").
 *
 * What is worth asserting instead is what the seeds actually let through, so
 * a future edit to a seed list cannot silently open the Tracking section to
 * a role that was never meant to have it.
 */
interface PostRbacRoute {
  route: string;
  /** Every permission the route requires — PermissionsGuard demands ALL of them. */
  granular: Permission[];
  /** System roles the seeds are expected to admit. */
  allowed: Role[];
}

const STAFF_ONLY: Role[] = [Role.SUPER_ADMIN, Role.ADMIN];

const POST_RBAC_GUARDED_ROUTES: PostRbacRoute[] = [
  // tracking (admin Tracking section — BACKEND 4)
  {
    route: 'GET /tracking/comments',
    granular: ['TRACKING.VIEW'],
    allowed: STAFF_ONLY,
  },
  {
    route: 'PATCH /tracking/comments/:id',
    granular: ['TRACKING.VIEW', 'TRACKING.COMMENTS_MODERATE'],
    allowed: STAFF_ONLY,
  },
  {
    route: 'GET /tracking/feedback',
    granular: ['TRACKING.VIEW'],
    allowed: STAFF_ONLY,
  },
  {
    route: 'PATCH /tracking/feedback/:id',
    granular: ['TRACKING.VIEW', 'TRACKING.FEEDBACK_MANAGE'],
    allowed: STAFF_ONLY,
  },
  {
    route: 'GET /tracking/active-users',
    granular: ['TRACKING.VIEW'],
    allowed: STAFF_ONLY,
  },
  {
    route: 'GET /tracking/watch-time',
    granular: ['TRACKING.VIEW'],
    allowed: STAFF_ONLY,
  },
  {
    route: 'GET /tracking/searches',
    granular: ['TRACKING.VIEW'],
    allowed: STAFF_ONLY,
  },
  {
    route: 'GET /tracking/searches/recent',
    granular: ['TRACKING.VIEW'],
    allowed: STAFF_ONLY,
  },
  {
    route: 'GET /tracking/sessions',
    granular: ['TRACKING.VIEW'],
    allowed: STAFF_ONLY,
  },
  {
    route: 'GET /tracking/sessions/:userId',
    granular: ['TRACKING.VIEW'],
    allowed: STAFF_ONLY,
  },
];

const seedFor = (role: Role) => {
  const seed = SYSTEM_ROLE_SEEDS.find((candidate) => candidate.key === role);
  if (!seed) throw new Error(`No seed for ${role}`);
  return seed;
};

/** Post-migration: what the seeded role grants (protected = everything). */
function granularAllows(role: Role, permission: Permission | null): boolean {
  if (permission === null) return true;
  const seed = seedFor(role);
  if (seed.isProtected) return true;
  return seed.permissions.includes(permission);
}

/** Pre-migration: what ROLE_PERMISSIONS granted. */
function legacyAllows(
  role: Role,
  permission: LegacyPermission | null,
): boolean {
  if (permission === null) return true;
  return LEGACY_ROLE_PERMISSIONS[role].includes(permission);
}

const ROLES = Object.values(Role);

describe('System role seeds', () => {
  it('seeds exactly the four built-in roles, keyed by the Role enum', () => {
    expect(SYSTEM_ROLE_SEEDS.map((seed) => seed.key).sort()).toEqual(
      [...ROLES].sort(),
    );
  });

  it('marks only SUPER_ADMIN protected', () => {
    expect(
      SYSTEM_ROLE_SEEDS.filter((seed) => seed.isProtected).map((s) => s.key),
    ).toEqual([Role.SUPER_ADMIN]);
  });

  it('grants SUPER_ADMIN every permission in the catalogue', () => {
    expect(seedFor(Role.SUPER_ADMIN).permissions).toEqual(ALL_PERMISSIONS);
  });

  it('grants USER nothing — the website/mobile account kind', () => {
    expect(seedFor(Role.USER).permissions).toEqual([]);
  });

  /**
   * Sizes as of the `add_tracking` migration: the TRACKING module added four
   * permissions to the catalogue (so SUPER_ADMIN, which is every permission,
   * went 61 -> 65) and all four were INSERTed for ADMIN (32 -> 36).
   * CONTENT_UPLOADER deliberately received none.
   */
  it('has the expected seed sizes (65 / 36 / 16 / 0, matching the migrations)', () => {
    expect({
      SUPER_ADMIN: seedFor(Role.SUPER_ADMIN).permissions.length,
      ADMIN: seedFor(Role.ADMIN).permissions.length,
      CONTENT_UPLOADER: seedFor(Role.CONTENT_UPLOADER).permissions.length,
      USER: seedFor(Role.USER).permissions.length,
    }).toEqual({
      SUPER_ADMIN: 65,
      ADMIN: 36,
      CONTENT_UPLOADER: 16,
      USER: 0,
    });
  });

  it('only ever grants permissions that exist in the catalogue', () => {
    for (const seed of SYSTEM_ROLE_SEEDS) {
      for (const permission of seed.permissions) {
        expect(ALL_PERMISSIONS).toContain(permission);
      }
    }
  });

  it('never grants the same permission twice', () => {
    for (const seed of SYSTEM_ROLE_SEEDS) {
      expect(new Set(seed.permissions).size).toBe(seed.permissions.length);
    }
  });
});

describe('System role seeds — access parity with the pre-RBAC ROLE_PERMISSIONS map', () => {
  it.each(GUARDED_ROUTES)(
    '$route grants the same four system roles as before',
    ({ route, legacy, granular }) => {
      const before = Object.fromEntries(
        ROLES.map((role) => [role, legacyAllows(role, legacy)]),
      );
      const after = Object.fromEntries(
        ROLES.map((role) => [role, granularAllows(role, granular)]),
      );
      expect({ route, ...after }).toEqual({ route, ...before });
    },
  );

  /**
   * Route budget, so a forgotten remap shows up as a failing count rather
   * than silently unguarded traffic:
   *   44 method-level decorator routes (51 sites minus the 7 class-level ones),
   *   3 of which are auth-only (@RequirePermissions() on /users/me*)
   * + 30 routes behind those 7 class-level decorators
   * + 5 MultipartUploadController routes gated by ResourceUploadTypeRegistry
   * = 79 routes, 76 of them permission-gated.
   *
   * Routes added since the migration are counted in
   * POST_RBAC_GUARDED_ROUTES instead — this number is frozen at what the
   * migration had to preserve.
   */
  it('covers every permission-gated route in the backend', () => {
    expect(GUARDED_ROUTES).toHaveLength(79);
    expect(GUARDED_ROUTES.filter((r) => r.granular !== null)).toHaveLength(76);
    expect(GUARDED_ROUTES.filter((r) => r.granular === null)).toHaveLength(3);
  });
});

describe('System role seeds — routes added after the RBAC migration', () => {
  it.each(POST_RBAC_GUARDED_ROUTES)(
    '$route admits exactly the intended system roles',
    ({ route, granular, allowed }) => {
      const actual = ROLES.filter((role) =>
        granular.every((permission) => granularAllows(role, permission)),
      );
      expect({ route, roles: actual }).toEqual({ route, roles: allowed });
    },
  );

  it('gates every post-migration route on at least one permission', () => {
    for (const { route, granular } of POST_RBAC_GUARDED_ROUTES) {
      expect({ route, gated: granular.length > 0 }).toEqual({
        route,
        gated: true,
      });
    }
  });

  /**
   * Budget for the second table: the whole Tracking section, 10 routes —
   * 8 read routes under one class-level TRACKING.VIEW plus the two
   * moderation PATCHes that additionally require their own action.
   */
  it('covers every post-migration permission-gated route', () => {
    expect(POST_RBAC_GUARDED_ROUTES).toHaveLength(10);
    expect(
      POST_RBAC_GUARDED_ROUTES.filter((r) => r.granular.length > 1),
    ).toHaveLength(2);
  });

  it('leaves the backend with 89 permission-gated routes in total', () => {
    const gatedLegacy = GUARDED_ROUTES.filter((r) => r.granular !== null);
    expect(gatedLegacy.length + POST_RBAC_GUARDED_ROUTES.length).toBe(86);
    expect(GUARDED_ROUTES.length + POST_RBAC_GUARDED_ROUTES.length).toBe(89);
  });
});
