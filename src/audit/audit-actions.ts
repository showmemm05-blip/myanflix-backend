import { AuditCategory } from '../generated/prisma/client';

/**
 * The single source of truth for what the audit log can record: every
 * action key, the category it files under, and the kind of thing it acts
 * on. Served verbatim to the admin (GET /audit/catalogue) so the filter
 * dropdowns and the i18n label tables never drift from what the backend
 * actually writes.
 *
 * Keys are dotted `<targetType>.<verb>`. The prefix is deliberately always
 * the row's `targetType`, so a stored `action` alone says what was touched.
 *
 * Episodes are Movie rows with a `seriesId` and are recorded under
 * targetType `movie` (with `metadata.seriesId`) — there is no separate
 * `episode` type, by decision.
 */
export const AUDIT_TARGET_TYPES = [
  'movie',
  'series',
  'subtitle',
  'category',
  'actor',
  'book',
  'book_edition',
  'book_part',
  'book_chapter',
  'book_section',
  'book_author',
  'book_category',
  'user',
  'staff',
  'role',
  'level',
  'deposit',
  'withdrawal',
  'payment_account',
  'payment_method_type',
  'payment_account_transaction',
  'wallet_adjustment',
  'finance_settings',
  'subscription_plan',
  'peak_users',
  'comment',
  'feedback',
] as const;

export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number];

export interface AuditActionDefinition {
  key: string;
  category: AuditCategory;
  targetType: AuditTargetType;
}

const { CONTENT, USERS, FINANCE, STAFF, SYSTEM } = AuditCategory;

/** Spread into each definition so the list below stays one line per action. */
const define = <K extends string>(
  key: K,
  category: AuditCategory,
  targetType: AuditTargetType,
) => ({ key, category, targetType }) as const;

