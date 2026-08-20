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
      'MEDIA.VIEW',
      'MEDIA.UPLOAD',
      'MEDIA.DELETE',
      'CATEGORIES.VIEW',
      'CATEGORIES.CREATE',
      'CATEGORIES.EDIT',
      'CATEGORIES.DELETE',
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
      'MEDIA.VIEW',
      'MEDIA.UPLOAD',
      'MEDIA.DELETE',
      'CATEGORIES.CREATE',
      'CATEGORIES.EDIT',
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
