import { Role } from '../generated/prisma/client';
import type { Permission } from './permission-catalogue';
import { ALL_PERMISSIONS } from './permission-catalogue';

export interface SystemRoleSeed {
  /** Matches the `Role` enum member, so a user with no explicit AppRole falls back to it. */
  key: Role;
  name: string;
  description: string;
  /** SUPER_ADMIN only — its permission set can never be edited or removed. */
  isProtected: boolean;
  permissions: Permission[];
}

/**
 * The four built-in roles, seeded by the `add_rbac_roles` migration.
 *
 * Each set is the granular expansion of what `ROLE_PERMISSIONS` granted that
 * role before this refactor, so migrating changes nobody's effective access.
 * `system-roles.seed.spec.ts` proves that route by route — edit these lists
 * only together with that proof.
 */
export const SYSTEM_ROLE_SEEDS: SystemRoleSeed[] = [
  {
    key: Role.SUPER_ADMIN,
    name: 'Super Admin',
    description:
      'Full access to every module. Protected: its permissions cannot be edited and it cannot be deleted.',
    isProtected: true,
    permissions: [...ALL_PERMISSIONS],
  },
  {
    key: Role.ADMIN,
    name: 'Admin',
    description:
      'Content, categories and day-to-day finance operations (deposits, withdrawals, subscription plans).',
    isProtected: false,
    permissions: [
      'DASHBOARD.VIEW',
      'MOVIES.VIEW',
      'MOVIES.CREATE',
      'MOVIES.EDIT',
      'MOVIES.DELETE',
      'MOVIES.PUBLISH',
      'MOVIES.UNPUBLISH',
      'SERIES.VIEW',
      'SERIES.CREATE',
      'SERIES.EDIT',
      'SERIES.DELETE',
      'SERIES.PUBLISH',
      'SERIES.UNPUBLISH',
      // Added by the `add_books` migration, which INSERTs exactly these six
      // rows for this role — books are content, and content is Admin's.
      'BOOKS.VIEW',
      'BOOKS.CREATE',
      'BOOKS.EDIT',
      'BOOKS.DELETE',
      'BOOKS.PUBLISH',
      'BOOKS.UNPUBLISH',
      'MEDIA.VIEW',
      'MEDIA.UPLOAD',
      'MEDIA.DELETE',
      'CATEGORIES.VIEW',
      'CATEGORIES.CREATE',
      'CATEGORIES.EDIT',
      'CATEGORIES.DELETE',
      // Added by the `add_actors` migration, which INSERTs exactly these
      // four rows for this role — the cast list is catalog metadata, and
      // catalog metadata is Admin's.
      'ACTORS.VIEW',
      'ACTORS.CREATE',
      'ACTORS.EDIT',
      'ACTORS.DELETE',
      'DEPOSITS.VIEW',
      'DEPOSITS.APPROVE',
      'DEPOSITS.REJECT',
      'DEPOSITS.CREATE',
      'DEPOSITS.EDIT',
      'WITHDRAWALS.VIEW',
      'WITHDRAWALS.APPROVE',
      'WITHDRAWALS.REJECT',
      'WITHDRAWALS.EDIT',
      'SUBSCRIPTIONS.VIEW',
      'SUBSCRIPTIONS.CREATE',
      'SUBSCRIPTIONS.EDIT',
      // Added by the `add_tracking` migration, which INSERTs exactly these
      // four rows for this role — day-to-day operations is who reads
      // comments, triages feedback and looks up an account by phone/IP.
      'TRACKING.VIEW',
      'TRACKING.COMMENTS_MODERATE',
      'TRACKING.FEEDBACK_MANAGE',
      'TRACKING.PII_VIEW',
      // Added by the `home_promos` migration, which INSERTs exactly these
      // two rows for this role — the home page's promos and settings are
      // day-to-day operations, like subscription plans.
      'HOME.VIEW',
      'HOME.MANAGE',
      // Added by the advertisements migration (2026-11-04).
      'ADS.VIEW',
      'ADS.MANAGE',
      // Added by the `lottery_dreams` migration, which INSERTs exactly these
      // two rows for this role — the dream books are day-to-day operations
      // too.
      'LOTTERY.VIEW',
      'LOTTERY.DREAMS_MANAGE',
      // Added by the `lottery_draws` migration, which INSERTs exactly these
      // two rows for this role — draws and prices are day-to-day
      // operations like deposits and subscription plans.
      'LOTTERY.DRAWS_MANAGE',
      'LOTTERY.SETTINGS_MANAGE',
      // Added by the `lottery_results` migration, which INSERTs exactly
      // this one row for this role — fetching, entering and publishing a
      // draw's results is day-to-day operations like approving a
      // withdrawal.
      'LOTTERY.RESULTS_PUBLISH',
      // Added by the `lottery_claims` migration, which INSERTs exactly this
      // one row for this role — confirming a customer's prize claim (the
      // wallet credit) is day-to-day operations like approving a deposit.
      'LOTTERY.CLAIMS_CONFIRM',
    ],
  },
  {
    key: Role.CONTENT_UPLOADER,
    name: 'Content Uploader',
    description:
      'Content ingestion only — movies, series and their media. No finance, users or staff.',
    isProtected: false,
    permissions: [
      'MOVIES.VIEW',
      'MOVIES.CREATE',
      'MOVIES.EDIT',
      'MOVIES.PUBLISH',
      'MOVIES.UNPUBLISH',
      'SERIES.VIEW',
      'SERIES.CREATE',
      'SERIES.EDIT',
      'SERIES.DELETE',
      'SERIES.PUBLISH',
      'SERIES.UNPUBLISH',
      // Added by the `add_books` migration — mirrors this role's movie
      // grants: ingest and publish, but no delete.
      'BOOKS.VIEW',
      'BOOKS.CREATE',
      'BOOKS.EDIT',
      'BOOKS.PUBLISH',
      'BOOKS.UNPUBLISH',
      'MEDIA.VIEW',
      'MEDIA.UPLOAD',
      'MEDIA.DELETE',
      'CATEGORIES.CREATE',
      'CATEGORIES.EDIT',
      // Added by the `add_actors` migration — this role tags the cast while
      // ingesting a film, but removing a person from the catalogue entirely
      // is not its job.
      'ACTORS.VIEW',
      'ACTORS.CREATE',
      'ACTORS.EDIT',
    ],
  },
  {
    key: Role.USER,
    name: 'User',
    description:
      'End-user accounts (website and mobile). No admin permissions at all.',
    isProtected: false,
    permissions: [],
  },
];

/** True for the four built-in role keys — used to keep `User.role` in sync with an assigned AppRole. */
export function isSystemRoleKey(key: string): key is Role {
  return (Object.values(Role) as string[]).includes(key);
}
