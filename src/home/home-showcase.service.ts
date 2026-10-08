import { Injectable } from '@nestjs/common';
import {
  HomePromoCtaTarget,
  HomePromoKind,
  type HomePromo,
  type HomeSettings,
} from '../generated/prisma/client';
import { MinioService } from '../common/storage/minio.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  isTitleTarget,
  loadTitleCards,
  loadVisibleTitleKeys,
  MOVIE_CARD_SELECT,
  movieCard,
  titleKey,
  USER_VISIBLE,
  type ShowcaseTitle,
  type TitleRef,
} from './home-titles';

/** How long one database read of the showcase is served from memory. */
export const SHOWCASE_CACHE_TTL_MS = 60_000;

/** The settings every app reads; the defaults stand until the first PUT. */
export interface HomeSettingsView {
  webUrl: string | null;
  appStoreUrl: string | null;
  playStoreUrl: string | null;
  gamesTeaserEnabled: boolean;
  gamesTeaserDateText: string | null;
}

export const DEFAULT_HOME_SETTINGS: HomeSettingsView = {
  webUrl: null,
  appStoreUrl: null,
  playStoreUrl: null,
  gamesTeaserEnabled: true,
  gamesTeaserDateText: null,
};

export function settingsView(row: HomeSettings | null): HomeSettingsView {
  if (!row) return { ...DEFAULT_HOME_SETTINGS };
  return {
    webUrl: row.webUrl,
    appStoreUrl: row.appStoreUrl,
    playStoreUrl: row.playStoreUrl,
    gamesTeaserEnabled: row.gamesTeaserEnabled,
    gamesTeaserDateText: row.gamesTeaserDateText,
  };
}

/** One promo as the apps draw it. */
export interface ShowcasePromo {
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
  url: string | null;
  artPreset: HomePromo['artPreset'];
  imageUrl: string | null;
  dateText: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  /** The linked title when ctaTarget is MOVIE / SERIES / BOOK, else null. */
  target: ShowcaseTitle | null;
}

export interface ShowcaseSpotlight {
  /** PROMO = the admin's spotlight; NEWEST_MOVIE = the fallback. */
  source: 'PROMO' | 'NEWEST_MOVIE';
  promo: ShowcasePromo | null;
  title: ShowcaseTitle;
}

export interface HomeShowcase {
  hero: ShowcasePromo[];
  spotlight: ShowcaseSpotlight | null;
  comingSoon: ShowcasePromo[];
  settings: HomeSettingsView;
}

/** A promo row with its target already resolved under USER visibility. */
interface LoadedPromo extends HomePromo {
  /** Null when there is no title target, or it is missing / not visible. */
  visibleTarget: ShowcaseTitle | null;
}

interface LoadedShowcase {
  promos: LoadedPromo[];
  settings: HomeSettingsView;
  newestMovie: ShowcaseTitle | null;
}

/**
 * GET /home/showcase — the home page's promos and settings for every app,
 * guests included.
 *
 * One database read is kept in memory for SHOWCASE_CACHE_TTL_MS and dropped
 * at once by invalidate(), which HomePromosService calls after every staff
 * change to promos or settings. What is cached is viewer-neutral; four
 * things are applied per request on top of it, so the cache can never leak
 * or go stale on them:
 *  - title visibility: before an answer is served from memory, the titles it
 *    can show (linked targets + the newest-movie fallback) are re-checked in
 *    at most three primary-key lookups. If any was unpublished, deleted or
 *    made an episode on another admin page since the read, the cache is
 *    dropped and read again — a hidden title never reaches a guest, not even
 *    for the rest of the TTL;
 *  - the start/end window, against the current clock (a promo goes live or
 *    ends on time, not up to a minute late);
 *  - books, linked only for a signed-in viewer (the /books routes are not
 *    open to guests);
 *  - image URLs, re-hosted for the address this request came in on, like
 *    every other image URL (MinioService.imageUrl).
 * Harmless lag only: a NEWLY published title, or a renamed / new poster,
 * shows up within the TTL.
 */
