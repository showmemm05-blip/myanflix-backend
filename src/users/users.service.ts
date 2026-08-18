import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { User, UserStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/storage/minio.service';
import { decimalToNumber } from '../common/utils/decimal.util';
import type { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { Role, TransactionType } from '../generated/prisma/client';

export interface CreateUserInput {
  username: string;
  password: string;
  phone?: string;
  role?: Role;
}

/**
 * File extension is derived from the VALIDATED MIME type — never from the
 * client-supplied filename, which is attacker-controlled.
 */
const AVATAR_MIME_TO_EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** Cleanup only ever deletes objects under this prefix — never arbitrary keys a row might somehow hold. */
const AVATAR_KEY_PREFIX = 'images/avatars/';

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

  async findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  async findByIdOrThrow(id: string): Promise<User> {
    const user = await this.findById(id);
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async findAll(
    pagination: PaginationQueryDto & { search?: string },
  ): Promise<{
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

  async updateRole(id: string, role: Role): Promise<User> {
    await this.findByIdOrThrow(id);
    return this.prisma.user.update({ where: { id }, data: { role } });
  }

  async updateStatus(id: string, status: UserStatus): Promise<User> {
    await this.findByIdOrThrow(id);
    return this.prisma.user.update({ where: { id }, data: { status } });
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
    const key = `${AVATAR_KEY_PREFIX}${userId}-${Date.now()}.${extension}`;
    await this.minioService.uploadBuffer(key, file.buffer);
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { avatar: key },
    });
    await this.deleteAvatarObject(previousKey);
    return user;
  }

  /** Clears `user.avatar` and best-effort deletes the old object. */
  async removeAvatar(userId: string): Promise<User> {
    const previousKey = (await this.findByIdOrThrow(userId)).avatar;
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { avatar: null },
    });
    await this.deleteAvatarObject(previousKey);
    return user;
  }

  /**
   * Best-effort delete of a replaced/removed avatar object. Guarded to the
   * avatar prefix so this can never delete an arbitrary key, and never
   * throws — the DB row is already updated, and a leaked object is
   * preferable to failing the user's request.
   */
  private async deleteAvatarObject(key: string | null): Promise<void> {
    if (!key || !key.startsWith(AVATAR_KEY_PREFIX)) return;
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
