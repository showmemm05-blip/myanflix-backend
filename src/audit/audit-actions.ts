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
  'bank_transaction',
  'payment_account',
  'payment_method_type',
  'payment_account_transaction',
  'wallet_adjustment',
  'finance_settings',
  'subscription_plan',
  'peak_users',
  'comment',
  'feedback',
  /** The OTP SMS gateway phone (its token-to-device pin). */
  'sms_gateway',
  /** The phone-monitor's bank-events token (its token-to-device pin, SEC-004). */
  'bank_events',
  /** A still image uploaded through POST /uploads/image — no owner row exists yet, so targetId is null and metadata carries the key. */
  'image',
  /** A slide / spotlight / coming-soon card on the admin "Home promos" page. */
  'home_promo',
  /** The single home settings row (web address, store links, games teaser). */
  'home_settings',
  /** One pre-roll video ad on the admin "Advertisements" page. */
  'advertisement',
  /** The single playback-rules row of the "Advertisements" page. */
  'advertisement_settings',
  /** One dream of a Lottery dream book (admin "Lottery > Dreams" page). */
  'lottery_dream',
  /** One Thai lottery draw as sold here (admin "Lottery > Draws" page). */
  'lottery_draw',
  /** The single lottery settings row (ticket price, per-number limit, exchange rate, sales-close gap). */
  'lottery_settings',
  /** One draw's winning numbers (the sheet fetched from the results source or entered by hand). */
  'lottery_results',
  /** One customer's prize claim for one draw (admin "Lottery > Prize claims" page). */
  'lottery_claim',
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
  /**
   * A finalize-replace that reached the swap (POST /uploads/:movieId/
   * finalize-replace): before/after are the Video + Subtitle snapshots,
   * metadata.outcome is `replaced` or `interrupted`. The Movie row and its
   * status are never part of it — they do not change.
   */
  define('movie.video_replace', CONTENT, 'movie'),
  /**
   * The storage-writing steps of a direct upload, each one a staff act on
   * the title's files (M-22): presigned PUT URLs handed out for a batch of
   * bundle files (metadata.fileCount + relativePaths), and a multipart
   * session opened / completed / aborted (metadata.phase). The resource
   * type ("movie" or "movie-replace") is in metadata.resourceType.
   */
  define('movie.upload_presign', CONTENT, 'movie'),
  define('movie.upload_multipart', CONTENT, 'movie'),
  /**
   * A chunked session opened for one BUNDLE file (POST /uploads/init with a
   * relativePath) — one row per file, never per chunk; metadata has the
   * uploadId, relativePath, object key and fileSize. The classic
   * single-file session is not recorded here: its complete writes
   * movie.upload.
   */
  define('movie.upload_chunked', CONTENT, 'movie'),
  /** A replace opened (staging cleared) or abandoned (staging cleared) — the swap itself is movie.video_replace. */
  define('movie.video_replace_begin', CONTENT, 'movie'),
  define('movie.video_replace_cancel', CONTENT, 'movie'),
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
  /**
   * The manual backfill / repair (POST /subtitles/:id/publish and
   * POST /subtitles/publish?movieId=): rewrites the movie's HLS subtitle
   * group from the current rows. Addressed by movie, targetId is null;
   * metadata carries the outcome (`skipped` reason or the published /
   * excluded counts and whether the master actually changed).
   */
  define('subtitle.publish', CONTENT, 'subtitle'),
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
  /** The "book" direct-upload type (a chapter's source PDF) — same shape as the movie ones above. */
  define('book.upload_presign', CONTENT, 'book'),
  define('book.upload_multipart', CONTENT, 'book'),

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

  /** POST /uploads/image: metadata has the purpose folder, the object key and the byte size. */
  define('image.upload', CONTENT, 'image'),

  define('book_author.create', CONTENT, 'book_author'),
  define('book_author.update', CONTENT, 'book_author'),
  define('book_author.delete', CONTENT, 'book_author'),

  define('book_category.create', CONTENT, 'book_category'),
  define('book_category.update', CONTENT, 'book_category'),
  define('book_category.delete', CONTENT, 'book_category'),

  /**
   * The admin "Home promos" page. create / update / delete carry the
   * homePromoSnapshot; reorder is ONE row per drag (targetId null,
   * metadata: kind + the id order before and after).
   */
  define('home_promo.create', CONTENT, 'home_promo'),
  define('home_promo.update', CONTENT, 'home_promo'),
  define('home_promo.delete', CONTENT, 'home_promo'),
  define('home_promo.reorder', CONTENT, 'home_promo'),
  define('home_settings.update', CONTENT, 'home_settings'),

  /**
   * Pre-roll video ads (2026-11-04). create / update / delete are the
   * admin form; video_attach is POST /ads/admin/:id/video/attach landing a
   * checked MP4 (metadata: bytes, duration, the key replaced);
   * upload_presign / upload_multipart are the direct-to-MinIO upload steps
   * of the "ad" resource type, filed by MultipartUploadService exactly as
   * the movie and book uploads are. Viewer playback events are never
   * audited (USER actors are skipped).
   */
  define('advertisement.create', CONTENT, 'advertisement'),
  define('advertisement.update', CONTENT, 'advertisement'),
  define('advertisement.delete', CONTENT, 'advertisement'),
  define('advertisement.video_attach', CONTENT, 'advertisement'),
  define('advertisement.image_attach', CONTENT, 'advertisement'),
  define('advertisement.upload_presign', CONTENT, 'advertisement'),
  define('advertisement.upload_multipart', CONTENT, 'advertisement'),
  /** The playback rules (today: minutes before the same title shows an ad again). */
  define('advertisement_settings.update', CONTENT, 'advertisement_settings'),

  /**
   * The admin "Lottery > Dreams" page. update carries the
   * lotteryDreamSnapshot before/after; import is ONE row per applied
   * spreadsheet (targetId null, metadata: the file name and the
   * total / updated / unchanged / error counts). A dry run writes nothing.
   */
  define('lottery_dream.update', CONTENT, 'lottery_dream'),
  define('lottery_dream.import', CONTENT, 'lottery_dream'),

  /**
   * The admin "Lottery > Draws" page. create / update carry the
   * lotteryDrawSnapshot; open / pause / close / reopen are the status
   * changes (close is also written by the minute cron as a system row,
   * actor null, metadata.trigger = 'sales_close'; reopen puts a CLOSED
   * draw back on sale while its close time is still ahead and no sheet is
   * in); off_sale is ONE row per saved list (metadata: before / after /
   * added / removed counts).
   */
  define('lottery_draw.create', CONTENT, 'lottery_draw'),
  define('lottery_draw.update', CONTENT, 'lottery_draw'),
  define('lottery_draw.open', CONTENT, 'lottery_draw'),
  define('lottery_draw.pause', CONTENT, 'lottery_draw'),
  define('lottery_draw.close', CONTENT, 'lottery_draw'),
  define('lottery_draw.reopen', CONTENT, 'lottery_draw'),
  define('lottery_draw.off_sale', CONTENT, 'lottery_draw'),

  /**
   * A draw's winning numbers (phase 3). fetch is written when the sheet
   * arrives from the results source — by the five-minute cron as a
   * system row (actor null, metadata.trigger = 'cron') or by "Fetch now"
   * (the staff member, trigger 'manual'); enter when a staff member types
   * the sheet in (before/after carry the lotteryResultSnapshot, metadata
   * the note). A fetch that found nothing new writes no row.
   */
  define('lottery_results.fetch', CONTENT, 'lottery_results'),
  define('lottery_results.enter', CONTENT, 'lottery_results'),

  // --- USERS --------------------------------------------------------------
  define('user.status_change', USERS, 'user'),
  define('user.role_change', USERS, 'user'),
  /**
   * Target is the user; metadata carries direction, amount, reason,
   * balanceBefore/After, adjustmentId and transactionId.
   */
  define('user.wallet_adjust', USERS, 'user'),
  /**
   * Self-service "forgot password" (POST /auth/password/reset, H-8): phone +
   * SMS code + new password. The owner is the actor (the row is forced past
   * the end-user filter); every session was revoked. No values, ever.
   */
  define('user.password_reset', USERS, 'user'),
  /**
   * The owner deleted their own account (DELETE /users/me, H-16): personal
   * data anonymised, status CLOSED, sessions revoked, money records kept.
   * Actor = the owner, already under the anonymised username.
   */
  define('user.account_delete', USERS, 'user'),

  // --- STAFF --------------------------------------------------------------
  define('staff.create', STAFF, 'staff'),
  define('staff.update', STAFF, 'staff'),
  /** PATCH /staff/:id that changed role/appRoleId. */
  define('staff.role_change', STAFF, 'staff'),
  define('staff.status_change', STAFF, 'staff'),
  /** No values are ever stored for this one — not even hashed. */
  define('staff.password_reset', STAFF, 'staff'),
  /**
   * Self-service: the signed-in staff member changed their OWN password via
   * PATCH /users/me/password. No values are ever stored — not even hashed.
   * End users on the same route are skipped by AuditService (role USER).
   */
  define('staff.password_change', STAFF, 'staff'),
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

  /**
   * bank_transactions rows — one per phone notification, stored before
   * matching. `store`, `link`, `state_change` and `screenshot_attach` are
   * system rows (actor null, metadata.source = 'phone-monitor', or
   * metadata.trigger = 'deposit_create' when a freshly submitted deposit
   * claimed a waiting transfer); `unlink` is the staff member's decision
   * on a deposit/withdrawal review. Never amounts or codes in the log
   * line — the snapshots carry them, as deposit.bank_match's do.
   */
  define('bank_transaction.store', FINANCE, 'bank_transaction'),
  define('bank_transaction.link', FINANCE, 'bank_transaction'),
  define('bank_transaction.unlink', FINANCE, 'bank_transaction'),
  define('bank_transaction.state_change', FINANCE, 'bank_transaction'),
  define('bank_transaction.screenshot_attach', FINANCE, 'bank_transaction'),

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
  /** The lottery's money settings (ticket price, exchange rate, …) — before/after snapshots. */
  define('lottery_settings.update', FINANCE, 'lottery_settings'),
  /**
   * "Publish results" (phase 3): the draw's tickets are marked and every
   * prize is AWARDED (payouts UNCLAIMED — since 2026-10-24 nobody is paid
   * here; the draws published before that were). ONE row per publish,
   * before/after the lotteryDrawSnapshot, metadata { winners,
   * prizeTotalKs, prizesPaidKs, rate, source }. Kept under FINANCE: it
   * fixes what the draw owes.
   */
  define('lottery_draw.publish', FINANCE, 'lottery_draw'),
  /**
   * The admin "Lottery > Prize claims" page (2026-10-24). confirm is the
   * ONE wallet credit for a customer's claim (before/after the
   * lotteryClaimSnapshot, metadata { drawNo, ticketsCount, ks,
   * transactionId }); reject refuses it with a reason the customer sees
   * (metadata { drawNo, reason }); reopen puts a rejected claim back in the
   * waiting list (metadata { drawNo, previousReason }). Filed under FINANCE
   * like a deposit decision.
   */
  define('lottery_claim.confirm', FINANCE, 'lottery_claim'),
  define('lottery_claim.reject', FINANCE, 'lottery_claim'),
  define('lottery_claim.reopen', FINANCE, 'lottery_claim'),

  define('subscription_plan.create', FINANCE, 'subscription_plan'),
  define('subscription_plan.update', FINANCE, 'subscription_plan'),

  // --- SYSTEM -------------------------------------------------------------
  define('peak_users.update', SYSTEM, 'peak_users'),
  /** Status moderation (VISIBLE/HIDDEN). */
  define('comment.moderate', SYSTEM, 'comment'),
  /** Recorded only when the deleter is NOT the comment's owner. */
  define('comment.delete', SYSTEM, 'comment'),
  define('feedback.status_change', SYSTEM, 'feedback'),
  /**
   * A super admin cleared the device pin of the SMS gateway token
   * (DELETE /sms-gateway/binding); before/after carry the pinned device id.
   */
  define('sms_gateway.binding_reset', SYSTEM, 'sms_gateway'),
  /**
   * A phone-monitor presented the right BANK_EVENTS_TOKEN under a serial
   * other than the pinned one and was refused (SEC-004). A system row
   * (actor null); metadata carries both serials. One row per burst: a
   * repeat from the same serial within a minute is counted on the binding
   * row, not re-audited.
   */
  define('bank_events.rejected_device', SYSTEM, 'bank_events'),
  /**
   * A super admin cleared the device pin of the bank-events token
   * (DELETE /bank-events/binding); before/after carry the pinned serial.
   */
  define('bank_events.binding_reset', SYSTEM, 'bank_events'),
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