@Injectable()
export class HomeShowcaseService {
  private cache: { loadedAt: number; data: LoadedShowcase } | null = null;
  private inflight: Promise<LoadedShowcase> | null = null;
  /** Bumped by invalidate(), so a read that started before it is not cached. */
  private generation = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly minioService: MinioService,
  ) {}

  /** Forget the cached read — the next request loads fresh rows. */
  invalidate(): void {
    this.generation += 1;
    this.cache = null;
    this.inflight = null;
  }

  async getShowcase(
    signedIn: boolean,
    now = new Date(),
  ): Promise<HomeShowcase> {
    const data = await this.loadChecked();
    const at = now.getTime();
    const live = data.promos.filter(
      (promo) =>
        (promo.startsAt === null || promo.startsAt.getTime() <= at) &&
        (promo.endsAt === null || promo.endsAt.getTime() > at),
    );
    const targetFor = (promo: LoadedPromo): ShowcaseTitle | null => {
      const target = promo.visibleTarget;
      if (!target) return null;
      if (target.type === 'BOOK' && !signedIn) return null;
      return target;
    };

    // A hero slide whose button would open a title the viewer cannot see is
    // a dead end, so the whole slide is skipped.
    const hero = live
      .filter((promo) => promo.kind === HomePromoKind.HERO)
      .flatMap((promo) => {
        if (!isTitleTarget(promo.ctaTarget)) return [this.view(promo, null)];
        const target = targetFor(promo);
        return target ? [this.view(promo, target)] : [];
      });

    // The first live spotlight whose title the viewer can open; otherwise
    // the newest published movie.
    let spotlight: ShowcaseSpotlight | null = null;
    for (const promo of live) {
      if (promo.kind !== HomePromoKind.SPOTLIGHT) continue;
      const target = targetFor(promo);
      if (!target) continue;
      spotlight = {
        source: 'PROMO',
        promo: this.view(promo, target),
        title: this.rehostTitle(target),
      };
      break;
    }
    if (!spotlight && data.newestMovie) {
      spotlight = {
        source: 'NEWEST_MOVIE',
        promo: null,
        title: this.rehostTitle(data.newestMovie),
      };
    }

    // A coming-soon card is about something NOT out yet, so it stays even
    // when its title is unpublished — it just loses its link.
    const comingSoon = live
      .filter((promo) => promo.kind === HomePromoKind.COMING_SOON)
      .map((promo) => {
        if (!isTitleTarget(promo.ctaTarget)) return this.view(promo, null);
        const target = targetFor(promo);
        return target
          ? this.view(promo, target)
          : { ...this.view(promo, null), ctaTarget: HomePromoCtaTarget.NONE };
      });

    return { hero, spotlight, comingSoon, settings: { ...data.settings } };
  }

  /**
   * The showcase read, with a cached one re-checked against the catalogue:
   * when a title it would show is no longer USER-visible, the cache is
   * dropped and the rows are read again (a fresh read needs no check).
   */
  private async loadChecked(): Promise<LoadedShowcase> {
    const { data, cached } = await this.load();
    if (!cached) return data;

    const shown: TitleRef[] = [];
    for (const promo of data.promos) {
      if (promo.visibleTarget) {
        shown.push({
          type: promo.visibleTarget.type,
          id: promo.visibleTarget.id,
        });
      }
    }
    if (data.newestMovie)
      shown.push({ type: 'MOVIE', id: data.newestMovie.id });
    if (!shown.length) return data;

    const visible = await loadVisibleTitleKeys(this.prisma, shown);
    if (shown.every((ref) => visible.has(titleKey(ref.type, ref.id)))) {
      return data;
    }
    // Only drop the snapshot that went stale: concurrent requests that found
    // the same thing then share one re-read instead of each starting one.
    if (this.cache?.data === data) this.invalidate();
    return (await this.load()).data;
  }

  /** `cached` = served from memory (not a read this call started or joined). */
  private async load(): Promise<{ data: LoadedShowcase; cached: boolean }> {
    if (
      this.cache &&
      Date.now() - this.cache.loadedAt < SHOWCASE_CACHE_TTL_MS
    ) {
      return { data: this.cache.data, cached: true };
    }
    if (this.inflight) return { data: await this.inflight, cached: false };

    const generation = this.generation;
    const pending = this.read().then((data) => {
      if (generation === this.generation) {
        this.cache = { loadedAt: Date.now(), data };
      }
      return data;
    });
    this.inflight = pending;
    try {
      return { data: await pending, cached: false };
    } finally {
      if (this.inflight === pending) this.inflight = null;
    }
  }

  private async read(): Promise<LoadedShowcase> {
    const now = new Date();
    const [promos, settingsRow, newest] = await Promise.all([
      this.prisma.homePromo.findMany({
        // Not-yet-started promos are kept (they go live inside the TTL);
        // ended ones can never come back, so they are dropped here.
        where: {
          isActive: true,
          OR: [{ endsAt: null }, { endsAt: { gt: now } }],
        },
        orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
      }),
      this.prisma.homeSettings.findFirst({ orderBy: { createdAt: 'asc' } }),
      this.prisma.movie.findFirst({
        where: USER_VISIBLE.movie,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: MOVIE_CARD_SELECT,
      }),
    ]);

    const refs: TitleRef[] = [];
    for (const promo of promos) {
      if (isTitleTarget(promo.ctaTarget) && promo.targetId) {
        refs.push({ type: promo.ctaTarget, id: promo.targetId });
      }
    }
    const cards = await loadTitleCards(this.prisma, refs, true);

    return {
      promos: promos.map((promo) => ({
        ...promo,
        visibleTarget:
          isTitleTarget(promo.ctaTarget) && promo.targetId
            ? (cards.get(titleKey(promo.ctaTarget, promo.targetId)) ?? null)
            : null,
      })),
      settings: settingsView(settingsRow),
      newestMovie: newest ? movieCard(newest) : null,
    };
  }

  private view(
    promo: LoadedPromo,
    target: ShowcaseTitle | null,
  ): ShowcasePromo {
    return {
      id: promo.id,
      kind: promo.kind,
      titleEn: promo.titleEn,
      titleMm: promo.titleMm,
      kickerEn: promo.kickerEn,
      kickerMm: promo.kickerMm,
      bodyEn: promo.bodyEn,
      bodyMm: promo.bodyMm,
      ctaLabelEn: promo.ctaLabelEn,
      ctaLabelMm: promo.ctaLabelMm,
      ctaTarget: promo.ctaTarget,
      url: promo.url,
      artPreset: promo.artPreset,
      imageUrl: this.minioService.imageUrl(promo.imageUrl),
      dateText: promo.dateText,
      startsAt: promo.startsAt,
      endsAt: promo.endsAt,
      target: target ? this.rehostTitle(target) : null,
    };
  }

  private rehostTitle(title: ShowcaseTitle): ShowcaseTitle {
    return {
      ...title,
      posterUrl: this.minioService.imageUrl(title.posterUrl),
      coverUrl: this.minioService.imageUrl(title.coverUrl),
      thumbnailUrl: this.minioService.imageUrl(title.thumbnailUrl),
    };
  }
}
