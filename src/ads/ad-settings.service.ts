import { Injectable } from '@nestjs/common';
import {
  AdvertisementAudience,
  AdvertisementFormat,
} from '../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import { adSettingsSnapshot } from '../audit/audit-snapshots';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { PrismaService } from '../prisma/prisma.service';
import {
  AD_SETTINGS_DEFAULTS,
  type UpdateAdSettingsDto,
} from './dto/ad-settings.dto';

/** Advisory-lock key for the single row: two first saves on an empty table must not create two rows. */
export const AD_SETTINGS_LOCK_NAMESPACE = 'ad_settings.singleton';

/** How long a decision trusts the rules it read (a save clears it at once on this instance). */
export const AD_SETTINGS_CACHE_MS = 30_000;

/** The rules every ad decision applies. */
export interface AdRules {
  adsEnabled: boolean;
  midrollIntervalMinutes: number;
  duringMovieAudience: AdvertisementAudience;
}

/** Ads live right now for each slot — the admin preview warns when a slot is empty. */
export interface AdLiveCounts {
  preroll: number;
  breaks: number;
  corner: number;
}

export interface AdSettingsView extends AdRules {
  /** Null until the first save (the defaults are in force). */
  updatedAt: Date | null;
  updatedBy: {
    id: string;
    username: string;
    displayName: string | null;
  } | null;
  liveCounts: AdLiveCounts;
}

/**
 * The "Advertisements" page's playback rules — one global row, read by the
 * admin (GET/PUT /ads/admin/settings) and by every ad decision. The decision
 * path reads through a short in-memory cache: it runs on every Play, the
 * rules change a few times a year.
 */
@Injectable()
export class AdSettingsService {
  private cached: { rules: AdRules; at: number } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async get(now = new Date()): Promise<AdSettingsView> {
    const [row, liveCounts] = await Promise.all([
      this.prisma.adSettings.findFirst({
        orderBy: { createdAt: 'asc' },
        include: {
          updatedBy: {
            select: { id: true, username: true, displayName: true },
          },
        },
      }),
      this.liveCounts(now),
    ]);
    return {
      ...rulesOf(row),
      updatedAt: row?.updatedAt ?? null,
      updatedBy: row?.updatedBy ?? null,
      liveCounts,
    };
  }

  /** PUT semantics: the whole row is replaced. The rules and their audit row commit together. */
  async update(
    dto: UpdateAdSettingsDto,
    actor: AuthenticatedUser,
  ): Promise<AdSettingsView> {
    const data = {
      adsEnabled: dto.adsEnabled,
      midrollIntervalMinutes: dto.midrollIntervalMinutes,
      duringMovieAudience: dto.duringMovieAudience,
      updatedByUserId: actor.id,
    };
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${AD_SETTINGS_LOCK_NAMESPACE}))`;
      const current = await tx.adSettings.findFirst({
        orderBy: { createdAt: 'asc' },
      });
      const saved = current
        ? await tx.adSettings.update({ where: { id: current.id }, data })
        : await tx.adSettings.create({ data });
      await this.audit.record({
        action: 'advertisement_settings.update',
        actor,
        target: {
          type: 'advertisement_settings',
          id: saved.id,
          label: 'Advertisement playback rules',
        },
        before: adSettingsSnapshot(current ?? AD_SETTINGS_DEFAULTS),
        after: adSettingsSnapshot(saved),
        tx,
      });
    });
    this.cached = null;
    return this.get();
  }

  /** The rules a decision applies right now (cached for AD_SETTINGS_CACHE_MS). */
  async rules(now = Date.now()): Promise<AdRules> {
    if (this.cached && now - this.cached.at < AD_SETTINGS_CACHE_MS) {
      return this.cached.rules;
    }
    const row = await this.prisma.adSettings.findFirst({
      orderBy: { createdAt: 'asc' },
      select: {
        adsEnabled: true,
        midrollIntervalMinutes: true,
        duringMovieAudience: true,
      },
    });
    const rules = rulesOf(row);
    this.cached = { rules, at: now };
    return rules;
  }

  /** On, with their video / picture, inside their start and end dates (the daily window is not applied). */
  private async liveCounts(now: Date): Promise<AdLiveCounts> {
    const live = await this.prisma.advertisement.findMany({
      where: {
        isActive: true,
        AND: [
          { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
          { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
          {
            OR: [
              { format: AdvertisementFormat.VIDEO, videoKey: { not: null } },
              { format: AdvertisementFormat.CORNER, imageKey: { not: null } },
            ],
          },
        ],
      },
      select: { format: true, playsBeforeMovie: true, playsAtBreaks: true },
    });
    const counts: AdLiveCounts = { preroll: 0, breaks: 0, corner: 0 };
    for (const ad of live) {
      if (ad.format === AdvertisementFormat.CORNER) counts.corner += 1;
      else {
        if (ad.playsBeforeMovie) counts.preroll += 1;
        if (ad.playsAtBreaks) counts.breaks += 1;
      }
    }
    return counts;
  }
}

function rulesOf(row: Partial<AdRules> | null): AdRules {
  return {
    adsEnabled: row?.adsEnabled ?? AD_SETTINGS_DEFAULTS.adsEnabled,
    midrollIntervalMinutes:
      row?.midrollIntervalMinutes ??
      AD_SETTINGS_DEFAULTS.midrollIntervalMinutes,
    duringMovieAudience:
      row?.duringMovieAudience ?? AD_SETTINGS_DEFAULTS.duringMovieAudience,
  };
}
