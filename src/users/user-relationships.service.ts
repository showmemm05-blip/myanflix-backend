import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { decimalToNumber } from '../common/utils/decimal.util';
import {
  DepositStatus,
  UserStatus,
  WithdrawalStatus,
} from '../generated/prisma/client';

/**
 * Hard ceilings on the BFS closure. A phone shared by a payment shop can pull
 * in an unbounded chunk of the user base, so the walk stops at whichever
 * limit trips first and reports `stats.truncated` instead of trying to
 * serialize the whole graph.
 */
const MAX_NODES = 400;
const MAX_DEPTH = 12;
/**
 * The activity list is meant to be read in full ON the relationship page — the
 * admin should never have to leave for the deposits queue to see what these
 * accounts did. So it is not a "recent 10" any more; it is everything, up to a
 * ceiling that exists only so one enormous component cannot serialize a
 * hundred thousand rows into a single response. `stats.activityTruncated` says
 * when the ceiling was hit.
 */
const ACTIVITY_LIMIT = 500;

/**
 * Anything shorter than this after stripping punctuation is a note, an
 * account nickname or a typo — never a phone. Skipping those keeps junk
 * strings from fusing unrelated users into one component.
 */
const MIN_PHONE_DIGITS = 6;

export type RelationshipEdgeKind = 'PROFILE' | 'WITHDRAWAL';

export interface RelationshipUserNode {
  id: string;
  /**
   * The label the graph/tree UI renders: `displayName?.trim() || username`.
   * It exists because the UI wants one name field it can print without
   * deciding which column is the "name".
   */
  name: string;
  /** Cosmetic name the user set for themselves; null when unset. */
  displayName: string | null;
  /** The raw login identity — never replaced by `displayName`. */
  username: string;
  profilePhone: string | null;
  /** Account status, so the admin graph can show and act on suspensions inline. */
  status: UserStatus;
  depositCount: number;
  withdrawalCount: number;
  totalDepositedAmount: number;
  totalWithdrawnAmount: number;
  depth: number;
  createdAt: Date;
}

/**
 * One user's row under a phone node ("Users Using This Number").
 *
 * `withdrawalCount`/`totalAmount` are that user's usage OF this number.
 * `depositCount`/`totalDepositedAmount` are the user's OWN deposit totals —
 * identical on every phone node the user is attached to, because a deposit
 * has no phone of its own to attribute it to (see the class doc). They are
 * statistics about the person, shown next to their name, not usage of the
 * number.
 */
export interface RelationshipPhoneUserRef {
  userId: string;
  withdrawalCount: number;
  totalAmount: number;
  /** Every deposit row of this user, any status. */
  depositCount: number;
  /** APPROVED deposits only — pending/rejected money never moved. */
  totalDepositedAmount: number;
}

export interface RelationshipPhoneNode {
  /** First-seen raw spelling, e.g. "09 777 888 999" — for display only. */
  phone: string;
  normalized: string;
  userCount: number;
  withdrawalCount: number;
  /**
   * Deposits made BY the users on this number — NOT deposits linked to the
   * number. No such link exists: a deposit records only our receiving
   * account, never the depositor's phone. Each attached user contributes
   * their deposit count exactly once here; a user attached to several phones
   * contributes to each of those phones (the figure is per node, so the same
   * deposits legitimately appear under more than one number).
   */
  depositCount: number;
  firstUsedAt: Date | null;
  lastUsedAt: Date | null;
  depth: number;
  users: RelationshipPhoneUserRef[];
}

export interface RelationshipEdge {
  userId: string;
  /** Normalized phone key — matches RelationshipPhoneNode.normalized. */
  phone: string;
  kind: RelationshipEdgeKind;
  withdrawalCount: number;
  totalAmount: number;
}

export interface RelationshipActivity {
  id: string;
  type: 'DEPOSIT' | 'WITHDRAWAL';
  userId: string;
  userName: string;
  amount: number;
  status: DepositStatus | WithdrawalStatus;
  createdAt: Date;
  /**
   * The short internal label of the account the money moved through — "K1",
   * "W2" — because that is how the finance team refers to them. Falls back to
   * the payment method name ("KBZ Pay") for rows recorded before an account
   * was picked from the catalog, which is the only thing those rows know.
   */
  method: string | null;
  /** Deposit: the 6-digit payment reference. Withdrawals have none. */
  reference: string | null;
  /**
   * The number this row touches, and the reason it is worth showing here: for
   * a withdrawal it is the payout account — i.e. one of the phone nodes on the
   * canvas, so a row can be read against the graph. Deposits have no depositor
   * phone recorded at all, hence null.
   */
  phone: string | null;
}

