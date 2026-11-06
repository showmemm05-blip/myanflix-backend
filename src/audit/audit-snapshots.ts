import type {
  Actor,
  AppRole,
  BankTransaction,
  Book,
  BookAuthor,
  BookCategory,
  BookChapter,
  BookEdition,
  BookPart,
  BookSection,
  Category,
  Comment,
  Deposit,
  Feedback,
  FinanceSettings,
  HomePromo,
  Advertisement,
  AdSettings,
  HomeSettings,
  LotteryClaim,
  LotteryDraw,
  LotteryDream,
  LotteryResult,
  LotterySettings,
  Movie,
  PaymentAccount,
  PaymentMethodType,
  PeakUserStats,
  Prisma,
  Series,
  SubscriptionPlan,
  Subtitle,
  User,
  UserLevel,
  Withdrawal,
} from '../generated/prisma/client';

/**
 * Per-entity snapshot pickers — the WHITELIST of what an audit row may say
 * about each kind of target.
 *
 * Every picker takes a Prisma row (loosely: Partial<Row>, plus whichever
 * relations the snapshot wants, so a caller can pass the result of any
 * select/include it already has) and returns a plain object of the fields
 * worth diffing. Anything not listed here — passwords, Google ids, MinIO
 * bookkeeping, full TipTap documents — never reaches the log, and the
 * service still runs sanitizeSnapshot() over the result as a second net.
 *
 * Relation lists come out as `[{ id, name }]` so diffSnapshots can compare
 * them as sets and show names to the admin.
 */

export interface NamedRef {
  id: string;
  name: string;
}

type Snapshot = Record<string, unknown>;

/** Anything with an id and a name — a Category, an Actor, a BookCategory… */
type NamedRow = { id: string; name: string };

const nullIfUndefined = <T>(value: T | undefined): T | null =>
  value === undefined ? null : value;

/** Decimal or number → number; null/undefined stay null (unlike decimalToNumber). */
function money(
  value: Prisma.Decimal | number | null | undefined,
): number | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'number' ? value : value.toNumber();
}

function refs(list: readonly NamedRow[] | null | undefined): NamedRef[] {
  return (list ?? []).map(({ id, name }) => ({ id, name }));
}

/** `{ length }` of a stored JSON document — never the document itself. */
function contentLength(content: unknown): { length: number } | null {
  if (content === null || content === undefined) return null;
  const serialized =
    typeof content === 'string' ? content : JSON.stringify(content);
  return { length: serialized?.length ?? 0 };
}

