/**
 * The ONE place the backend decides what a master.m3u8 looks like — the
 * variant order and the RESOLUTION it states — so every writer agrees:
 * ProcessingService writes the classic flow's master from this;
 * HlsSubtitlesService (hls-subtitle-manifest.ts) only ever INSERTS the
 * subtitle group into an existing master, preserving the order and sizes
 * found there; the bundle flows (UploadsService finalize / replace) copy
 * the Transcoder's master as uploaded, and the Transcoder
 * (transcoder/electron/ffmpeg/) applies this same rule on its side.
 * Pure string work — no I/O — so the rule is pinned by a plain unit test.
 */

/** One `#EXT-X-STREAM-INF` entry of a master playlist. */
export interface MasterVariant {
  /** Rendition folder and label (`720p`) — the URI is `<name>/index.m3u8`. */
  name: string;
  /**
   * The rung's nominal height (RENDITION_TIERS), which the start-order rule
   * ranks by. The RESOLUTION height below can be smaller: a 1920x800 film's
   * 480p rung is 854x356, and it must still be the rung that goes first.
   */
  tierHeight: number;
  bandwidth: number;
  /** The REAL output size (fitInsideBox), never the box — RESOLUTION=<width>x<height>. */
  width: number;
  height: number;
}

/**
 * The rung a native phone player starts on. ExoPlayer and AVPlayer begin
 * with the FIRST variant a master lists and only then adapt, so a master
 * that led with 1080p made every phone open on a 5 Mb/s rung and stall
 * before its first adaptation; 480p starts fast on a mobile link and
 * adapts up within seconds.
 */
export const PREFERRED_START_HEIGHT = 480;

/**
 * The variant order every master.m3u8 writer uses: the 480p rung first,
 * then the rest highest to lowest. Without a 480p rung the highest rung at
 * or below 480 leads; a ladder with nothing that low leads with its lowest
 * rung. Ranked by the rung's NOMINAL height (`tierHeight`), not the output
 * size, so a widescreen film's 854x356 "480p" still leads. Pure: the input
 * is neither mutated nor assumed to be in any order.
 */
export function orderVariantsForMaster<T extends { tierHeight: number }>(
  variants: readonly T[],
): T[] {
  if (variants.length === 0) return [];
  const highestFirst = [...variants].sort(
    (a, b) => b.tierHeight - a.tierHeight,
  );
  const start =
    highestFirst.find((v) => v.tierHeight <= PREFERRED_START_HEIGHT) ??
    highestFirst[highestFirst.length - 1];
  return [start, ...highestFirst.filter((v) => v !== start)];
}

/**
 * master.m3u8 text for the given variants, in the shared order above, with
 * RESOLUTION stating each rung's real output size. LF line endings and a
 * trailing newline — the shape rewriteMasterPlaylist() preserves.
 */
export function buildMasterPlaylist(
  variants: readonly MasterVariant[],
): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];

  for (const variant of orderVariantsForMaster(variants)) {
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${variant.bandwidth},RESOLUTION=${variant.width}x${variant.height}`,
      `${variant.name}/index.m3u8`,
    );
  }

  return lines.join('\n') + '\n';
}
