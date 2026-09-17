import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import type { User, UserStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PASSWORD_SALT_ROUNDS } from '../auth/password.constants';
import { MinioService } from '../common/storage/minio.service';
import { StorageService } from '../common/storage/storage.service';
import { AuthorityService } from '../roles/authority.service';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { decimalToNumber } from '../common/utils/decimal.util';
import type { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { Role, TransactionType } from '../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import { userSnapshot } from '../audit/audit-snapshots';

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
 * File extension is derived from the VALIDATED MIME type — never from the
 * client-supplied filename, which is attacker-controlled. The leading dot is
 * part of the value because that is the form every StorageService key
 * builder takes (extname()'s form), so nothing has to re-add it.
 */
const AVATAR_MIME_TO_EXTENSION: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

/**
 * The multipart Content-Type header is attacker-controlled, so the declared
 * MIME must also match the file's magic bytes before the bytes land on the
 * publicly served cache path.
 */
function matchesMagicBytes(mimetype: string, buffer: Buffer): boolean {
  switch (mimetype) {
    case 'image/jpeg':
      return (
        buffer.length >= 3 &&
        buffer[0] === 0xff &&
        buffer[1] === 0xd8 &&
        buffer[2] === 0xff
      );
    case 'image/png':
      return (
        buffer.length >= 8 &&
        buffer
          .subarray(0, 8)
          .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      );
    case 'image/webp':
      return (
        buffer.length >= 12 &&
        buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
        buffer.subarray(8, 12).toString('latin1') === 'WEBP'
      );
    default:
      return false;
  }
}

export interface WalletSummary {
  balance: number;
  totalDeposited: number;
  totalSpent: number;
  isSubscribed: boolean;
  subscriptionExpiresAt: Date | null;
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

    const [wallets, spent, deposited, activeSubscriptions] = await Promise.all([
      this.prisma.wallet.findMany({ where: { userId: { in: userIds } } }),
      this.prisma.transaction.groupBy({
        by: ['userId'],
        where: {
          userId: { in: userIds },
          type: {
            in: [TransactionType.PURCHASE, TransactionType.SUBSCRIPTION],
          },
          status: 'COMPLETED',
        },
        _sum: { amount: true },
      }),
      this.prisma.transaction.groupBy({
        by: ['userId'],
        where: {
          userId: { in: userIds },
          type: TransactionType.DEPOSIT,
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
    const spentById = new Map(
      spent.map((s) => [s.userId, decimalToNumber(s._sum.amount)]),
    );
    const depositedById = new Map(
      deposited.map((d) => [d.userId, decimalToNumber(d._sum.amount)]),
    );
    // findMany is ordered by expiresAt desc, so the first row seen per user
    // is their latest-expiring active subscription.
    const subscriptionExpiresAtById = new Map<string, Date>();
    for (const sub of activeSubscriptions) {
      if (!subscriptionExpiresAtById.has(sub.userId)) {
        subscriptionExpiresAtById.set(sub.userId, sub.expiresAt);
      }
    }

    return new Map(
      userIds.map((id) => [
        id,
        {
          balance: balanceById.get(id) ?? 0,
          totalDeposited: depositedById.get(id) ?? 0,
          totalSpent: spentById.get(id) ?? 0,
          isSubscribed: subscriptionExpiresAtById.has(id),
          subscriptionExpiresAt: subscriptionExpiresAtById.get(id) ?? null,
        },
      ]),
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
   * Existing refresh tokens are deliberately NOT revoked — signing other
   * devices out on a password change is a separate product decision and is
   * out of scope here.
   */
  async changePassword(
    id: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.findByIdOrThrow(id);
    const matches = await bcrypt.compare(currentPassword, user.password);
    if (!matches) {
      throw new BadRequestException('Your current password is incorrect');
    }

    const passwordHash = await bcrypt.hash(newPassword, PASSWORD_SALT_ROUNDS);
    await this.prisma.user.update({
      where: { id },
      data: { password: passwordHash },
    });
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
    const [wallet, spentAgg, depositedAgg, activeSubscription] =
      await Promise.all([
        this.prisma.wallet.findUnique({ where: { userId } }),
        this.prisma.transaction.aggregate({
          where: {
            userId,
            type: {
              in: [TransactionType.PURCHASE, TransactionType.SUBSCRIPTION],
            },
            status: 'COMPLETED',
          },
          _sum: { amount: true },
        }),
        this.prisma.transaction.aggregate({
          where: { userId, type: TransactionType.DEPOSIT, status: 'COMPLETED' },
          _sum: { amount: true },
        }),
        this.prisma.userSubscription.findFirst({
          where: { userId, expiresAt: { gt: new Date() } },
          orderBy: { expiresAt: 'desc' },
        }),
      ]);

    return {
      balance: decimalToNumber(wallet?.balance),
      totalDeposited: decimalToNumber(depositedAgg._sum.amount),
      totalSpent: decimalToNumber(spentAgg._sum.amount),
      isSubscribed: Boolean(activeSubscription),
      subscriptionExpiresAt: activeSubscription?.expiresAt ?? null,
    };
  }
}
