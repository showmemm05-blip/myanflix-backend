import { HttpStatus, Injectable } from '@nestjs/common';
import {
  HomePromoArtPreset,
  HomePromoCtaTarget,
  HomePromoKind,
  type HomePromo,
  type Prisma,
} from '../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import {
  homePromoSnapshot,
  homeSettingsSnapshot,
} from '../audit/audit-snapshots';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { CodedHttpException } from '../common/errors/coded-http.exception';
import { MinioService } from '../common/storage/minio.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  HOME_PROMOS_PER_KIND_MAX,
  type CreateHomePromoDto,
  type ReorderHomePromosDto,
  type UpdateHomePromoDto,
} from './dto/home-promo.dto';
import type { UpdateHomeSettingsDto } from './dto/home-settings.dto';
import {
  HomeShowcaseService,
  settingsView,
  type HomeSettingsView,
} from './home-showcase.service';
import {
  isTitleTarget,
  loadTitleCards,
  titleKey,
  type ShowcaseTitle,
  type TitleRef,
  type TitleTargetType,
} from './home-titles';

/** Advisory-lock key for creating the one settings row (finance-settings precedent, L-38). */
export const HOME_SETTINGS_LOCK_NAMESPACE = 'home_settings.singleton';

/**
 * Advisory-lock key for one kind's list: create (count + insert) and reorder
 * hold it, so the per-kind cap and the positions stay exact under races.
 */
export const homePromoListLockKey = (kind: HomePromoKind) =>
  `home_promo.list.${kind}`;

/** Error codes a client can branch on; the message is for people. */
export const HOME_PROMO_ERRORS = {
  NOT_FOUND: 'HOME_PROMO_NOT_FOUND',
  TITLE_REQUIRED: 'HOME_PROMO_TITLE_REQUIRED',
  TRANSLATION_MISSING: 'HOME_PROMO_TRANSLATION_MISSING',
  SPOTLIGHT_NEEDS_TITLE: 'HOME_PROMO_SPOTLIGHT_NEEDS_TITLE',
  TARGET_REQUIRED: 'HOME_PROMO_TARGET_REQUIRED',
  TARGET_NOT_FOUND: 'HOME_PROMO_TARGET_NOT_FOUND',
  URL_REQUIRED: 'HOME_PROMO_URL_REQUIRED',
  CTA_LABEL_REQUIRED: 'HOME_PROMO_CTA_LABEL_REQUIRED',
  WINDOW_INVALID: 'HOME_PROMO_WINDOW_INVALID',
  LIMIT_REACHED: 'HOME_PROMO_LIMIT_REACHED',
  REORDER_MISMATCH: 'HOME_PROMO_REORDER_MISMATCH',
} as const;

const badRequest = (
  code: string,
  message: string,
  extra?: Record<string, string>,
) => new CodedHttpException(HttpStatus.BAD_REQUEST, code, message, extra);

const CREATED_BY_SELECT = {
  select: { id: true, username: true, displayName: true },
} as const;

type PromoRow = HomePromo & {
  createdBy: {
    id: string;
    username: string;
    displayName: string | null;
  } | null;
};

/** Whether a promo is on the home page right now, and if not, why. */
export type PromoLiveState = 'LIVE' | 'SCHEDULED' | 'ENDED' | 'OFF';

export function liveStateOf(
  promo: Pick<HomePromo, 'isActive' | 'startsAt' | 'endsAt'>,
  now = new Date(),
): PromoLiveState {
  if (!promo.isActive) return 'OFF';
  if (promo.endsAt && promo.endsAt.getTime() <= now.getTime()) return 'ENDED';
  if (promo.startsAt && promo.startsAt.getTime() > now.getTime())
    return 'SCHEDULED';
  return 'LIVE';
}

/** The linked title as the admin list shows it — hidden titles included. */
export interface StaffPromoTarget {
  type: TitleTargetType;
  id: string;
  /** Null when the title no longer exists. */
  title: string | null;
  imageUrl: string | null;
  /** False when deleted, unpublished, or (movie) an episode. */
  isVisible: boolean;
  missing: boolean;
}

