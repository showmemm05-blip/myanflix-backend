export interface RenditionTier {
  name: string;
  /**
   * The 16:9 BOX this rung is scaled to fit INSIDE (aspect kept, see
   * fitInsideBox) — not a forced output size. A 16:9 source fills it
   * exactly; a 1920x800 widescreen film's 1080p rung comes out 1920x800.
   */
  width: number;
  height: number;
  videoBitrate: string;
  bandwidth: number; // approximate bits/sec for the master playlist, video+audio
}

// The desktop Transcoder (transcoder/electron/ffmpeg/tiers.ts) mirrors this
// ladder, the eligibility rule and the fit-inside maths exactly.
export const RENDITION_TIERS: RenditionTier[] = [
  {
    name: '1080p',
    width: 1920,
    height: 1080,
    videoBitrate: '5000k',
    bandwidth: 5_128_000,
  },
  {
    name: '720p',
    width: 1280,
    height: 720,
    videoBitrate: '2800k',
    bandwidth: 2_928_000,
  },
  {
    name: '480p',
    width: 854,
    height: 480,
    videoBitrate: '1400k',
    bandwidth: 1_528_000,
  },
  {
    name: '360p',
    width: 640,
    height: 360,
    videoBitrate: '800k',
    bandwidth: 928_000,
  },
  {
    name: '240p',
    width: 426,
    height: 240,
    videoBitrate: '400k',
    bandwidth: 528_000,
  },
];

/**
 * How much of a tier's box WIDTH the source's longer side must reach to earn
 * that rung. Widescreen films arrive with the letterbox already cropped and
 * the crop is rarely exact — 1904x800 is a common encode of a 1920x800
 * picture — so an exact 1920 would deny them 1080p for 16 missing pixels.
 */
export const WIDE_ELIGIBILITY_RATIO = 0.98;

/**
 * A rung is earned by EITHER side of the source: its longer side reaching
 * (98% of) the box width — a 1920x800 widescreen film gets 1080p where
 * "height >= 1080" topped it out at 720p — or its shorter side reaching the
 * tier height, which is exactly the old rule, kept so 4:3 (1440x1080) and
 * vertical (1080x1920) sources earn what they always did.
 */
export function isTierEligible(
  tier: RenditionTier,
  sourceWidth: number,
  sourceHeight: number,
): boolean {
  const longer = Math.max(sourceWidth, sourceHeight);
  const shorter = Math.min(sourceWidth, sourceHeight);
  return (
    longer >= tier.width * WIDE_ELIGIBILITY_RATIO || shorter >= tier.height
  );
}

/** Never upscale past the source resolution; always produce at least one rendition. */
export function pickRenditions(
  sourceWidth: number,
  sourceHeight: number,
): RenditionTier[] {
  const eligible = RENDITION_TIERS.filter((tier) =>
    isTierEligible(tier, sourceWidth, sourceHeight),
  );
  return eligible.length > 0
    ? eligible
    : [RENDITION_TIERS[RENDITION_TIERS.length - 1]];
}

export interface OutputSize {
  width: number;
  height: number;
}

/**
 * The exact size ffmpeg's
 * `scale=w=<boxW>:h=<boxH>:force_original_aspect_ratio=decrease:force_divisible_by=2`
 * (see scaleFilter in ffmpeg.util.ts) produces for a source — the master
 * playlist's RESOLUTION attribute must state the real output, so this
 * repeats libavfilter's own arithmetic (ff_scale_adjust_dimensions) rather
 * than approximating it: each side is rescaled to the other's box edge,
 * rounded to the nearest even number, and clamped to the box.
 *
 * A 16:9 source fills every box exactly, so 1280x720 still yields
 * 1280x720 / 854x480 / 640x360 / 426x240 — unchanged from `scale=-2:<h>`.
 * A source whose size is unknown (0) is reported as the box itself.
 */
export function fitInsideBox(
  tier: Pick<RenditionTier, 'width' | 'height'>,
  sourceWidth: number,
  sourceHeight: number,
): OutputSize {
  if (!sourceWidth || !sourceHeight) {
    return { width: tier.width, height: tier.height };
  }
  return {
    width: Math.min(
      rescaleToEven(tier.height, sourceWidth, sourceHeight),
      tier.width,
    ),
    height: Math.min(
      rescaleToEven(tier.width, sourceHeight, sourceWidth),
      tier.height,
    ),
  };
}

/**
 * libavfilter's `av_rescale(a, b, c * 2) * 2`: a * b / (c * 2) rounded to
 * the nearest integer, halves away from zero, then doubled — so 202.5
 * becomes 203 -> 406, as ffmpeg itself rounds a 1080x1920 source's 720p
 * width. Integer arithmetic throughout, like the original.
 */
function rescaleToEven(a: number, b: number, c: number): number {
  const divisor = c * 2;
  return Math.floor((a * b + Math.floor(divisor / 2)) / divisor) * 2;
}