/** First `max` characters of a body, for a recognisable label/preview. */
export function textPreview(
  value: string | null | undefined,
  max = 200,
): string | null {
  if (value === null || value === undefined) return null;
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

export type MovieSnapshotInput = Partial<Movie> & {
  categories?: readonly NamedRow[] | null;
  actors?: readonly NamedRow[] | null;
};

export function movieSnapshot(movie: MovieSnapshotInput): Snapshot {
  return {
    title: nullIfUndefined(movie.title),
    description: nullIfUndefined(movie.description),
    genre: nullIfUndefined(movie.genre),
    language: nullIfUndefined(movie.language),
    releaseYear: nullIfUndefined(movie.releaseYear),
    duration: nullIfUndefined(movie.duration),
    rating: nullIfUndefined(movie.rating),
    director: nullIfUndefined(movie.director),
    country: nullIfUndefined(movie.country),
    ageRating: nullIfUndefined(movie.ageRating),
    accessType: nullIfUndefined(movie.accessType),
    status: nullIfUndefined(movie.status),
    seriesId: nullIfUndefined(movie.seriesId),
    seasonNumber: nullIfUndefined(movie.seasonNumber),
    episodeNumber: nullIfUndefined(movie.episodeNumber),
    posterUrl: nullIfUndefined(movie.posterUrl),
    coverUrl: nullIfUndefined(movie.coverUrl),
    thumbnailUrl: nullIfUndefined(movie.thumbnailUrl),
    categories: refs(movie.categories),
    actors: refs(movie.actors),
  };
}

export type SeriesSnapshotInput = Partial<Series> & {
  categories?: readonly NamedRow[] | null;
  actors?: readonly NamedRow[] | null;
};

export function seriesSnapshot(series: SeriesSnapshotInput): Snapshot {
  return {
    title: nullIfUndefined(series.title),
    description: nullIfUndefined(series.description),
    genre: nullIfUndefined(series.genre),
    language: nullIfUndefined(series.language),
    country: nullIfUndefined(series.country),
    releaseYear: nullIfUndefined(series.releaseYear),
    rating: nullIfUndefined(series.rating),
    accessType: nullIfUndefined(series.accessType),
    status: nullIfUndefined(series.status),
    posterUrl: nullIfUndefined(series.posterUrl),
    coverUrl: nullIfUndefined(series.coverUrl),
    categories: refs(series.categories),
    actors: refs(series.actors),
  };
}

export type BookSnapshotInput = Partial<Book> & {
  categories?: readonly NamedRow[] | null;
};

export function bookSnapshot(book: BookSnapshotInput): Snapshot {
  return {
    title: nullIfUndefined(book.title),
    author: nullIfUndefined(book.author),
    authorId: nullIfUndefined(book.authorId),
    description: nullIfUndefined(book.description),
    coverUrl: nullIfUndefined(book.coverUrl),
    type: nullIfUndefined(book.type),
    categories: refs(book.categories),
  };
}

export function bookEditionSnapshot(edition: Partial<BookEdition>): Snapshot {
  return {
    bookId: nullIfUndefined(edition.bookId),
    language: nullIfUndefined(edition.language),
    status: nullIfUndefined(edition.status),
    publishedAt: nullIfUndefined(edition.publishedAt),
  };
}

export function bookPartSnapshot(part: Partial<BookPart>): Snapshot {
  return {
    editionId: nullIfUndefined(part.editionId),
    title: nullIfUndefined(part.title),
    order: nullIfUndefined(part.order),
  };
}

/** `content` is reduced to `{ length }` — the TipTap JSON is never stored. */
export function bookChapterSnapshot(chapter: Partial<BookChapter>): Snapshot {
  return {
    editionId: nullIfUndefined(chapter.editionId),
    partId: nullIfUndefined(chapter.partId),
    title: nullIfUndefined(chapter.title),
    imageUrl: nullIfUndefined(chapter.imageUrl),
    order: nullIfUndefined(chapter.order),
    status: nullIfUndefined(chapter.status),
    content: contentLength(chapter.content),
    pdfKey: nullIfUndefined(chapter.pdfKey),
    pdfFileSize:
      chapter.pdfFileSize === null || chapter.pdfFileSize === undefined
        ? null
        : Number(chapter.pdfFileSize),
    pageCount: nullIfUndefined(chapter.pageCount),
    processedPages: nullIfUndefined(chapter.processedPages),
    processingError: nullIfUndefined(chapter.processingError),
  };
}

/** Same rule as chapters: `content` becomes `{ length }`. */
export function bookSectionSnapshot(section: Partial<BookSection>): Snapshot {
  return {
    chapterId: nullIfUndefined(section.chapterId),
    title: nullIfUndefined(section.title),
    order: nullIfUndefined(section.order),
    startPage: nullIfUndefined(section.startPage),
    content: contentLength(section.content),
  };
}

export function bookAuthorSnapshot(author: Partial<BookAuthor>): Snapshot {
  return {
    name: nullIfUndefined(author.name),
    imageUrl: nullIfUndefined(author.imageUrl),
    bio: nullIfUndefined(author.bio),
  };
}

export function categorySnapshot(category: Partial<Category>): Snapshot {
  return {
    name: nullIfUndefined(category.name),
    description: nullIfUndefined(category.description),
  };
}

export function bookCategorySnapshot(
  category: Partial<BookCategory>,
): Snapshot {
  return {
    name: nullIfUndefined(category.name),
    description: nullIfUndefined(category.description),
  };
}

export function actorSnapshot(actor: Partial<Actor>): Snapshot {
  return {
    name: nullIfUndefined(actor.name),
    imageUrl: nullIfUndefined(actor.imageUrl),
  };
}

export function subtitleSnapshot(subtitle: Partial<Subtitle>): Snapshot {
  return {
    videoId: nullIfUndefined(subtitle.videoId),
    language: nullIfUndefined(subtitle.language),
    label: nullIfUndefined(subtitle.label),
    format: nullIfUndefined(subtitle.format),
    isDefault: nullIfUndefined(subtitle.isDefault),
    objectKey: nullIfUndefined(subtitle.objectKey),
  };
}

// ---------------------------------------------------------------------------
// Users / staff / roles / levels
// ---------------------------------------------------------------------------

export type UserSnapshotInput = Partial<User> & {
  appRole?: { name: string } | null;
  /** Resolved level, when the caller has it — never stored on the row itself. */
  level?: { id: string; name: string } | null;
};

/**
 * NEVER includes password, googleId or any token — those keys are not read
 * here at all, and sanitizeSnapshot would redact them anyway.
 */
export function userSnapshot(user: UserSnapshotInput): Snapshot {
  const snapshot: Snapshot = {
    username: nullIfUndefined(user.username),
    displayName: nullIfUndefined(user.displayName),
    phone: nullIfUndefined(user.phone),
    email: nullIfUndefined(user.email),
    role: nullIfUndefined(user.role),
    appRoleId: nullIfUndefined(user.appRoleId),
    appRoleName: user.appRole?.name ?? null,
    status: nullIfUndefined(user.status),
  };
  if (user.level !== undefined) {
    snapshot.level = user.level ? { ...user.level } : null;
  }
  return snapshot;
}

export type RoleSnapshotInput = Partial<AppRole> & {
  permissions?: readonly (string | { permission: string })[] | null;
};

/** `permissions` is sorted so two rows holding the same set compare equal. */
export function roleSnapshot(role: RoleSnapshotInput): Snapshot {
  const permissions = (role.permissions ?? []).map((entry) =>
    typeof entry === 'string' ? entry : entry.permission,
  );
  return {
    key: nullIfUndefined(role.key),
    name: nullIfUndefined(role.name),
    description: nullIfUndefined(role.description),
    permissions: [...permissions].sort(),
  };
}

export function levelSnapshot(level: Partial<UserLevel>): Snapshot {
  return {
    name: nullIfUndefined(level.name),
    threshold: money(level.threshold),
    icon: nullIfUndefined(level.icon),
    color: nullIfUndefined(level.color),
    order: nullIfUndefined(level.order),
    enabled: nullIfUndefined(level.enabled),
  };
}

// ---------------------------------------------------------------------------
// Finance
// ---------------------------------------------------------------------------

export function depositSnapshot(deposit: Partial<Deposit>): Snapshot {
  return {
    userId: nullIfUndefined(deposit.userId),
    amount: money(deposit.amount),
    paymentMethod: nullIfUndefined(deposit.paymentMethod),
    accountName: nullIfUndefined(deposit.accountName),
    reference: nullIfUndefined(deposit.reference),
    declaredPaymentAccountId: nullIfUndefined(deposit.declaredPaymentAccountId),
    status: nullIfUndefined(deposit.status),
    rejectionReason: nullIfUndefined(deposit.rejectionReason),
    approvedByUserId: nullIfUndefined(deposit.approvedByUserId),
    approvedAt: nullIfUndefined(deposit.approvedAt),
    receivingAccountType: nullIfUndefined(deposit.receivingAccountType),
    receivingAccountSubname: nullIfUndefined(deposit.receivingAccountSubname),
    receivingAccountName: nullIfUndefined(deposit.receivingAccountName),
    receivingAccountNumber: nullIfUndefined(deposit.receivingAccountNumber),
    receivingTransactionCode: nullIfUndefined(deposit.receivingTransactionCode),
    receivingTransactionTime: nullIfUndefined(deposit.receivingTransactionTime),
    receivingPaymentAccountId: nullIfUndefined(
      deposit.receivingPaymentAccountId,
    ),
    walletBalanceBefore: money(deposit.walletBalanceBefore),
    walletBalanceAfter: money(deposit.walletBalanceAfter),
    // The bank side (bank-events matcher). The screenshot KEY is deliberately
    // absent: the log records that evidence exists, never where it lives.
    receivingAmount: money(deposit.receivingAmount),
    receivingTransactionAt: nullIfUndefined(deposit.receivingTransactionAt),
    receivingEventKey: nullIfUndefined(deposit.receivingEventKey),
    hasBankScreenshot:
      deposit.receivingScreenshotKey === undefined
        ? null
        : deposit.receivingScreenshotKey !== null,
    bankCheckedAt: nullIfUndefined(deposit.bankCheckedAt),
    matchStatus: nullIfUndefined(deposit.matchStatus),
    riskLevel: nullIfUndefined(deposit.riskLevel),
    riskReasons: nullIfUndefined(deposit.riskReasons),
    declaredTransferAt: nullIfUndefined(deposit.declaredTransferAt),
  };
}

export function withdrawalSnapshot(withdrawal: Partial<Withdrawal>): Snapshot {
  return {
    userId: nullIfUndefined(withdrawal.userId),
    amount: money(withdrawal.amount),
    accountType: nullIfUndefined(withdrawal.accountType),
    accountName: nullIfUndefined(withdrawal.accountName),
    accountNumber: nullIfUndefined(withdrawal.accountNumber),
    bankName: nullIfUndefined(withdrawal.bankName),
    status: nullIfUndefined(withdrawal.status),
    rejectionReason: nullIfUndefined(withdrawal.rejectionReason),
    approvedByUserId: nullIfUndefined(withdrawal.approvedByUserId),
    approvedAt: nullIfUndefined(withdrawal.approvedAt),
    transferAccountType: nullIfUndefined(withdrawal.transferAccountType),
    transferAccountSubname: nullIfUndefined(withdrawal.transferAccountSubname),
    transferAccountName: nullIfUndefined(withdrawal.transferAccountName),
    transferAccountNumber: nullIfUndefined(withdrawal.transferAccountNumber),
    transferTransactionCode: nullIfUndefined(
      withdrawal.transferTransactionCode,
    ),
    transferTransactionTime: nullIfUndefined(
      withdrawal.transferTransactionTime,
    ),
    transferPaymentAccountId: nullIfUndefined(
      withdrawal.transferPaymentAccountId,
    ),
    // The bank side — same shape as depositSnapshot, transfer* voice.
    transferAmount: money(withdrawal.transferAmount),
    transferTransactionAt: nullIfUndefined(withdrawal.transferTransactionAt),
    transferEventKey: nullIfUndefined(withdrawal.transferEventKey),
    hasBankScreenshot:
      withdrawal.transferScreenshotKey === undefined
        ? null
        : withdrawal.transferScreenshotKey !== null,
    bankCheckedAt: nullIfUndefined(withdrawal.bankCheckedAt),
    matchStatus: nullIfUndefined(withdrawal.matchStatus),
    riskLevel: nullIfUndefined(withdrawal.riskLevel),
    riskReasons: nullIfUndefined(withdrawal.riskReasons),
    // C-4 — the ledger row of the money held at request time; null on a
    // row from before holds (approve debits those instead).
    holdTransactionId: nullIfUndefined(withdrawal.holdTransactionId),
  };
}

/**
 * A stored phone notification. The screenshot KEY is deliberately absent
 * (evidence exists / does not — never where it lives), like the deposit
 * and withdrawal pickers; the notification text was never stored at all.
 */
export function bankTransactionSnapshot(
  row: Partial<BankTransaction>,
): Snapshot {
  return {
    idempotencyKey: nullIfUndefined(row.idempotencyKey),
    deviceSerial: nullIfUndefined(row.deviceSerial),
    paymentAccountId: nullIfUndefined(row.paymentAccountId),
    direction: nullIfUndefined(row.direction),
    amount: money(row.amount),
    currency: nullIfUndefined(row.currency),
    txCode: nullIfUndefined(row.txCode),
    txCodeLast6: nullIfUndefined(row.txCodeLast6),
    occurredAt: nullIfUndefined(row.occurredAt),
    postedAt: nullIfUndefined(row.postedAt),
    counterparty: nullIfUndefined(row.counterparty),
    detailStatus: nullIfUndefined(row.detailStatus),
    state: nullIfUndefined(row.state),
    linkedDepositId: nullIfUndefined(row.linkedDepositId),
    linkedWithdrawalId: nullIfUndefined(row.linkedWithdrawalId),
    matchedAt: nullIfUndefined(row.matchedAt),
    hasScreenshot:
      row.screenshotKey === undefined ? null : row.screenshotKey !== null,
  };
}

export function paymentAccountSnapshot(
  account: Partial<PaymentAccount>,
): Snapshot {
  return {
    type: nullIfUndefined(account.type),
    subname: nullIfUndefined(account.subname),
    accountName: nullIfUndefined(account.accountName),
    accountNumber: nullIfUndefined(account.accountNumber),
    bankName: nullIfUndefined(account.bankName),
    note: nullIfUndefined(account.note),
    isActive: nullIfUndefined(account.isActive),
    balance: money(account.balance),
    totalIn: money(account.totalIn),
    totalOut: money(account.totalOut),
  };
}

export function paymentMethodTypeSnapshot(
  type: Partial<PaymentMethodType>,
): Snapshot {
  return {
    label: nullIfUndefined(type.label),
    requiresBankName: nullIfUndefined(type.requiresBankName),
    logoUrl: nullIfUndefined(type.logoUrl),
  };
}

export function financeSettingsSnapshot(
  settings: Partial<FinanceSettings>,
): Snapshot {
  return {
    minDepositAmount: money(settings.minDepositAmount),
    maxDepositAmount: money(settings.maxDepositAmount),
    minWithdrawalAmount: money(settings.minWithdrawalAmount),
    maxWithdrawalAmount: money(settings.maxWithdrawalAmount),
  };
}

export function subscriptionPlanSnapshot(
  plan: Partial<SubscriptionPlan>,
): Snapshot {
  return {
    name: nullIfUndefined(plan.name),
    price: money(plan.price),
    durationDays: nullIfUndefined(plan.durationDays),
    isActive: nullIfUndefined(plan.isActive),
  };
}

// ---------------------------------------------------------------------------
// Home page
// ---------------------------------------------------------------------------

/** Every editable field of a home promo — all short texts, no secrets. */
export function homePromoSnapshot(promo: Partial<HomePromo>): Snapshot {
  return {
    kind: nullIfUndefined(promo.kind),
    titleEn: nullIfUndefined(promo.titleEn),
    titleMm: nullIfUndefined(promo.titleMm),
    kickerEn: nullIfUndefined(promo.kickerEn),
    kickerMm: nullIfUndefined(promo.kickerMm),
    bodyEn: nullIfUndefined(promo.bodyEn),
    bodyMm: nullIfUndefined(promo.bodyMm),
    ctaLabelEn: nullIfUndefined(promo.ctaLabelEn),
    ctaLabelMm: nullIfUndefined(promo.ctaLabelMm),
    ctaTarget: nullIfUndefined(promo.ctaTarget),
    targetId: nullIfUndefined(promo.targetId),
    url: nullIfUndefined(promo.url),
    artPreset: nullIfUndefined(promo.artPreset),
    imageUrl: nullIfUndefined(promo.imageUrl),
    dateText: nullIfUndefined(promo.dateText),
    startsAt: nullIfUndefined(promo.startsAt),
    endsAt: nullIfUndefined(promo.endsAt),
    isActive: nullIfUndefined(promo.isActive),
    sortOrder: nullIfUndefined(promo.sortOrder),
  };
}

/**
 * Every editable field of a pre-roll ad plus what the attach step set
 * (the key, size and duration — all short, nothing secret). `movieIds`
 * is the SELECTED list, sorted so two saves with the same titles compare
 * equal whatever order the admin clicked them in.
 */
export function advertisementSnapshot(
  ad: Partial<Advertisement> & { movieIds?: readonly string[] },
): Snapshot {
  return {
    title: nullIfUndefined(ad.title),
    description: nullIfUndefined(ad.description),
    videoKey: nullIfUndefined(ad.videoKey),
    videoBytes: nullIfUndefined(ad.videoBytes),
    durationSeconds: nullIfUndefined(ad.durationSeconds),
    isActive: nullIfUndefined(ad.isActive),
    startsAt: nullIfUndefined(ad.startsAt),
    endsAt: nullIfUndefined(ad.endsAt),
    dailyStartMinutes: nullIfUndefined(ad.dailyStartMinutes),
    dailyEndMinutes: nullIfUndefined(ad.dailyEndMinutes),
    tzOffsetMinutes: nullIfUndefined(ad.tzOffsetMinutes),
    targetType: nullIfUndefined(ad.targetType),
    movieIds: ad.movieIds === undefined ? null : [...ad.movieIds].sort(),
    priority: nullIfUndefined(ad.priority),
    isSkippable: nullIfUndefined(ad.isSkippable),
    skipAfterSeconds: nullIfUndefined(ad.skipAfterSeconds),
    frequencyLimitMinutes: nullIfUndefined(ad.frequencyLimitMinutes),
    maxImpressionsPerUserPerDay: nullIfUndefined(
      ad.maxImpressionsPerUserPerDay,
    ),
    format: nullIfUndefined(ad.format),
    playsBeforeMovie: nullIfUndefined(ad.playsBeforeMovie),
    playsAtBreaks: nullIfUndefined(ad.playsAtBreaks),
    imageKey: nullIfUndefined(ad.imageKey),
    imageBytes: nullIfUndefined(ad.imageBytes),
    linkUrl: nullIfUndefined(ad.linkUrl),
    cornerShowSeconds: nullIfUndefined(ad.cornerShowSeconds),
    cornerRepeatMinutes: nullIfUndefined(ad.cornerRepeatMinutes),
    cornerClosable: nullIfUndefined(ad.cornerClosable),
  };
}

/** The Advertisements page's playback rules. */
export function adSettingsSnapshot(settings: Partial<AdSettings>): Snapshot {
  return {
    adsEnabled: nullIfUndefined(settings.adsEnabled),
    midrollIntervalMinutes: nullIfUndefined(settings.midrollIntervalMinutes),
    duringMovieAudience: nullIfUndefined(settings.duringMovieAudience),
  };
}

/** A dream's editable fields plus its fixed address (book + number). */
export function lotteryDreamSnapshot(dream: Partial<LotteryDream>): Snapshot {
  return {
    book: nullIfUndefined(dream.book),
    number: nullIfUndefined(dream.number),
    nameEn: nullIfUndefined(dream.nameEn),
    nameMy: nullIfUndefined(dream.nameMy),
    pictureUrl: nullIfUndefined(dream.pictureUrl),
    isActive: nullIfUndefined(dream.isActive),
  };
}

/**
 * A draw's setup and its life stamps. The counters (nextTicketSeq) and
 * the creator are bookkeeping, not something staff edit, so they stay out.
 */
export function lotteryDrawSnapshot(draw: Partial<LotteryDraw>): Snapshot {
  return {
    drawNo: nullIfUndefined(draw.drawNo),
    thaiDrawDate: nullIfUndefined(draw.thaiDrawDate),
    drawAt: nullIfUndefined(draw.drawAt),
    salesCloseAt: nullIfUndefined(draw.salesCloseAt),
    status: nullIfUndefined(draw.status),
    ticketPrice: money(draw.ticketPrice),
    maxPerNumber: nullIfUndefined(draw.maxPerNumber),
    exchangeRate: money(draw.exchangeRate),
    pictureUrl: nullIfUndefined(draw.pictureUrl),
    frameUrl: nullIfUndefined(draw.frameUrl),
    openedAt: nullIfUndefined(draw.openedAt),
    closedAt: nullIfUndefined(draw.closedAt),
    publishedAt: nullIfUndefined(draw.publishedAt),
    winnersCount: nullIfUndefined(draw.winnersCount),
    prizesPaidKs: money(draw.prizesPaidKs),
  };
}

export function lotterySettingsSnapshot(
  settings: Partial<LotterySettings>,
): Snapshot {
  return {
    ticketPrice: money(settings.ticketPrice),
    maxPerNumber: nullIfUndefined(settings.maxPerNumber),
    exchangeRate: money(settings.exchangeRate),
    salesCloseMinutesBefore: nullIfUndefined(settings.salesCloseMinutesBefore),
    frameUrl: nullIfUndefined(settings.frameUrl),
    resultsUrl: nullIfUndefined(settings.resultsUrl),
    claimDeadlineDays: nullIfUndefined(settings.claimDeadlineDays),
  };
}

/**
 * One prize claim (lottery_claims): its status, figures, times and the
 * rejection — what the confirm / reject / reopen rows diff. Never the
 * customer's own fields (the target label names them).
 */
export function lotteryClaimSnapshot(claim: Partial<LotteryClaim>): Snapshot {
  return {
    status: nullIfUndefined(claim.status),
    ticketsCount: nullIfUndefined(claim.ticketsCount),
    baht: money(claim.baht),
    ks: money(claim.ks),
    rate: money(claim.rate),
    requestedAt: nullIfUndefined(claim.requestedAt),
    decidedAt: nullIfUndefined(claim.decidedAt),
    decidedByUserId: nullIfUndefined(claim.decidedByUserId),
    rejectReason: nullIfUndefined(claim.rejectReason),
    rejectNote: nullIfUndefined(claim.rejectNote),
    transactionId: nullIfUndefined(claim.transactionId),
    paidAtPublish: nullIfUndefined(claim.paidAtPublish),
  };
}

/** One group of a stored sheet as the audit log keeps it: the key, the Baht prize and the numbers. */
interface ResultGroupLike {
  key: string;
  baht: number;
  numbers: string[];
}

function resultGroups(value: unknown): ResultGroupLike[] | null {
  if (!Array.isArray(value)) return null;
  const groups: ResultGroupLike[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const group = item as Record<string, unknown>;
    if (typeof group.key !== 'string' || !Array.isArray(group.numbers))
      continue;
    groups.push({
      key: group.key,
      baht: typeof group.baht === 'number' ? group.baht : 0,
      numbers: group.numbers.filter(
        (number): number is string => typeof number === 'string',
      ),
    });
  }
  return groups;
}

/**
 * A draw's winning numbers: the status, where they came from and the
 * sheet itself (key, Baht, numbers per group — the numbers ARE the
 * point of this row). The source's raw answer stays out; it is in the
 * results row for anyone who needs it.
 */
export function lotteryResultSnapshot(
  result: Partial<LotteryResult>,
): Snapshot {
  return {
    status: nullIfUndefined(result.status),
    source: nullIfUndefined(result.source),
    sourceDate: nullIfUndefined(result.sourceDate),
    fetchedAt: nullIfUndefined(result.fetchedAt),
    attempts: nullIfUndefined(result.attempts),
    lastError: nullIfUndefined(result.lastError),
    groups: resultGroups(result.groups),
  };
}

export function homeSettingsSnapshot(
  settings: Partial<HomeSettings>,
): Snapshot {
  return {
    webUrl: nullIfUndefined(settings.webUrl),
    appStoreUrl: nullIfUndefined(settings.appStoreUrl),
    playStoreUrl: nullIfUndefined(settings.playStoreUrl),
    gamesTeaserEnabled: nullIfUndefined(settings.gamesTeaserEnabled),
    gamesTeaserDateText: nullIfUndefined(settings.gamesTeaserDateText),
  };
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

export function peakUsersSnapshot(stats: Partial<PeakUserStats>): Snapshot {
  return {
    actualPeak: nullIfUndefined(stats.actualPeak),
    actualPeakAt: nullIfUndefined(stats.actualPeakAt),
    additionalPeak: nullIfUndefined(stats.additionalPeak),
  };
}

/** `body` is a 200-character preview — enough to recognise, never the essay. */
export function commentSnapshot(comment: Partial<Comment>): Snapshot {
  return {
    status: nullIfUndefined(comment.status),
    body: textPreview(comment.body),
    userId: nullIfUndefined(comment.userId),
    movieId: nullIfUndefined(comment.movieId),
    seriesId: nullIfUndefined(comment.seriesId),
    bookId: nullIfUndefined(comment.bookId),
    parentId: nullIfUndefined(comment.parentId),
  };
}

export type FeedbackSnapshotInput = Partial<Feedback> & {
  handledBy?: { id: string; username: string } | null;
};

export function feedbackSnapshot(feedback: FeedbackSnapshotInput): Snapshot {
  return {
    status: nullIfUndefined(feedback.status),
    category: nullIfUndefined(feedback.category),
    adminNote: nullIfUndefined(feedback.adminNote),
    handledBy:
      feedback.handledBy === undefined
        ? nullIfUndefined(feedback.handledByUserId)
        : feedback.handledBy
          ? { id: feedback.handledBy.id, name: feedback.handledBy.username }
          : null,
    handledAt: nullIfUndefined(feedback.handledAt),
  };
}
