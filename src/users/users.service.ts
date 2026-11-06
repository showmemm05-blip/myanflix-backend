import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';
import type { Prisma, User } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PASSWORD_SALT_ROUNDS } from '../auth/password.constants';
import { SessionRevocationService } from '../auth/session-revocation.service';
import { MinioService } from '../common/storage/minio.service';
import { StorageService } from '../common/storage/storage.service';
import { AuthorityService } from '../roles/authority.service';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { decimalToNumber } from '../common/utils/decimal.util';
import {
  IMAGE_MIME_TO_EXTENSION,
  matchesMagicBytes,
} from '../common/utils/image-magic-bytes';
import type { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import {
  DepositStatus,
  Role,
  TransactionType,
  UserStatus,
  WithdrawalStatus,
} from '../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import { userSnapshot } from '../audit/audit-snapshots';
import { CLOSED_ACCOUNT_MESSAGE } from './account-status-lock';
import { redactSmsForClosedAccount } from '../sms-gateway/sms-redaction';

export interface CreateUserInput {
  username: string;
  password: string;
  phone?: string;
  role?: Role;
  /** Granular RBAC assignment; omitted means "fall back to the system role matching `role`". */
  appRoleId?: string;
  /** Set only by "Continue with Google": the verified, lower-cased Google e-mail. */
  email?: string;
  /** Set only by "Continue with Google": the ID token's stable `sub` claim. */
  googleId?: string;
  /** Initial cosmetic name (Google sign-in seeds it from the token's `name`). */
  displayName?: string;
}

/**
 * The profile-picture subset of the image types the server stores: JPEG,
 * PNG and WebP — no GIF, an avatar is a still. The extension is derived
 * from the VALIDATED MIME type — never from the client-supplied filename,
 * which is attacker-controlled (the map and the byte check that backs it
 * live in common/utils/image-magic-bytes.ts, shared with the staff image
 * route).
 */
const AVATAR_MIME_TO_EXTENSION: Record<string, string> = {
  'image/jpeg': IMAGE_MIME_TO_EXTENSION['image/jpeg'],
  'image/png': IMAGE_MIME_TO_EXTENSION['image/png'],
  'image/webp': IMAGE_MIME_TO_EXTENSION['image/webp'],
};

/** H-16 refusals, in the order they are checked. */
export const ACCOUNT_DELETE_BALANCE_MESSAGE =
  'Your wallet still has money in it. Withdraw or spend it before deleting your account.';
export const ACCOUNT_DELETE_PENDING_DEPOSIT_MESSAGE =
  'You have a deposit waiting for review. Wait until it is approved or rejected before deleting your account.';
export const ACCOUNT_DELETE_PENDING_WITHDRAWAL_MESSAGE =
  'You have a withdrawal waiting for review. Wait until it is approved or rejected before deleting your account.';

/**
 * The username a closed account is left with: unique (it is the row id) and
 * unclaimable (40 characters, over the 32 that registration accepts), so
 * nobody can ever sign up as — or be mistaken for — a deleted account.
 */
export function closedAccountUsername(userId: string): string {
  return `deleted_${userId.replace(/-/g, '')}`;
}

export interface WalletSummary {
  balance: number;
  totalDeposited: number;
  totalSpent: number;
  isSubscribed: boolean;
  subscriptionExpiresAt: Date | null;
}

/**
 * The only columns an authentication check reads: JwtStrategy on every HTTP
 * request and the socket handshake. Deliberately narrow — the password and
 * withdrawal-code hashes, phone and e-mail never need to leave the database
 * for a request to be authenticated.
 */
const AUTH_SUBJECT_SELECT = {
  id: true,
  username: true,
  role: true,
  appRoleId: true,
  status: true,
  sessionsRevokedAt: true,
} as const satisfies Prisma.UserSelect;

export type AuthSubject = Pick<
  User,
  'id' | 'username' | 'role' | 'appRoleId' | 'status' | 'sessionsRevokedAt'
>;

/** Transaction types that count as money SPENT (the "Total spent" figure). */
const SPENT_TRANSACTION_TYPES: TransactionType[] = [
  TransactionType.PURCHASE,
  TransactionType.SUBSCRIPTION,
];

/** Every type either wallet total needs, read in ONE grouped query. */
const WALLET_TOTAL_TRANSACTION_TYPES: TransactionType[] = [
  ...SPENT_TRANSACTION_TYPES,
  TransactionType.DEPOSIT,
];

/**
 * Folds per-type COMPLETED sums into the two wallet totals. The per-type
 * sums are added as Decimals and only then turned into a number, so the
 * result is exactly what one SUM over both spent types used to return
 * (adding two JavaScript numbers could differ in the last digit).
 */
export function walletTotalsFromTypeSums(
  rows: { type: TransactionType; _sum: { amount: Prisma.Decimal | null } }[],
): { totalSpent: number; totalDeposited: number } {
  let spent: Prisma.Decimal | null = null;
  let deposited: Prisma.Decimal | null = null;
  for (const row of rows) {
    const amount = row._sum.amount;
    if (amount === null) continue;
    if (SPENT_TRANSACTION_TYPES.includes(row.type)) {
      spent = spent === null ? amount : spent.plus(amount);
    } else if (row.type === TransactionType.DEPOSIT) {
      deposited = deposited === null ? amount : deposited.plus(amount);
    }
  }
  return {
    totalSpent: decimalToNumber(spent),
    totalDeposited: decimalToNumber(deposited),
  };
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly minioService: MinioService,
    private readonly storageService: StorageService,
    private readonly authority: AuthorityService,
    private readonly audit: AuditService,
    private readonly sessions: SessionRevocationService,
  ) {}

  async create(input: CreateUserInput): Promise<User> {
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({ data: input });
      await tx.wallet.create({ data: { userId: user.id, balance: 0 } });
      return user;
    });
  }

  async findByUsername(username: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { username } });
  }

  /** Expects an already-normalized phone (see normalizePhone). */
  async findByPhone(phone: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { phone } });
  }

  /** Expects an already lower-cased email (GoogleAuthService normalizes it). */
  async findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  async findByGoogleId(googleId: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { googleId } });
  }

  /**
   * Attaches a Google account to an existing row. Only GoogleAuthService
   * calls this, and only after it has verified the token AND checked the
   * row's e-mail matches — never from a user-facing endpoint.
   */
  async linkGoogleId(id: string, googleId: string): Promise<User> {
    return this.prisma.user.update({ where: { id }, data: { googleId } });
  }

  async findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  /**
   * The narrow row an authentication check needs (see AUTH_SUBJECT_SELECT).
   * Still one fresh read per call, never cached: that is what makes a
   * suspension or a session revocation take effect at once (H-21).
   */
  async findAuthSubject(id: string): Promise<AuthSubject | null> {
    return this.prisma.user.findUnique({
      where: { id },
      select: AUTH_SUBJECT_SELECT,
    });
  }

  async findByIdOrThrow(id: string): Promise<User> {
    const user = await this.findById(id);
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async findAll(pagination: PaginationQueryDto & { search?: string }): Promise<{
    items: User[];
    total: number;
    walletByUserId: Map<string, WalletSummary>;
  }> {
    const page = pagination.page ?? 1;
    const limit = pagination.limit ?? 20;
    const search = pagination.search?.trim();

    // Staff accounts (SUPER_ADMIN/ADMIN/CONTENT_UPLOADER) are managed on the
    // dedicated Staff page — this list is subscriber accounts only.
    const where = {
      role: Role.USER,
      ...(search
        ? {
            OR: [
              { username: { contains: search, mode: 'insensitive' as const } },
              {
                displayName: { contains: search, mode: 'insensitive' as const },
              },
              { phone: { contains: search } },
            ],
          }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.user.count({ where }),
    ]);

    const walletByUserId = await this.getWalletSummaries(
      items.map((u) => u.id),
    );
    return { items, total, walletByUserId };
  }

  /** Batched version of getWalletSummary for list views — avoids N+1 queries per page. */
  async getWalletSummaries(
    userIds: string[],
  ): Promise<Map<string, WalletSummary>> {
    if (userIds.length === 0) return new Map();

    const [wallets, typeSums, activeSubscriptions] = await Promise.all([
      this.prisma.wallet.findMany({ where: { userId: { in: userIds } } }),
      // One grouped read for both totals (spent and deposited) instead of two.
      this.prisma.transaction.groupBy({
        by: ['userId', 'type'],
        where: {
          userId: { in: userIds },
          type: { in: WALLET_TOTAL_TRANSACTION_TYPES },
          status: 'COMPLETED',
        },
        _sum: { amount: true },
      }),
      this.prisma.userSubscription.findMany({
        where: { userId: { in: userIds }, expiresAt: { gt: new Date() } },
        orderBy: { expiresAt: 'desc' },
      }),
    ]);

    const balanceById = new Map(
      wallets.map((w) => [w.userId, decimalToNumber(w.balance)]),
    );
    const typeSumsById = new Map<string, typeof typeSums>();
    for (const row of typeSums) {
      const rows = typeSumsById.get(row.userId);
      if (rows) rows.push(row);
      else typeSumsById.set(row.userId, [row]);
    }
    // findMany is ordered by expiresAt desc, so the first row seen per user
    // is their latest-expiring active subscription.
    const subscriptionExpiresAtById = new Map<string, Date>();
    for (const sub of activeSubscriptions) {
      if (!subscriptionExpiresAtById.has(sub.userId)) {
        subscriptionExpiresAtById.set(sub.userId, sub.expiresAt);
      }
    }

    return new Map(
      userIds.map((id) => {
        const { totalSpent, totalDeposited } = walletTotalsFromTypeSums(
          typeSumsById.get(id) ?? [],
        );
        return [
          id,
          {
            balance: balanceById.get(id) ?? 0,
            totalDeposited,
            totalSpent,
            isSubscribed: subscriptionExpiresAtById.has(id),
            subscriptionExpiresAt: subscriptionExpiresAtById.get(id) ?? null,
          },
        ];
      }),
    );
  }

  /**
   * Changes the coarse account kind AND re-points the RBAC assignment at the
   * matching system role. Before AppRoles existed the enum alone decided
   * permissions, so a role change had to move them too — keeping both in step
   * preserves that exactly.
   *
   * This is the most powerful endpoint in the platform (it can mint a Super
   * Admin), and it used to be reachable with nothing but USERS.EDIT and no
   * checks at all — F2/F7. It now runs every guard the staff routes run:
   * no promoting yourself, P2 on the role being handed out AND on the account
   * being changed, plus both lockout guards.
   */
  async updateRole(
    id: string,
    role: Role,
    actor: AuthenticatedUser,
  ): Promise<User> {
    if (id === actor.id) {
      throw new ForbiddenException(
        'You cannot change your own role. Ask another Super Admin to do this.',
      );
    }

    const target = await this.findWithAppRoleOrThrow(id);
    if (target.status === UserStatus.CLOSED) {
      throw new ConflictException(CLOSED_ACCOUNT_MESSAGE);
    }
    const systemRole = await this.prisma.appRole.findUnique({
      where: { key: role },
      select: { id: true, name: true },
    });
    const assignment = { role, appRoleId: systemRole?.id ?? null };

    // (c) you may not demote a tier you do not belong to...
    if (await this.authority.isSuperAdminTier(target)) {
      await this.authority.assertActorIsSuperAdmin(actor);
    }
    // ...(b) nor promote anyone into it, nor grant a set you lack (P1), nor
    // (F-004) demote them off a set you lack.
    await this.authority.assertCanAssignRole(actor, assignment, {
      role: target.role,
      appRoleId: target.appRoleId,
    });

    // (d)/F7: the staff guards, on the endpoint that used to bypass them.
    if (
      (await this.authority.isEffectiveSuperAdmin(target)) &&
      !(await this.authority.isEffectiveSuperAdmin(assignment))
    ) {
      await this.authority.assertNotLastActiveSuperAdmin(id);
    }
    await this.authority.assertNotLastRoleManagerAccount(
      { id, role: target.role, appRoleId: target.appRoleId },
      assignment,
    );

    const updated = await this.prisma.user.update({
      where: { id },
      data: { role, ...(systemRole && { appRoleId: systemRole.id }) },
    });

    // H-21: a new role means new sessions — every token and socket of the
    // account goes, so nothing keeps acting under the old assignment.
    const nextAppRoleId = systemRole?.id ?? target.appRoleId;
    if (role !== target.role || nextAppRoleId !== target.appRoleId) {
      await this.sessions.revokeAllAndDisconnect(id);
    }

    // The assignment is re-pointed only when the system role exists; otherwise
    // the AppRole stays whatever it was — mirror that in the "after" name.
    await this.audit.record({
      action: 'user.role_change',
      actor,
      target: { type: 'user', id, label: `@${updated.username}` },
      before: userSnapshot(target),
      after: userSnapshot({
        ...updated,
        appRole: systemRole ? { name: systemRole.name } : target.appRole,
      }),
    });
    this.audit.invalidateActorCache(id);
    return updated;
  }

  /**
   * Activate / suspend / ban. Like `updateRole` (F2/F7) this route used to run
   * with nothing but USERS.SUSPEND and no checks at all — F-001: a small
   * custom role could suspend a Super Admin (even the last one) or itself.
   * It now runs the same status-change gate as PATCH /staff/:id/status, and a
   * staff-tier target additionally needs STAFF.EDIT, because USERS.SUSPEND is
   * a "customers" permission.
   */
  async updateStatus(
    id: string,
    status: UserStatus,
    actor: AuthenticatedUser,
  ): Promise<User> {
    const target = await this.findWithAppRoleOrThrow(id);
    if (target.status === UserStatus.CLOSED) {
      throw new ConflictException(CLOSED_ACCOUNT_MESSAGE);
    }
    await this.authority.assertCanChangeStatus(
      actor,
      { id, role: target.role, appRoleId: target.appRoleId },
      status,
    );
    if (target.role !== Role.USER) {
      await this.authority.assertHas(
        actor,
        'STAFF.EDIT',
        'Staff accounts are managed from the Staff page.',
      );
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data: { status },
    });

    // H-21: suspended or banned = signed out everywhere, now — and those
    // sessions must not spring back if the account is re-activated later.
    if (status !== UserStatus.ACTIVE) {
      await this.sessions.revokeAllAndDisconnect(id);
    }

    await this.audit.record({
      action: 'user.status_change',
      actor,
      target: { type: 'user', id, label: `@${updated.username}` },
      before: userSnapshot(target),
      after: userSnapshot({ ...updated, appRole: target.appRole }),
    });
    return updated;
  }

  /**
   * The audit "before" read for the staff-facing mutations: the row plus the
   * assigned AppRole's name, so the log can say "Admin → Movie Manager"
   * rather than two opaque ids.
   */
  private async findWithAppRoleOrThrow(
    id: string,
  ): Promise<User & { appRole: { name: string } | null }> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { appRole: { select: { name: true } } },
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  /**
   * Self-service profile edit. Deliberately narrow: only the cosmetic
   * `displayName` is writable here — `username` and `phone` are login
   * identities and must never be editable from the profile screen.
   *
   * `undefined` means "field not sent, leave it alone"; an explicit `null`
   * clears the name back to unset. The DTO has already trimmed and
   * length-checked any string.
   */
  async updateProfile(
    id: string,
    input: { displayName?: string | null },
  ): Promise<User> {
    await this.findByIdOrThrow(id);
    if (input.displayName === undefined) {
      // Nothing to write — re-read rather than issuing a no-op UPDATE that
      // would still bump updatedAt.
      return this.findByIdOrThrow(id);
    }
    return this.prisma.user.update({
      where: { id },
      data: { displayName: input.displayName },
    });
  }

  /**
   * Self-service password change: proves ownership with the current password
   * before writing the new hash, using the same bcrypt cost as registration.
   *
   * H-21: every OTHER session is signed out in the same transaction — the
   * caller's own refresh session (`actor.sessionId`) is kept, so their
   * client's next 401 refreshes into a fresh token instead of a sign-out.
   *
   * `actor` is the caller from @CurrentUser(). When given, a successful
   * change lands in the staff audit log as `staff.password_change`.
   * AuditService drops end users (role USER) by itself, so only a staff
   * member's self-change is ever written.
   */
  async changePassword(
    id: string,
    currentPassword: string,
    newPassword: string,
    actor?: AuthenticatedUser,
  ): Promise<void> {
    const user = await this.findByIdOrThrow(id);
    const matches = await bcrypt.compare(currentPassword, user.password);
    if (!matches) {
      // Thrown before any audit call: a failed attempt is not a change.
      throw new BadRequestException('Your current password is incorrect');
    }

    const passwordHash = await bcrypt.hash(newPassword, PASSWORD_SALT_ROUNDS);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id },
        data: { password: passwordHash },
      });
      await this.sessions.revokeAll(id, {
        exceptSessionId: actor?.sessionId,
        client: tx,
      });
    });
    this.sessions.disconnectUser(id);

    // Pure event, like staff.password_reset: the fact of the change is what
    // matters. Deliberately NO before/after/metadata — nothing password-
    // related (plain or hashed) may ever reach the audit table.
    if (actor) {
      await this.audit.record({
        action: 'staff.password_change',
        actor,
        target: { type: 'staff', id: user.id, label: `@${user.username}` },
      });
    }
  }

  /**
   * H-16: DELETE /users/me — the owner closes their own account.
   *
   * Refused (409) while the wallet holds money or a deposit/withdrawal is
   * still pending: that money has to be settled first. Otherwise, in ONE
   * transaction, the account is anonymised and CLOSED — never deleted, so
   * every money record (ledger, deposits, withdrawals, purchases) stays
   * intact and still adds up (H-22) — every session is revoked, the traces
   * that identify the person (codes sent to the phone and the SMS that
   * carried them, IP addresses, the name, IP address and user agent in the
   * audit trail) are scrubbed, and a
   * `user.account_delete` row is written with the owner as actor, already
   * under the anonymised name and scrubbed with the rest.
   *
   * The kept money rows are deliberately NOT scrubbed, so they still hold
   * what was entered on them: a withdrawal's payout account (accountType,
   * accountName, accountNumber, bankName), the sender name staff may type
   * on a manual deposit (deposits.accountName), transfer codes and bank
   * screenshots, and the matched bank notification's counterparty — also in
   * the deposit.* / withdrawal.* audit snapshots.
   *
   * A closed account can never sign in again: the phone, e-mail and Google
   * id are released (the same phone can sign up afresh as a NEW account),
   * the password is a hash of random bytes nobody knows, every sign-in path
   * and the socket handshake require ACTIVE, and no status route can move
   * an account out of CLOSED.
   *
   * Customer accounts only: a staff account is managed from the Staff page.
   */
  async deleteOwnAccount(actor: AuthenticatedUser): Promise<void> {
    const user = await this.findByIdOrThrow(actor.id);
    if (user.role !== Role.USER) {
      throw new ForbiddenException(
        'Staff accounts cannot be deleted here. Ask a Super Admin.',
      );
    }

    const username = closedAccountUsername(user.id);
    const unusablePassword = await bcrypt.hash(
      randomBytes(32).toString('hex'),
      PASSWORD_SALT_ROUNDS,
    );

    await this.prisma.$transaction(async (tx) => {
      // Lock the account row first. Every deposit/withdrawal insert takes it
      // FOR SHARE as its own first statement (lockAccountStatus), so one in
      // flight is waited for and then seen by the checks below — and one
      // that arrives after this lock waits, reads CLOSED and writes nothing.
      // Purchases key-share-lock it through their foreign key.
      await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${user.id} FOR UPDATE`;

      const wallet = await tx.wallet.findUnique({
        where: { userId: user.id },
        select: { balance: true },
      });
      if (decimalToNumber(wallet?.balance) > 0) {
        throw new ConflictException(ACCOUNT_DELETE_BALANCE_MESSAGE);
      }
      const pendingDeposit = await tx.deposit.findFirst({
        where: { userId: user.id, status: DepositStatus.PENDING },
        select: { id: true },
      });
      if (pendingDeposit) {
        throw new ConflictException(ACCOUNT_DELETE_PENDING_DEPOSIT_MESSAGE);
      }
      const pendingWithdrawal = await tx.withdrawal.findFirst({
        where: { userId: user.id, status: WithdrawalStatus.PENDING },
        select: { id: true },
      });
      if (pendingWithdrawal) {
        throw new ConflictException(ACCOUNT_DELETE_PENDING_WITHDRAWAL_MESSAGE);
      }

      await tx.user.update({
        where: { id: user.id },
        data: {
          username,
          password: unusablePassword,
          phone: null,
          email: null,
          googleId: null,
          displayName: null,
          avatar: null,
          lastIpAddress: null,
          // Nothing can be withdrawn from a closed account; drop its
          // withdrawal code (a hash) and lock state with the rest.
          withdrawalCodeHash: null,
          withdrawalCodeSetAt: null,
          withdrawalCodeFailedCount: 0,
          withdrawalCodeLockedUntil: null,
          status: UserStatus.CLOSED,
        },
      });
      await this.sessions.revokeAll(user.id, { client: tx });

      if (user.phone) {
        await tx.otpCode.deleteMany({ where: { phone: user.phone } });
        // The SMS that carried those codes: number and body redacted, any
        // still QUEUED cancelled so the gateway phone never sends it.
        await redactSmsForClosedAccount(tx, user.phone);
      }
      await tx.userSession.updateMany({
        where: { userId: user.id },
        data: { ipAddress: null, userAgent: null },
      });
      await tx.comment.updateMany({
        where: { userId: user.id },
        data: { ipAddress: null },
      });
      await tx.feedback.updateMany({
        where: { userId: user.id },
        data: { ipAddress: null },
      });
      await tx.searchQuery.updateMany({
        where: { userId: user.id },
        data: { ipAddress: null },
      });
      // Written BEFORE the audit trail is anonymised (B4), so the scrub
      // below also takes this row's IP address and user agent — those of
      // the deletion request itself — and any cached display name.
      await this.audit.record({
        action: 'user.account_delete',
        actor: { ...actor, username },
        target: { type: 'user', id: user.id, label: `@${username}` },
        force: true,
        tx,
      });
      await this.audit.anonymiseUser(
        { userId: user.id, previousUsername: user.username, username },
        tx,
      );
    });

    this.audit.invalidateActorCache(user.id);
    this.sessions.disconnectUser(user.id);
    // After the commit and best-effort, like the staff delete: the bytes are
    // a storage concern, the closed account is the user-facing action.
    await this.deleteAvatarObjects(user.id);
  }

  /**
   * Per-request playback URL for an avatar object key, or null when the user
   * has no avatar. The key alone is what's persisted — the URL is derived
   * from the host the current request came in on (see
   * MinioService.playbackUrl), so it survives the host machine hopping
   * networks.
   */
  avatarUrlFor(avatarKey: string | null): string | null {
    return avatarKey ? this.minioService.playbackUrl(avatarKey) : null;
  }

  /**
   * Uploads a new profile picture and points `user.avatar` at its MinIO
   * object key. The key is versioned with a timestamp so the cache server
   * can never serve a stale avatar, and the previous object is deleted
   * best-effort once the new key is persisted.
   */
  async uploadAvatar(userId: string, file: Express.Multer.File): Promise<User> {
    const extension = AVATAR_MIME_TO_EXTENSION[file.mimetype];
    if (!extension || !matchesMagicBytes(file.mimetype, file.buffer)) {
      throw new BadRequestException(
        'Only JPEG, PNG, or WebP images are allowed',
      );
    }

    const previousKey = (await this.findByIdOrThrow(userId)).avatar;
    const key = this.storageService.avatarKey(userId, Date.now(), extension);
    await this.minioService.uploadBuffer(key, file.buffer);
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { avatar: key },
    });
    await this.deleteAvatarObject(userId, previousKey);
    return user;
  }

  /** Clears `user.avatar` and best-effort deletes the old object. */
  async removeAvatar(userId: string): Promise<User> {
    const previousKey = (await this.findByIdOrThrow(userId)).avatar;
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { avatar: null },
    });
    await this.deleteAvatarObject(userId, previousKey);
    return user;
  }

  /**
   * Every profile picture this user has ever uploaded, in ONE prefix delete —
   * for account deletion, where clearing the row leaves the bytes behind.
   * Only possible because avatars are foldered per user: the flat shape this
   * replaced (`images/avatars/<userId>-<stamp>.<ext>`) left no way to reach
   * anything but the CURRENT key, so every failed replacement leaked forever.
   * Best-effort and never throws, for the same reason as the single-object
   * cleanup below: the row is the user-facing action, orphaned bytes are not.
   */
  async deleteAvatarObjects(userId: string): Promise<void> {
    const prefix = `${this.storageService.avatarPrefix(userId)}/`;
    try {
      await this.minioService.deleteByPrefix(prefix);
    } catch (error) {
      this.logger.warn(
        `Could not delete avatar objects under "${prefix}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Best-effort delete of a replaced/removed avatar object. Guarded to THIS
   * user's own folder — not merely to the images/ tree — so a malformed or
   * tampered `avatar` value can never reach another user's picture, and never
   * throws: the DB row is already updated, and a leaked object is preferable
   * to failing the user's request.
   */
  private async deleteAvatarObject(
    userId: string,
    key: string | null,
  ): Promise<void> {
    const prefix = `${this.storageService.avatarPrefix(userId)}/`;
    if (!key || !key.startsWith(prefix)) return;
    try {
      await this.minioService.deleteObject(key);
    } catch (error) {
      this.logger.warn(
        `Could not delete old avatar object "${key}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async updateLastLogin(id: string): Promise<void> {
    await this.prisma.user.update({
      where: { id },
      data: { lastLoginAt: new Date() },
    });
  }

  /** Balance/spend summary shown on both the admin User Profile page and a user's own dashboard. */
  async getWalletSummary(userId: string): Promise<WalletSummary> {
    const [wallet, typeSums, activeSubscription] = await Promise.all([
      this.prisma.wallet.findUnique({ where: { userId } }),
      // One grouped read for both totals (spent and deposited) instead of two.
      this.prisma.transaction.groupBy({
        by: ['type'],
        where: {
          userId,
          type: { in: WALLET_TOTAL_TRANSACTION_TYPES },
          status: 'COMPLETED',
        },
        _sum: { amount: true },
      }),
      this.prisma.userSubscription.findFirst({
        where: { userId, expiresAt: { gt: new Date() } },
        orderBy: { expiresAt: 'desc' },
      }),
    ]);
    const { totalSpent, totalDeposited } = walletTotalsFromTypeSums(typeSums);

    return {
      balance: decimalToNumber(wallet?.balance),
      totalDeposited,
      totalSpent,
      isSubscribed: Boolean(activeSubscription),
      subscriptionExpiresAt: activeSubscription?.expiresAt ?? null,
    };
  }
}