export interface RelationshipStats {
  /** True when the activity list hit ACTIVITY_LIMIT and is not the whole story. */
  activityTruncated: boolean;
  totalUsers: number;
  totalPhones: number;
  totalDeposits: number;
  totalWithdrawals: number;
  maxDepth: number;
  truncated: boolean;
}

export interface RelationshipNetwork {
  seedPhone: { raw: string; normalized: string };
  users: RelationshipUserNode[];
  phones: RelationshipPhoneNode[];
  edges: RelationshipEdge[];
  stats: RelationshipStats;
  recentActivity: RelationshipActivity[];
}

/**
 * Relationship key for a phone-ish string: digits only, so "09 777 888 999",
 * "09-777-888-999" and "09777888999" collapse to one node.
 *
 * The one transformation beyond stripping punctuation is folding the Myanmar
 * country code back to the local form. It has to be there: `User.phone` is
 * persisted in the "+959XXXXXXXX" shape (see normalizePhone in
 * common/utils/phone.util.ts) while `Withdrawal.accountNumber` is whatever
 * the user typed into the payout form, almost always "09XXXXXXXX". On digits
 * alone those two are different keys and a profile would never link to that
 * same person's withdrawals. The length guard keeps a long bank account
 * number that happens to begin with 959 out of the rewrite.
 *
 * Returns null for anything that isn't plausibly a phone — callers skip it.
 */
export function normalizeRelationshipPhone(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  let digits = raw.replace(/\D/g, '');
  // International dialing prefix; "00959..." and "+959..." are the same number.
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length < MIN_PHONE_DIGITS) return null;
  if (digits.startsWith('959') && digits.length >= 10 && digits.length <= 13) {
    return `0${digits.slice(2)}`;
  }
  return digits;
}

/**
 * Every stored spelling a normalized key could plausibly appear as, for the
 * `IN` lookups. Withdrawal.accountNumber has no index and is free text, so an
 * equality list is the only sane way to find *undiscovered* users by phone;
 * spaced/dashed spellings are still caught for users we already reached,
 * because their withdrawals are fetched wholesale by userId and normalized in
 * memory.
 */
function phoneLookupVariants(
  normalized: string,
  rawForms: Iterable<string>,
): string[] {
  const variants = new Set<string>(rawForms);
  variants.add(normalized);
  if (normalized.startsWith('0')) {
    const national = normalized.slice(1);
    variants.add(national);
    variants.add(`95${national}`);
    variants.add(`+95${national}`);
    variants.add(`0095${national}`);
  }
  return [...variants];
}

interface PhoneAccumulator {
  normalized: string;
  display: string;
  depth: number;
  rawForms: Set<string>;
  withdrawalCount: number;
  firstUsedAt: Date | null;
  lastUsedAt: Date | null;
  perUser: Map<string, { withdrawalCount: number; totalAmount: number }>;
  linkedUserIds: Set<string>;
}

/**
 * The one label rule for this graph: the name the user set for themselves,
 * falling back to the login identity when they never set one. Returns '' for
 * a user that isn't in the wave (activity rows tolerate a missing name).
 */
function labelFor(
  user: { displayName: string | null; username: string } | undefined,
): string {
  return user ? user.displayName?.trim() || user.username : '';
}

interface UserAccumulator {
  id: string;
  username: string;
  displayName: string | null;
  phone: string | null;
  status: UserStatus;
  createdAt: Date;
  depth: number;
  withdrawalCount: number;
  totalWithdrawnAmount: number;
}

interface WithdrawalRow {
  id: string;
  userId: string;
  accountNumber: string;
  accountType: string;
  transferAccountSubname: string | null;
  amount: unknown;
  status: WithdrawalStatus;
  createdAt: Date;
}

function emptyNetwork(raw: string, normalized: string): RelationshipNetwork {
  return {
    seedPhone: { raw, normalized },
    users: [],
    phones: [],
    edges: [],
    stats: {
      totalUsers: 0,
      totalPhones: 0,
      totalDeposits: 0,
      totalWithdrawals: 0,
      maxDepth: 0,
      truncated: false,
      activityTruncated: false,
    },
    recentActivity: [],
  };
}

