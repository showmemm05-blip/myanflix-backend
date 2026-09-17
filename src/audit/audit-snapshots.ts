import type {
  Actor,
  AppRole,
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
};

export function seriesSnapshot(series: SeriesSnapshotInput): Snapshot {
  return {
    title: nullIfUndefined(series.title),
    description: nullIfUndefined(series.description),
    genre: nullIfUndefined(series.genre),
    language: nullIfUndefined(series.language),
    releaseYear: nullIfUndefined(series.releaseYear),
    accessType: nullIfUndefined(series.accessType),
    status: nullIfUndefined(series.status),
    posterUrl: nullIfUndefined(series.posterUrl),
    coverUrl: nullIfUndefined(series.coverUrl),
    categories: refs(series.categories),
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
