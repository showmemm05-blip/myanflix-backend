import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { peakUsersSnapshot } from '../audit/audit-snapshots';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import type { UpdateAdditionalPeakDto } from './dto/update-additional-peak.dto';

@Injectable()
export class PeakUsersService {
  /**
   * The stored actualPeak as last read or written by this process. Lets the
   * socket connect path skip the database entirely for a count that cannot
   * be a new peak. Re-synced to the database value on every getOrCreate()
   * read (so a reset row is noticed again), and whenever a conditional write
   * matches nothing. If it is ever stale-high, the next admin or public read
   * corrects it; if it is stale-low, the cost is one no-op write.
   */
  private knownPeak = 0;

  /**
   * Id of the singleton row, once read. The conditional write targets this
   * row only — the same single row the old read-then-write updated.
   */
  private rowId: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Lazily creates the single global stats row on first read — mirrors
   * FinanceSettingsService.getOrCreate so callers never special-case
   * "not tracked yet".
   */
  async getOrCreate() {
    const existing = await this.prisma.peakUserStats.findFirst();
    const row =
      existing ?? (await this.prisma.peakUserStats.create({ data: {} }));
    this.rowId = row.id;
    this.knownPeak = row.actualPeak;
    return row;
  }

  /**
   * The one shape public callers ever see — the combined total only. The
   * actual/additional split must never leave the admin surface (exposing it
   * would reveal the adjustment).
   */
  async getPublicTotal(): Promise<{ peakUsers: number }> {
    const stats = await this.getOrCreate();
    return { peakUsers: stats.actualPeak + stats.additionalPeak };
  }

  async getAdminView() {
    const stats = await this.getOrCreate();
    return {
      actualPeak: stats.actualPeak,
      actualPeakAt: stats.actualPeakAt,
      additionalPeak: stats.additionalPeak,
      displayedPeak: stats.actualPeak + stats.additionalPeak,
    };
  }

  /** Sets the admin adjustment (0 allowed = reset) and records who set it. */
  async setAdditional(dto: UpdateAdditionalPeakDto, admin: AuthenticatedUser) {
    const current = await this.getOrCreate();

    const updated = await this.prisma.peakUserStats.update({
      where: { id: current.id },
      data: {
        additionalPeak: dto.additionalPeak,
        updatedByUserId: admin.id,
      },
    });

    await this.audit.record({
      action: 'peak_users.update',
      actor: admin,
      target: { type: 'peak_users', id: current.id, label: 'Peak users' },
      before: peakUsersSnapshot(current),
      after: peakUsersSnapshot(updated),
    });

    return {
      actualPeak: updated.actualPeak,
      actualPeakAt: updated.actualPeakAt,
      additionalPeak: updated.additionalPeak,
      displayedPeak: updated.actualPeak + updated.additionalPeak,
    };
  }

  /**
   * Called by the realtime gateway with the current distinct concurrent USER
   * count. Persists only when a new high-water mark is reached — naturally
   * rare, so the socket connect path almost never writes.
   */
  async recordConcurrent(count: number): Promise<void> {
    if (count <= this.knownPeak) return;

    // One conditional write instead of read-then-write: it raises the peak
    // only while the stored one is lower, so two connects racing each other
    // can never lower it again.
    if (this.rowId && (await this.raisePeakTo(this.rowId, count))) return;

    // Row not read yet, or nothing matched: either the stored peak already
    // covers this count (another process raised it) or the row was reset or
    // replaced. Read the truth (creating the row if missing) and retry once.
    const current = await this.getOrCreate();
    if (count > current.actualPeak) await this.raisePeakTo(current.id, count);
  }

  /** Raises actualPeak to `count` if it is lower; true when it was raised. */
  private async raisePeakTo(id: string, count: number): Promise<boolean> {
    const { count: raised } = await this.prisma.peakUserStats.updateMany({
      where: { id, actualPeak: { lt: count } },
      data: { actualPeak: count, actualPeakAt: new Date() },
    });
    if (raised === 0) return false;
    this.knownPeak = Math.max(this.knownPeak, count);
    return true;
  }
}