/**
 * Read-only closure over the bipartite user <-> phone graph.
 *
 * The link key is deliberately `Withdrawal.accountNumber` (the user's OWN
 * payout account, a phone for KPay/Wave) plus `User.phone`. Deposits carry no
 * depositor phone at all, and the `receivingAccountNumber` /
 * `transferAccountNumber` columns are OUR accounts — shared by everybody, so
 * linking through them would collapse the entire user base into one blob.
 * Deposit figures still appear, but only as per-node statistics: a phone
 * node's `depositCount` is the deposits made by the users attached to it,
 * never deposits linked to the number itself. `stats.totalDeposits` stays
 * user-derived so a person on several phones is still counted once network
 * -wide.
 *
 * Counts (`depositCount`, `withdrawalCount`) cover every row regardless of
 * status — they answer "how many records touch this node". Amounts
 * (`totalDepositedAmount`, `totalWithdrawnAmount`, phone/edge `totalAmount`)
 * sum APPROVED rows only, since pending and rejected money never moved.
 */
@Injectable()
export class UserRelationshipsService {
  constructor(private readonly prisma: PrismaService) {}

  async getNetwork(rawPhone: string): Promise<RelationshipNetwork> {
    const seedRaw = rawPhone.trim();
    const seedNormalized = normalizeRelationshipPhone(seedRaw);
    if (!seedNormalized) return emptyNetwork(seedRaw, '');

    const phones = new Map<string, PhoneAccumulator>();
    const users = new Map<string, UserAccumulator>();
    const edges = new Map<string, RelationshipEdge>();
    const withdrawalsByUser: WithdrawalRow[] = [];
    let truncated = false;

    /** Returns true only when a brand-new node was created (BFS frontier gate). */
    const registerPhone = (
      normalized: string,
      raw: string,
      depth: number,
    ): boolean => {
      const existing = phones.get(normalized);
      if (existing) {
        existing.rawForms.add(raw);
        return false;
      }
      if (users.size + phones.size >= MAX_NODES) {
        truncated = true;
        return false;
      }
      phones.set(normalized, {
        normalized,
        display: raw,
        depth,
        rawForms: new Set([raw]),
        withdrawalCount: 0,
        firstUsedAt: null,
        lastUsedAt: null,
        perUser: new Map(),
        linkedUserIds: new Set(),
      });
      return true;
    };

    registerPhone(seedNormalized, seedRaw, 0);

    let frontier = [seedNormalized];
    let phoneDepth = 0;

    // Bipartite BFS: phones at even depths, users at odd ones. `phones` and
    // `users` double as the visited sets, so a cycle (two users sharing two
    // phones) terminates and nothing is ever visited twice.
    while (frontier.length > 0) {
      if (phoneDepth >= MAX_DEPTH) {
        truncated = true;
        break;
      }

      const frontierSet = new Set(frontier);
      const variants = [
        ...new Set(
          frontier.flatMap((key) =>
            phoneLookupVariants(key, phones.get(key)?.rawForms ?? []),
          ),
        ),
      ];

      // One pair of queries per wave — never a query per node.
      const [profileMatches, accountMatches] = await Promise.all([
        this.prisma.user.findMany({
          where: { phone: { in: variants } },
          select: { id: true, phone: true },
        }),
        this.prisma.withdrawal.findMany({
          where: { accountNumber: { in: variants } },
          select: { userId: true, accountNumber: true },
        }),
      ]);

      // The `IN` list is a superset of the frontier (it carries alternative
      // spellings), so every hit is re-normalized before it counts as a match.
      const candidateIds = new Set<string>();
      for (const match of profileMatches) {
        const key = normalizeRelationshipPhone(match.phone);
        if (key && frontierSet.has(key)) candidateIds.add(match.id);
      }
      for (const match of accountMatches) {
        const key = normalizeRelationshipPhone(match.accountNumber);
        if (key && frontierSet.has(key)) candidateIds.add(match.userId);
      }

      // Sorted so the same data always produces the same node ordering (and
      // the same nodes when the cap truncates the wave).
      const discovered = [...candidateIds]
        .filter((id) => !users.has(id))
        .sort();
      const accepted: string[] = [];
      for (const id of discovered) {
        if (users.size + phones.size + accepted.length >= MAX_NODES) {
          truncated = true;
          break;
        }
        accepted.push(id);
      }
      if (accepted.length === 0) break;

      const userRows = await this.prisma.user.findMany({
        where: { id: { in: accepted } },
        select: {
          id: true,
          username: true,
          displayName: true,
          phone: true,
          status: true,
          createdAt: true,
        },
      });
      for (const row of userRows) {
        users.set(row.id, {
          id: row.id,
          username: row.username,
          displayName: row.displayName,
          phone: row.phone,
          status: row.status,
          createdAt: row.createdAt,
          depth: phoneDepth + 1,
          withdrawalCount: 0,
          totalWithdrawnAmount: 0,
        });
      }

      // Withdrawal has @@index([userId]) — pulling a whole wave's rows by
      // userId and normalizing in memory is what makes the user -> phone hop
      // cheap, and it also catches spellings the `IN` list above can't.
      const waveWithdrawals: WithdrawalRow[] =
        await this.prisma.withdrawal.findMany({
          where: { userId: { in: accepted } },
          select: {
            id: true,
            userId: true,
            accountNumber: true,
            accountType: true,
            transferAccountSubname: true,
            amount: true,
            status: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
        });
      withdrawalsByUser.push(...waveWithdrawals);

      const nextFrontier: string[] = [];

      for (const row of userRows) {
        const profileKey = normalizeRelationshipPhone(row.phone);
        if (!profileKey) continue;
        if (
          registerPhone(profileKey, row.phone ?? profileKey, phoneDepth + 2)
        ) {
          nextFrontier.push(profileKey);
        }
        const node = phones.get(profileKey);
        if (!node) continue;
        node.linkedUserIds.add(row.id);
        this.upsertEdge(edges, row.id, profileKey, 'PROFILE');
      }

      for (const withdrawal of waveWithdrawals) {
        const user = users.get(withdrawal.userId);
        if (user) {
          user.withdrawalCount += 1;
          if (withdrawal.status === WithdrawalStatus.APPROVED) {
            user.totalWithdrawnAmount += decimalToNumber(
              withdrawal.amount as never,
            );
          }
        }

        const key = normalizeRelationshipPhone(withdrawal.accountNumber);
        if (!key) continue;
        if (registerPhone(key, withdrawal.accountNumber, phoneDepth + 2)) {
          nextFrontier.push(key);
        }
        const node = phones.get(key);
        if (!node) continue;

        const amount =
          withdrawal.status === WithdrawalStatus.APPROVED
            ? decimalToNumber(withdrawal.amount as never)
            : 0;
        node.withdrawalCount += 1;
        node.linkedUserIds.add(withdrawal.userId);
        node.firstUsedAt =
          node.firstUsedAt === null || withdrawal.createdAt < node.firstUsedAt
            ? withdrawal.createdAt
            : node.firstUsedAt;
        node.lastUsedAt =
          node.lastUsedAt === null || withdrawal.createdAt > node.lastUsedAt
            ? withdrawal.createdAt
            : node.lastUsedAt;
        const perUser = node.perUser.get(withdrawal.userId) ?? {
          withdrawalCount: 0,
          totalAmount: 0,
        };
        perUser.withdrawalCount += 1;
        perUser.totalAmount += amount;
        node.perUser.set(withdrawal.userId, perUser);

        const edge = this.upsertEdge(
          edges,
          withdrawal.userId,
          key,
          'WITHDRAWAL',
        );
        edge.withdrawalCount += 1;
        edge.totalAmount += amount;
      }

      frontier = nextFrontier;
      phoneDepth += 2;
    }

    if (users.size === 0) {
      // Nothing matched. That's a legitimate 200 with an empty network, not a
      // 404 — the phone simply isn't in the data.
      return emptyNetwork(seedRaw, seedNormalized);
    }

    const userIds = [...users.keys()];
    const [depositCounts, depositSums, recentDeposits] = await Promise.all([
      this.prisma.deposit.groupBy({
        by: ['userId'],
        where: { userId: { in: userIds } },
        _count: { _all: true },
      }),
      this.prisma.deposit.groupBy({
        by: ['userId'],
        where: { userId: { in: userIds }, status: DepositStatus.APPROVED },
        _sum: { amount: true },
      }),
      this.prisma.deposit.findMany({
        where: { userId: { in: userIds } },
        orderBy: { createdAt: 'desc' },
        // +1 so a full page is distinguishable from "there is more".
        take: ACTIVITY_LIMIT + 1,
        select: {
          id: true,
          userId: true,
          amount: true,
          status: true,
          createdAt: true,
          paymentMethod: true,
          reference: true,
          receivingAccountSubname: true,
          receivingPaymentAccount: { select: { subname: true } },
        },
      }),
    ]);

    const depositCountByUser = new Map<string, number>(
      depositCounts.map((row) => [row.userId, row._count._all]),
    );
    const depositSumByUser = new Map<string, number>(
      depositSums.map((row) => [
        row.userId,
        decimalToNumber(row._sum.amount as never),
      ]),
    );

    const userNodes: RelationshipUserNode[] = [...users.values()]
      .map((user) => ({
        id: user.id,
        name: labelFor(user),
        displayName: user.displayName,
        username: user.username,
        profilePhone: user.phone,
        status: user.status,
        depositCount: depositCountByUser.get(user.id) ?? 0,
        withdrawalCount: user.withdrawalCount,
        totalDepositedAmount: depositSumByUser.get(user.id) ?? 0,
        totalWithdrawnAmount: user.totalWithdrawnAmount,
        depth: user.depth,
        createdAt: user.createdAt,
      }))
      // Ordered by the caption the graph and tree actually print, so the node
      // list reads alphabetically to an admin scanning it. `username` is the
      // final tiebreak only — it is unique, so the order stays deterministic
      // when two accounts chose the same display name.
      .sort(
        (a, b) =>
          a.depth - b.depth ||
          a.name.localeCompare(b.name) ||
          a.username.localeCompare(b.username),
      );

    const phoneNodes: RelationshipPhoneNode[] = [...phones.values()]
      .map((phone) => {
        // `linkedUserIds` is a Set, so each attached user is folded in exactly
        // once no matter how many withdrawals tie them to this number.
        const userRefs: RelationshipPhoneUserRef[] = [...phone.linkedUserIds]
          .sort()
          .map((userId) => ({
            userId,
            withdrawalCount: phone.perUser.get(userId)?.withdrawalCount ?? 0,
            totalAmount: phone.perUser.get(userId)?.totalAmount ?? 0,
            depositCount: depositCountByUser.get(userId) ?? 0,
            totalDepositedAmount: depositSumByUser.get(userId) ?? 0,
          }));
        return {
          phone: phone.display,
          normalized: phone.normalized,
          userCount: phone.linkedUserIds.size,
          withdrawalCount: phone.withdrawalCount,
          depositCount: userRefs.reduce(
            (sum, ref) => sum + ref.depositCount,
            0,
          ),
          firstUsedAt: phone.firstUsedAt,
          lastUsedAt: phone.lastUsedAt,
          depth: phone.depth,
          users: userRefs,
        };
      })
      .sort(
        (a, b) => a.depth - b.depth || (a.normalized < b.normalized ? -1 : 1),
      );

    const recentActivity: RelationshipActivity[] = [
      ...recentDeposits.map((deposit) => ({
        id: deposit.id,
        type: 'DEPOSIT' as const,
        userId: deposit.userId,
        userName: labelFor(users.get(deposit.userId)),
        amount: decimalToNumber(deposit.amount as never),
        status: deposit.status,
        createdAt: deposit.createdAt,
        method:
          deposit.receivingPaymentAccount?.subname ??
          deposit.receivingAccountSubname ??
          deposit.paymentMethod,
        reference: deposit.reference,
        phone: null,
      })),
      ...withdrawalsByUser.map((withdrawal) => ({
        id: withdrawal.id,
        type: 'WITHDRAWAL' as const,
        userId: withdrawal.userId,
        userName: labelFor(users.get(withdrawal.userId)),
        amount: decimalToNumber(withdrawal.amount as never),
        status: withdrawal.status,
        createdAt: withdrawal.createdAt,
        method: withdrawal.transferAccountSubname ?? withdrawal.accountType,
        reference: null,
        phone: withdrawal.accountNumber,
      })),
    ]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const activityTruncated = recentActivity.length > ACTIVITY_LIMIT;
    if (activityTruncated) recentActivity.length = ACTIVITY_LIMIT;

    const totalDeposits = userNodes.reduce(
      (sum, user) => sum + user.depositCount,
      0,
    );
    const totalWithdrawals = userNodes.reduce(
      (sum, user) => sum + user.withdrawalCount,
      0,
    );
    const maxDepth = Math.max(
      ...userNodes.map((user) => user.depth),
      ...phoneNodes.map((phone) => phone.depth),
      0,
    );

    return {
      seedPhone: { raw: seedRaw, normalized: seedNormalized },
      users: userNodes,
      phones: phoneNodes,
      edges: [...edges.values()],
      stats: {
        totalUsers: userNodes.length,
        totalPhones: phoneNodes.length,
        totalDeposits,
        totalWithdrawals,
        maxDepth,
        truncated,
        activityTruncated,
      },
      recentActivity,
    };
  }

  /** One edge per (user, phone, kind) — repeat withdrawals accumulate onto it. */
  private upsertEdge(
    edges: Map<string, RelationshipEdge>,
    userId: string,
    phone: string,
    kind: RelationshipEdgeKind,
  ): RelationshipEdge {
    const key = `${userId}::${phone}::${kind}`;
    const existing = edges.get(key);
    if (existing) return existing;
    const edge: RelationshipEdge = {
      userId,
      phone,
      kind,
      withdrawalCount: 0,
      totalAmount: 0,
    };
    edges.set(key, edge);
    return edge;
  }
}
