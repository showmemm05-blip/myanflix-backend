import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { UpdateAdditionalPeakDto } from './dto/update-additional-peak.dto';

@Injectable()
export class PeakUsersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Lazily creates the single global stats row on first read — mirrors
   * FinanceSettingsService.getOrCreate so callers never special-case
   * "not tracked yet".
   */
  async getOrCreate() {
    const existing = await this.prisma.peakUserStats.findFirst();
    if (existing) return existing;

    return this.prisma.peakUserStats.create({ data: {} });
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
  async setAdditional(dto: UpdateAdditionalPeakDto, adminId: string) {
    const current = await this.getOrCreate();

    const updated = await this.prisma.peakUserStats.update({
      where: { id: current.id },
      data: {
        additionalPeak: dto.additionalPeak,
        updatedByUserId: adminId,
      },
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
    const current = await this.getOrCreate();
    if (count <= current.actualPeak) return;

    await this.prisma.peakUserStats.update({
      where: { id: current.id },
      data: { actualPeak: count, actualPeakAt: new Date() },
    });
  }
}