export const AUDIT_ACTIONS = [
  // --- CONTENT ------------------------------------------------------------
  define('movie.create', CONTENT, 'movie'),
  /** Finalize external / classic upload complete. */
  define('movie.upload', CONTENT, 'movie'),
  define('movie.reprocess', CONTENT, 'movie'),
  define('movie.update', CONTENT, 'movie'),
  define('movie.publish', CONTENT, 'movie'),
  define('movie.unpublish', CONTENT, 'movie'),
  define('movie.status_change', CONTENT, 'movie'),
  define('movie.delete', CONTENT, 'movie'),
  /** Bulk backfill — targetId null, metadata carries the counts. */
  define('movie.durations_backfill', CONTENT, 'movie'),

  define('series.create', CONTENT, 'series'),
  define('series.update', CONTENT, 'series'),
  define('series.publish', CONTENT, 'series'),
  define('series.unpublish', CONTENT, 'series'),
  define('series.status_change', CONTENT, 'series'),
  define('series.delete', CONTENT, 'series'),

  /** Subtitle rows carry metadata.movieId + metadata.videoId. */
  define('subtitle.upload', CONTENT, 'subtitle'),
  define('subtitle.update', CONTENT, 'subtitle'),
  define('subtitle.set_default', CONTENT, 'subtitle'),
  define('subtitle.delete', CONTENT, 'subtitle'),

  define('category.create', CONTENT, 'category'),
  define('category.update', CONTENT, 'category'),
  define('category.delete', CONTENT, 'category'),

  define('actor.create', CONTENT, 'actor'),
  define('actor.update', CONTENT, 'actor'),
  define('actor.delete', CONTENT, 'actor'),

  define('book.create', CONTENT, 'book'),
  define('book.update', CONTENT, 'book'),
  define('book.delete', CONTENT, 'book'),

  define('book_edition.create', CONTENT, 'book_edition'),
  define('book_edition.update', CONTENT, 'book_edition'),
  define('book_edition.publish', CONTENT, 'book_edition'),
  define('book_edition.unpublish', CONTENT, 'book_edition'),
  define('book_edition.status_change', CONTENT, 'book_edition'),
  define('book_edition.delete', CONTENT, 'book_edition'),

  define('book_part.create', CONTENT, 'book_part'),
  define('book_part.update', CONTENT, 'book_part'),
  define('book_part.delete', CONTENT, 'book_part'),
  define('book_part.reorder', CONTENT, 'book_part'),

  define('book_chapter.create', CONTENT, 'book_chapter'),
  define('book_chapter.update', CONTENT, 'book_chapter'),
  define('book_chapter.delete', CONTENT, 'book_chapter'),
  define('book_chapter.reorder', CONTENT, 'book_chapter'),
  /** PDF conversion started by a staff member. */
  define('book_chapter.process', CONTENT, 'book_chapter'),
  /** PDF conversion result (READY/FAILED) — a system event, actor null. */
  define('book_chapter.status_change', CONTENT, 'book_chapter'),

  define('book_section.create', CONTENT, 'book_section'),
  define('book_section.update', CONTENT, 'book_section'),
  define('book_section.delete', CONTENT, 'book_section'),
  define('book_section.reorder', CONTENT, 'book_section'),

  define('book_author.create', CONTENT, 'book_author'),
  define('book_author.update', CONTENT, 'book_author'),
  define('book_author.delete', CONTENT, 'book_author'),

  define('book_category.create', CONTENT, 'book_category'),
  define('book_category.update', CONTENT, 'book_category'),
  define('book_category.delete', CONTENT, 'book_category'),

  // --- USERS --------------------------------------------------------------
  define('user.status_change', USERS, 'user'),
  define('user.role_change', USERS, 'user'),
  /**
   * Target is the user; metadata carries direction, amount, reason,
   * balanceBefore/After, adjustmentId and transactionId.
   */
  define('user.wallet_adjust', USERS, 'user'),

  // --- STAFF --------------------------------------------------------------
  define('staff.create', STAFF, 'staff'),
  define('staff.update', STAFF, 'staff'),
  /** PATCH /staff/:id that changed role/appRoleId. */
  define('staff.role_change', STAFF, 'staff'),
  define('staff.status_change', STAFF, 'staff'),
  /** No values are ever stored for this one — not even hashed. */
  define('staff.password_reset', STAFF, 'staff'),
  define('staff.delete', STAFF, 'staff'),

  define('role.create', STAFF, 'role'),
  define('role.update', STAFF, 'role'),
  /** before/after = permission lists; metadata: { added, removed }. */
  define('role.permissions_change', STAFF, 'role'),
  define('role.delete', STAFF, 'role'),

  define('level.create', STAFF, 'level'),
  define('level.update', STAFF, 'level'),
  define('level.delete', STAFF, 'level'),
  define('level.reorder', STAFF, 'level'),

  // --- FINANCE ------------------------------------------------------------
  define('deposit.manual_create', FINANCE, 'deposit'),
  define('deposit.approve', FINANCE, 'deposit'),
  define('deposit.reject', FINANCE, 'deposit'),
  define('deposit.receiving_account_update', FINANCE, 'deposit'),
  /**
   * Bank-side events (bank-events module). The phone-monitor's writes are
   * system rows (actor null, metadata.source = 'phone-monitor', plus the
   * device serial and event idempotency key); verification_review is the
   * staff member's decision on a flagged row.
   */
  define('deposit.bank_match', FINANCE, 'deposit'),
  define('deposit.bank_screenshot_attach', FINANCE, 'deposit'),
  define('deposit.risk_update', FINANCE, 'deposit'),
  define('deposit.verification_review', FINANCE, 'deposit'),

  define('withdrawal.approve', FINANCE, 'withdrawal'),
  define('withdrawal.reject', FINANCE, 'withdrawal'),
  define('withdrawal.transfer_account_update', FINANCE, 'withdrawal'),
  define('withdrawal.bank_match', FINANCE, 'withdrawal'),
  define('withdrawal.bank_screenshot_attach', FINANCE, 'withdrawal'),
  define('withdrawal.risk_update', FINANCE, 'withdrawal'),
  define('withdrawal.verification_review', FINANCE, 'withdrawal'),

  define('payment_account.create', FINANCE, 'payment_account'),
  define('payment_account.update', FINANCE, 'payment_account'),
  define('payment_account.delete', FINANCE, 'payment_account'),
  /**
   * Target is the payment account; metadata carries the entry type, amount,
   * balanceBefore/After and transactionId.
   */
  define('payment_account.ledger_entry', FINANCE, 'payment_account'),

  define('payment_method_type.create', FINANCE, 'payment_method_type'),
  define('payment_method_type.update', FINANCE, 'payment_method_type'),
  define('payment_method_type.delete', FINANCE, 'payment_method_type'),

  define('finance_settings.update', FINANCE, 'finance_settings'),

  define('subscription_plan.create', FINANCE, 'subscription_plan'),
  define('subscription_plan.update', FINANCE, 'subscription_plan'),

  // --- SYSTEM -------------------------------------------------------------
  define('peak_users.update', SYSTEM, 'peak_users'),
  /** Status moderation (VISIBLE/HIDDEN). */
  define('comment.moderate', SYSTEM, 'comment'),
  /** Recorded only when the deleter is NOT the comment's owner. */
  define('comment.delete', SYSTEM, 'comment'),
  define('feedback.status_change', SYSTEM, 'feedback'),
] as const satisfies readonly AuditActionDefinition[];

/** Every action key, as a literal union — a typo is a compile error. */
export type AuditAction = (typeof AUDIT_ACTIONS)[number]['key'];

/** Flat list of keys, in catalogue order (what the DTO validates against). */
export const AUDIT_ACTION_KEYS: readonly AuditAction[] = AUDIT_ACTIONS.map(
  (action) => action.key,
);

const ACTION_INDEX: ReadonlyMap<string, AuditActionDefinition> = new Map(
  AUDIT_ACTIONS.map((action) => [action.key, action]),
);

export function isAuditAction(value: string): value is AuditAction {
  return ACTION_INDEX.has(value);
}

/** The catalogue entry for one action — category + targetType. */
export function getAuditActionDefinition(
  action: AuditAction,
): AuditActionDefinition {
  const definition = ACTION_INDEX.get(action);
  if (!definition) {
    // Unreachable for a well-typed caller; guards a stale string from a DB row.
    throw new Error(`Unknown audit action: ${action}`);
  }
  return definition;
}

export interface AuditCatalogue {
  categories: AuditCategory[];
  actions: AuditActionDefinition[];
  targetTypes: AuditTargetType[];
}

/** Wire shape served by `GET /audit/catalogue`. */
export function getAuditCatalogue(): AuditCatalogue {
  return {
    categories: Object.values(AuditCategory),
    actions: AUDIT_ACTIONS.map(({ key, category, targetType }) => ({
      key,
      category,
      targetType,
    })),
    targetTypes: [...AUDIT_TARGET_TYPES],
  };
}
