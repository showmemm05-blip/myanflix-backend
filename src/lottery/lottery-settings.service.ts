import { BadRequestException, Injectable } from '@nestjs/common';
import type { LotterySettings, Prisma } from '../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import { lotterySettingsSnapshot } from '../audit/audit-snapshots';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { MinioService } from '../common/storage/minio.service';
import { decimalToNumber } from '../common/utils/decimal.util';
import { PrismaService } from '../prisma/prisma.service';
import {
  isHttpUrl,
  isPublicHostname,
  RESULTS_URL_PRIVATE_HOST_MESSAGE,
} from './dto/lottery-results.dto';
import type { UpdateLotterySettingsDto } from './dto/lottery-settings.dto';

/** Advisory-lock key for creating the one settings row (finance-settings precedent, L-38). */
export const LOTTERY_SETTINGS_LOCK_NAMESPACE = 'lottery_settings.singleton';

/** The staff member who last saved, as the settings page names them. */
const UPDATED_BY_SELECT = {
  select: { id: true, username: true, displayName: true },
} as const;

export interface StaffRef {
  id: string;
  username: string;
  displayName: string | null;
}

export type LotterySettingsRow = LotterySettings & {
  updatedBy: StaffRef | null;
};

/** Settings as the admin page reads them. */
export interface LotterySettingsView {
  ticketPrice: number;
  maxPerNumber: number;
  exchangeRate: number;
  salesCloseMinutesBefore: number;
  /** The ticket frame new draws get (re-hosted like a picture); null = the built-in frame. */
  frameUrl: string | null;
  /** Where winning numbers are fetched from (phase 3); null = entered by hand. */
  resultsUrl: string | null;
  /** Which parser reads the source's answer; only "thai_lotto_json" exists. */
  resultsSourceKind: string;
  /** Days after publishing a prize may still be requested (copied into the draw at publish). */
  claimDeadlineDays: number;
  updatedAt: Date;
  updatedBy: { id: string; label: string } | null;
}

/** The admin's naming rule (admin/lib/user-label.ts): the display name, else the username. */
export function staffLabel(user: StaffRef): string {
  return user.displayName?.trim() || user.username;
}

/**
 * The single global row of lottery settings (lottery backend phase 2).
 * Read by the draw service when a draw is created (price, per-number
 * limit, sales-close gap and the ticket frame are COPIED into the draw)
 * and, in phase 3, when results are published (exchange rate, and since
 * 2026-10-24 the claim deadline in days). Changing a setting never touches
 * a draw that already exists.
 */
@Injectable()
export class LotterySettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly minioService: MinioService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Lazily creates the row with the schema defaults on first read, under
   * an advisory lock so two first requests on an empty table cannot both
   * create one (FinanceSettingsService precedent).
   */
  async getOrCreate(): Promise<LotterySettingsRow> {
    const existing = await this.prisma.lotterySettings.findFirst({
      include: { updatedBy: UPDATED_BY_SELECT },
    });
    if (existing) return existing;

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${LOTTERY_SETTINGS_LOCK_NAMESPACE}))`;
      const raced = await tx.lotterySettings.findFirst({
        include: { updatedBy: UPDATED_BY_SELECT },
      });
      if (raced) return raced;
      return tx.lotterySettings.create({
        data: {},
        include: { updatedBy: UPDATED_BY_SELECT },
      });
    });
  }

  async get(): Promise<LotterySettingsView> {
    return this.view(await this.getOrCreate());
  }

  /** Absent fields keep their value; a body that changes nothing writes nothing (no audit row either). */
  async update(
    dto: UpdateLotterySettingsDto,
    actor: AuthenticatedUser,
  ): Promise<LotterySettingsView> {
    const current = await this.getOrCreate();

    const data: Prisma.LotterySettingsUpdateInput = {};
    if (
      dto.ticketPrice !== undefined &&
      !current.ticketPrice.equals(dto.ticketPrice)
    ) {
      data.ticketPrice = dto.ticketPrice;
    }
    if (
      dto.maxPerNumber !== undefined &&
      dto.maxPerNumber !== current.maxPerNumber
    ) {
      data.maxPerNumber = dto.maxPerNumber;
    }
    if (
      dto.exchangeRate !== undefined &&
      !current.exchangeRate.equals(dto.exchangeRate)
    ) {
      data.exchangeRate = dto.exchangeRate;
    }
    if (
      dto.salesCloseMinutesBefore !== undefined &&
      dto.salesCloseMinutesBefore !== current.salesCloseMinutesBefore
    ) {
      data.salesCloseMinutesBefore = dto.salesCloseMinutesBefore;
    }
    if (dto.frameUrl !== undefined) {
      // Compared canonical: the admin echoes the re-hosted URL it was
      // given, which is the same object under whichever host asked.
      const frameUrl = dto.frameUrl
        ? this.minioService.canonicalImageUrl(dto.frameUrl)
        : null;
      if (frameUrl !== current.frameUrl) data.frameUrl = frameUrl;
    }
    if (dto.resultsUrl !== undefined) {
      const resultsUrl = dto.resultsUrl ? dto.resultsUrl.trim() : null;
      if (resultsUrl !== null && !isHttpUrl(resultsUrl)) {
        throw new BadRequestException(
          'resultsUrl must be an absolute http or https URL',
        );
      }
      if (
        resultsUrl !== null &&
        !isPublicHostname(new URL(resultsUrl).hostname)
      ) {
        throw new BadRequestException(RESULTS_URL_PRIVATE_HOST_MESSAGE);
      }
      if (resultsUrl !== current.resultsUrl) data.resultsUrl = resultsUrl;
    }
    if (
      dto.claimDeadlineDays !== undefined &&
      dto.claimDeadlineDays !== current.claimDeadlineDays
    ) {
      data.claimDeadlineDays = dto.claimDeadlineDays;
    }
    if (Object.keys(data).length === 0) return this.view(current);

    // The new values and their audit row commit together or not at all.
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.lotterySettings.update({
        where: { id: current.id },
        data: { ...data, updatedBy: { connect: { id: actor.id } } },
        include: { updatedBy: UPDATED_BY_SELECT },
      });
      await this.audit.record({
        action: 'lottery_settings.update',
        actor,
        target: {
          type: 'lottery_settings',
          id: current.id,
          label: 'Lottery settings',
        },
        before: lotterySettingsSnapshot(current),
        after: lotterySettingsSnapshot(row),
        tx,
      });
      return row;
    });
    return this.view(updated);
  }

  view(row: LotterySettingsRow): LotterySettingsView {
    return {
      ticketPrice: decimalToNumber(row.ticketPrice),
      maxPerNumber: row.maxPerNumber,
      exchangeRate: decimalToNumber(row.exchangeRate),
      salesCloseMinutesBefore: row.salesCloseMinutesBefore,
      frameUrl: this.minioService.imageUrl(row.frameUrl),
      resultsUrl: row.resultsUrl,
      resultsSourceKind: row.resultsSourceKind,
      claimDeadlineDays: row.claimDeadlineDays,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy
        ? { id: row.updatedBy.id, label: staffLabel(row.updatedBy) }
        : null,
    };
  }
}