export interface StaffPromoView {
  id: string;
  kind: HomePromoKind;
  titleEn: string;
  titleMm: string;
  kickerEn: string | null;
  kickerMm: string | null;
  bodyEn: string | null;
  bodyMm: string | null;
  ctaLabelEn: string | null;
  ctaLabelMm: string | null;
  ctaTarget: HomePromoCtaTarget;
  targetId: string | null;
  url: string | null;
  artPreset: HomePromoArtPreset;
  imageUrl: string | null;
  dateText: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  isActive: boolean;
  sortOrder: number;
  liveState: PromoLiveState;
  target: StaffPromoTarget | null;
  createdBy: {
    id: string;
    username: string;
    displayName: string | null;
  } | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface StaffSettingsView extends HomeSettingsView {
  /** Null until the first save. */
  updatedAt: Date | null;
  updatedBy: {
    id: string;
    username: string;
    displayName: string | null;
  } | null;
}

/** The writable promo fields, after the cross-field rules have run. */
type PromoFields = Omit<
  Prisma.HomePromoUncheckedCreateInput,
  'id' | 'kind' | 'createdById' | 'createdAt' | 'updatedAt' | 'sortOrder'
>;

/** The text pairs that must come as English + Burmese together. */
const TEXT_PAIRS = [
  ['kickerEn', 'kickerMm'],
  ['bodyEn', 'bodyMm'],
  ['ctaLabelEn', 'ctaLabelMm'],
] as const;

const toDate = (value: string | null | undefined) =>
  value === undefined ? undefined : value === null ? null : new Date(value);

/**
 * Staff side of the admin "Home promos" page. Every mutation records one
 * audit row (AuditService contract) and drops the public showcase cache, so
 * a change reaches the apps on their next home load.
 */
@Injectable()
export class HomePromosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly minioService: MinioService,
    private readonly audit: AuditService,
    private readonly showcase: HomeShowcaseService,
  ) {}

  // ---------------------------------------------------------------------
  // Promos
  // ---------------------------------------------------------------------

  async list(kind?: HomePromoKind): Promise<StaffPromoView[]> {
    const rows = await this.prisma.homePromo.findMany({
      where: kind ? { kind } : undefined,
      orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: { createdBy: CREATED_BY_SELECT },
    });
    return this.views(rows);
  }

  async findOne(id: string): Promise<StaffPromoView> {
    const row = await this.findRow(id);
    const [view] = await this.views([row]);
    return view;
  }

  async create(
    dto: CreateHomePromoDto,
    actor: AuthenticatedUser,
  ): Promise<StaffPromoView> {
    const fields = await this.resolveFields(dto.kind, {
      titleEn: dto.titleEn,
      titleMm: dto.titleMm,
      kickerEn: dto.kickerEn ?? null,
      kickerMm: dto.kickerMm ?? null,
      bodyEn: dto.bodyEn ?? null,
      bodyMm: dto.bodyMm ?? null,
      ctaLabelEn: dto.ctaLabelEn ?? null,
      ctaLabelMm: dto.ctaLabelMm ?? null,
      ctaTarget: dto.ctaTarget ?? HomePromoCtaTarget.NONE,
      targetId: dto.targetId ?? null,
      url: dto.url ?? null,
      artPreset: dto.artPreset ?? HomePromoArtPreset.GENERIC,
      imageUrl: dto.imageUrl ?? null,
      dateText: dto.dateText ?? null,
      startsAt: toDate(dto.startsAt) ?? null,
      endsAt: toDate(dto.endsAt) ?? null,
      isActive: dto.isActive ?? true,
    });

    // Count, insert and audit commit together under a per-list lock, so two
    // creates sent at the same moment cannot both pass the cap (31 of 30) or
    // take the same position.
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${homePromoListLockKey(dto.kind)}))`;
      const { _count, _max } = await tx.homePromo.aggregate({
        where: { kind: dto.kind },
        _count: { _all: true },
        _max: { sortOrder: true },
      });
      if (_count._all >= HOME_PROMOS_PER_KIND_MAX) {
        throw new CodedHttpException(
          HttpStatus.CONFLICT,
          HOME_PROMO_ERRORS.LIMIT_REACHED,
          `A list can hold at most ${HOME_PROMOS_PER_KIND_MAX} promos. Delete one first.`,
        );
      }

      const row = await tx.homePromo.create({
        data: {
          ...fields,
          kind: dto.kind,
          // New promos join the END of their list.
          sortOrder: (_max.sortOrder ?? -1) + 1,
          createdById: actor.id,
        },
        include: { createdBy: CREATED_BY_SELECT },
      });

      await this.audit.record({
        action: 'home_promo.create',
        actor,
        target: { type: 'home_promo', id: row.id, label: row.titleEn },
        after: homePromoSnapshot(row),
        metadata: { kind: row.kind },
        tx,
      });
      return row;
    });
    this.showcase.invalidate();
    return (await this.views([created]))[0];
  }

  async update(
    id: string,
    dto: UpdateHomePromoDto,
    actor: AuthenticatedUser,
  ): Promise<StaffPromoView> {
    const before = await this.findRow(id);

    // Absent = keep the stored value; null = clear it (the DTO already
    // refused null for the fields that cannot be empty).
    const pick = <K extends keyof UpdateHomePromoDto>(
      key: K,
      stored: unknown,
    ) => (dto[key] === undefined ? stored : dto[key]);

    const fields = await this.resolveFields(before.kind, {
      titleEn: pick('titleEn', before.titleEn) as string,
      titleMm: pick('titleMm', before.titleMm) as string,
      kickerEn: pick('kickerEn', before.kickerEn) as string | null,
      kickerMm: pick('kickerMm', before.kickerMm) as string | null,
      bodyEn: pick('bodyEn', before.bodyEn) as string | null,
      bodyMm: pick('bodyMm', before.bodyMm) as string | null,
      ctaLabelEn: pick('ctaLabelEn', before.ctaLabelEn) as string | null,
      ctaLabelMm: pick('ctaLabelMm', before.ctaLabelMm) as string | null,
      ctaTarget: pick('ctaTarget', before.ctaTarget) as HomePromoCtaTarget,
      targetId: pick('targetId', before.targetId) as string | null,
      url: pick('url', before.url) as string | null,
      artPreset: pick('artPreset', before.artPreset) as HomePromoArtPreset,
      imageUrl: pick('imageUrl', before.imageUrl) as string | null,
      dateText: pick('dateText', before.dateText) as string | null,
      startsAt:
        dto.startsAt === undefined ? before.startsAt : toDate(dto.startsAt)!,
      endsAt: dto.endsAt === undefined ? before.endsAt : toDate(dto.endsAt)!,
      isActive: pick('isActive', before.isActive) as boolean,
    });

    const after = await this.prisma.homePromo.update({
      where: { id },
      data: fields,
      include: { createdBy: CREATED_BY_SELECT },
    });

    await this.audit.record({
      action: 'home_promo.update',
      actor,
      target: { type: 'home_promo', id, label: after.titleEn },
      before: homePromoSnapshot(before),
      after: homePromoSnapshot(after),
      metadata: { kind: after.kind },
    });
    this.showcase.invalidate();
    return (await this.views([after]))[0];
  }

  async remove(id: string, actor: AuthenticatedUser): Promise<void> {
    const before = await this.findRow(id);
    await this.prisma.homePromo.delete({ where: { id } });
    await this.audit.record({
      action: 'home_promo.delete',
      actor,
      target: { type: 'home_promo', id, label: before.titleEn },
      before: homePromoSnapshot(before),
      metadata: { kind: before.kind },
    });
    this.showcase.invalidate();
  }

  /**
   * Rewrites the order of ONE kind. `ids` must be every promo of that kind,
   * each once — a stale or partial list is refused rather than half-applied.
   */
  async reorder(
    dto: ReorderHomePromosDto,
    actor: AuthenticatedUser,
  ): Promise<StaffPromoView[]> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${homePromoListLockKey(dto.kind)}))`;
      const existing = await tx.homePromo.findMany({
        where: { kind: dto.kind },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        select: { id: true },
      });
      const current = existing.map((row) => row.id);
      const wanted = new Set(dto.ids);
      if (
        current.length !== dto.ids.length ||
        current.some((rowId) => !wanted.has(rowId))
      ) {
        throw badRequest(
          HOME_PROMO_ERRORS.REORDER_MISMATCH,
          'The list changed while you were editing it. Reload and try again.',
        );
      }
      for (const [index, promoId] of dto.ids.entries()) {
        await tx.homePromo.update({
          where: { id: promoId },
          data: { sortOrder: index },
        });
      }
      // One row for the whole drag: ids in old order -> ids in new order.
      await this.audit.record({
        action: 'home_promo.reorder',
        actor,
        target: {
          type: 'home_promo',
          id: null,
          label: `${dto.ids.length} ${dto.kind} promos`,
        },
        metadata: { kind: dto.kind, before: current, after: dto.ids },
        tx,
      });
    });
    this.showcase.invalidate();
    return this.list(dto.kind);
  }

  // ---------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------

  async getSettings(): Promise<StaffSettingsView> {
    const row = await this.prisma.homeSettings.findFirst({
      orderBy: { createdAt: 'asc' },
      include: { updatedBy: CREATED_BY_SELECT },
    });
    return {
      ...settingsView(row),
      updatedAt: row?.updatedAt ?? null,
      updatedBy: row?.updatedBy ?? null,
    };
  }

  /** PUT semantics: the whole row is replaced; an omitted link is cleared. */
  async updateSettings(
    dto: UpdateHomeSettingsDto,
    actor: AuthenticatedUser,
  ): Promise<StaffSettingsView> {
    const data = {
      webUrl: dto.webUrl ?? null,
      appStoreUrl: dto.appStoreUrl ?? null,
      playStoreUrl: dto.playStoreUrl ?? null,
      gamesTeaserEnabled: dto.gamesTeaserEnabled,
      gamesTeaserDateText: dto.gamesTeaserDateText ?? null,
      updatedByUserId: actor.id,
    };

    // The new settings and their audit row commit together (finance-settings
    // precedent). The advisory lock stops two first saves on an empty table
    // from creating two rows.
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${HOME_SETTINGS_LOCK_NAMESPACE}))`;
      const current = await tx.homeSettings.findFirst({
        orderBy: { createdAt: 'asc' },
      });
      const saved = current
        ? await tx.homeSettings.update({ where: { id: current.id }, data })
        : await tx.homeSettings.create({ data });

      await this.audit.record({
        action: 'home_settings.update',
        actor,
        target: { type: 'home_settings', id: saved.id, label: 'Home settings' },
        before: homeSettingsSnapshot(current ?? {}),
        after: homeSettingsSnapshot(saved),
        tx,
      });
    });
    this.showcase.invalidate();
    return this.getSettings();
  }

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  private async findRow(id: string): Promise<PromoRow> {
    const row = await this.prisma.homePromo.findUnique({
      where: { id },
      include: { createdBy: CREATED_BY_SELECT },
    });
    if (!row) {
      throw new CodedHttpException(
        HttpStatus.NOT_FOUND,
        HOME_PROMO_ERRORS.NOT_FOUND,
        'Promo not found',
      );
    }
    return row;
  }

  /**
   * The cross-field rules, applied to the MERGED promo (stored row + patch)
   * so an edit is judged by what it will become:
   *  - titles are required; kicker / body / button label come as an
   *    English + Burmese pair or not at all;
   *  - a SPOTLIGHT always links a movie, series or book;
   *  - MOVIE / SERIES / BOOK need a targetId that exists (a movie must be a
   *    standalone film, not an episode); it need NOT be published yet — the
   *    showcase hides it until it is;
   *  - URL needs a url; a hero slide with a button needs both labels;
   *  - the window must end after it starts.
   * Leftovers are cleared rather than refused: a targetId without a title
   * target and a url without URL are set to null, so switching the button
   * type in the admin never needs two saves.
   */
  private async resolveFields(
    kind: HomePromoKind,
    merged: PromoFields & {
      startsAt: Date | null;
      endsAt: Date | null;
    },
  ): Promise<PromoFields> {
    const fields = { ...merged };

    if (!fields.titleEn || !fields.titleMm) {
      throw badRequest(
        HOME_PROMO_ERRORS.TITLE_REQUIRED,
        'Enter the title in English and in Burmese.',
      );
    }
    for (const [en, mm] of TEXT_PAIRS) {
      if (!fields[en] !== !fields[mm]) {
        throw badRequest(
          HOME_PROMO_ERRORS.TRANSLATION_MISSING,
          `Enter both ${en} and ${mm}, or neither.`,
          { field: fields[en] ? mm : en },
        );
      }
    }

    const ctaTarget = fields.ctaTarget ?? HomePromoCtaTarget.NONE;
    if (kind === HomePromoKind.SPOTLIGHT && !isTitleTarget(ctaTarget)) {
      throw badRequest(
        HOME_PROMO_ERRORS.SPOTLIGHT_NEEDS_TITLE,
        'A spotlight must link a movie, a series or a book.',
      );
    }

    if (isTitleTarget(ctaTarget)) {
      if (!fields.targetId) {
        throw badRequest(
          HOME_PROMO_ERRORS.TARGET_REQUIRED,
          'Choose the title this promo opens.',
        );
      }
      await this.assertTargetExists({ type: ctaTarget, id: fields.targetId });
    } else {
      fields.targetId = null;
    }

    if (ctaTarget === HomePromoCtaTarget.URL) {
      if (!fields.url) {
        throw badRequest(
          HOME_PROMO_ERRORS.URL_REQUIRED,
          'Enter the link this promo opens.',
        );
      }
    } else {
      fields.url = null;
    }

    if (
      kind === HomePromoKind.HERO &&
      ctaTarget !== HomePromoCtaTarget.NONE &&
      (!fields.ctaLabelEn || !fields.ctaLabelMm)
    ) {
      throw badRequest(
        HOME_PROMO_ERRORS.CTA_LABEL_REQUIRED,
        'A slide with a button needs the button text in English and in Burmese.',
      );
    }

    if (
      fields.startsAt &&
      fields.endsAt &&
      fields.startsAt.getTime() >= fields.endsAt.getTime()
    ) {
      throw badRequest(
        HOME_PROMO_ERRORS.WINDOW_INVALID,
        'The end time must be after the start time.',
      );
    }

    // Persisted canonical, like every image URL (MinioService.canonicalImageUrl).
    fields.imageUrl = this.minioService.canonicalImageUrl(fields.imageUrl);
    fields.ctaTarget = ctaTarget;
    return fields;
  }

  private async assertTargetExists(ref: TitleRef): Promise<void> {
    const found = await loadTitleCards(this.prisma, [ref], false);
    if (!found.has(titleKey(ref.type, ref.id))) {
      throw badRequest(
        HOME_PROMO_ERRORS.TARGET_NOT_FOUND,
        ref.type === 'MOVIE'
          ? 'That movie does not exist (episodes are linked through their series).'
          : `That ${ref.type.toLowerCase()} does not exist.`,
      );
    }
  }

  /** Staff shape for a batch of rows — three queries per pass for all targets. */
  private async views(rows: PromoRow[]): Promise<StaffPromoView[]> {
    const refs: TitleRef[] = rows.flatMap((row) =>
      isTitleTarget(row.ctaTarget) && row.targetId
        ? [{ type: row.ctaTarget, id: row.targetId }]
        : [],
    );
    const [all, visible] = refs.length
      ? await Promise.all([
          loadTitleCards(this.prisma, refs, false),
          loadTitleCards(this.prisma, refs, true),
        ])
      : [new Map<string, ShowcaseTitle>(), new Map<string, ShowcaseTitle>()];
    const now = new Date();

    return rows.map((row) => {
      let target: StaffPromoTarget | null = null;
      if (isTitleTarget(row.ctaTarget) && row.targetId) {
        const key = titleKey(row.ctaTarget, row.targetId);
        const card = all.get(key);
        target = {
          type: row.ctaTarget,
          id: row.targetId,
          title: card?.title ?? null,
          imageUrl: this.minioService.imageUrl(
            card?.posterUrl ?? card?.coverUrl ?? null,
          ),
          isVisible: visible.has(key),
          missing: !card,
        };
      }
      return {
        id: row.id,
        kind: row.kind,
        titleEn: row.titleEn,
        titleMm: row.titleMm,
        kickerEn: row.kickerEn,
        kickerMm: row.kickerMm,
        bodyEn: row.bodyEn,
        bodyMm: row.bodyMm,
        ctaLabelEn: row.ctaLabelEn,
        ctaLabelMm: row.ctaLabelMm,
        ctaTarget: row.ctaTarget,
        targetId: row.targetId,
        url: row.url,
        artPreset: row.artPreset,
        imageUrl: this.minioService.imageUrl(row.imageUrl),
        dateText: row.dateText,
        startsAt: row.startsAt,
        endsAt: row.endsAt,
        isActive: row.isActive,
        sortOrder: row.sortOrder,
        liveState: liveStateOf(row, now),
        target,
        createdBy: row.createdBy,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    });
  }
}
