/**
 * The closed set of badge glyphs the frontends can draw. A level stores one
 * of these KEYS — never a URL or an upload — and both frontends map the key
 * to the same inline-SVG badge geometry, so a level's look is fully
 * described by (icon, color) and survives any asset-pipeline change.
 */
export const LEVEL_BADGE_ICONS = [
  'shield',
  'shield-chevron',
  'shield-facet',
  'crest-crown',
  'wings-crystal',
  'radiant-crystal',
] as const;

export type LevelBadgeIcon = (typeof LEVEL_BADGE_ICONS)[number];
