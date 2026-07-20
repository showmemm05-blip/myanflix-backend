export interface RenditionTier {
  name: string;
  height: number;
  videoBitrate: string;
  bandwidth: number; // approximate bits/sec for the master playlist, video+audio
}

export const RENDITION_TIERS: RenditionTier[] = [
  { name: '1080p', height: 1080, videoBitrate: '5000k', bandwidth: 5_128_000 },
  { name: '720p', height: 720, videoBitrate: '2800k', bandwidth: 2_928_000 },
  { name: '480p', height: 480, videoBitrate: '1400k', bandwidth: 1_528_000 },
  { name: '360p', height: 360, videoBitrate: '800k', bandwidth: 928_000 },
  { name: '240p', height: 240, videoBitrate: '400k', bandwidth: 528_000 },
];

/** Never upscale past the source resolution; always produce at least one rendition. */
export function pickRenditions(sourceHeight: number): RenditionTier[] {
  const eligible = RENDITION_TIERS.filter((tier) => tier.height <= sourceHeight);
  return eligible.length > 0 ? eligible : [RENDITION_TIERS[RENDITION_TIERS.length - 1]];
}

/** Approximates an aspect-correct width for the master playlist's RESOLUTION attribute. */
export function approximateWidth(sourceWidth: number, sourceHeight: number, targetHeight: number): number {
  if (!sourceWidth || !sourceHeight) return Math.round((targetHeight * 16) / 9 / 2) * 2;
  return Math.round(((sourceWidth * targetHeight) / sourceHeight / 2)) * 2;
}
