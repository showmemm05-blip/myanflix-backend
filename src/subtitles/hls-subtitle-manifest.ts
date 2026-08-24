/**
 * Pure HLS playlist text manipulation for subtitle renditions — no I/O, no
 * Nest, no storage. HlsSubtitlesService owns the MinIO side; everything
 * here is deterministic string work so the tricky part (idempotence) can be
 * tested exhaustively without a bucket.
 */

/** The one `GROUP-ID` every subtitle rendition of a title belongs to. */
export const SUBTITLE_GROUP_ID = 'subs';

/** Directory (relative to master.m3u8) holding the published renditions. */
export const SUBTITLE_DIRECTORY = 'subs';

/**
 * EXTINF/TARGETDURATION used when a video's duration is unknown and cannot
 * be recovered from its variant playlist — the externally pre-transcoded
 * bundle flow records `duration: null`, so this is a real path, not a
 * theoretical one.
 *
 * Deliberately far too long rather than a guess: a single-segment WebVTT
 * rendition whose EXTINF OVERSHOOTS the media is harmless (players simply
 * never seek past the end of the video), while one that undershoots makes
 * every cue after that point unreachable, because the player never loads a
 * fragment whose time range the playhead does not enter.
 */
export const FALLBACK_DURATION_SECONDS = 86_400;

export interface SubtitleRendition {
  /** Subtitle row id — also the rendition's filename stem. */
  id: string;
  /** Human label, becomes NAME= (shown in the player's menu). */
  label: string;
  /** BCP-47-ish code, becomes LANGUAGE=. */
  language: string;
  isDefault: boolean;
}

const STREAM_INF = /^#EXT-X-STREAM-INF:/;
const SUBTITLE_MEDIA = /^#EXT-X-MEDIA:.*TYPE=SUBTITLES/;
const SUBTITLES_ATTRIBUTE = /SUBTITLES="[^"]*"/g;
const EXTINF = /^#EXTINF:\s*([\d.]+)/;

/**
 * Rewrites a master playlist so it declares exactly `renditions` and
 * nothing else.
 *
 * Written as "strip every trace of a subtitle group, then re-emit from the
 * current state", never "append if missing". That is what makes it
 * IDEMPOTENT: running it twice with the same input produces byte-identical
 * output, and running it with an empty list restores the master to exactly
 * what ffmpeg (or the uploaded bundle) produced.
 *
 * A master that has no subtitle artifacts and is being given no renditions
 * is returned as the very same string — not re-serialised — so the no-op
 * case cannot perturb line endings, spacing, or a missing trailing newline.
 * When it IS re-serialised, the master's own line separator is preserved, so
 * "restores the original exactly" holds for a CRLF file too.
 */
export function rewriteMasterPlaylist(
  master: string,
  renditions: SubtitleRendition[],
): string {
  if (renditions.length === 0 && !hasSubtitleArtifacts(master)) return master;

  // Parsing is done on LF, but the file is re-emitted with the separator it
  // arrived with — otherwise a CRLF master (only the externally-authored
  // bundles; ffmpeg's own writer uses LF) is silently converted on its first
  // publish, and deleting the last subtitle can no longer restore it exactly.
  const eol = master.includes('\r\n') ? '\r\n' : '\n';
  const endsWithNewline = master.endsWith('\n');
  const lines = master.replace(/\r\n?/g, '\n').split('\n');
  if (endsWithNewline) lines.pop();

  const stripped = lines
    .filter((line) => !SUBTITLE_MEDIA.test(line))
    .map((line) =>
      STREAM_INF.test(line) ? stripSubtitlesAttribute(line) : line,
    );

  if (renditions.length === 0) {
    return serialize(stripped, endsWithNewline, eol);
  }

  // At most one DEFAULT=YES, whatever the rows say — two defaults in one
  // group is invalid HLS and players pick arbitrarily.
  const defaultIndex = renditions.findIndex((r) => r.isDefault);

  const withGroup = stripped.map((line) =>
    STREAM_INF.test(line) ? `${line},SUBTITLES="${SUBTITLE_GROUP_ID}"` : line,
  );

  // The group must be declared before the variants that reference it.
  const firstVariant = withGroup.findIndex((line) => STREAM_INF.test(line));
  const insertAt = firstVariant === -1 ? withGroup.length : firstVariant;

  const names = uniqueNames(renditions);
  const mediaLines = renditions.map((rendition, index) =>
    buildMediaLine(rendition, names[index], index === defaultIndex),
  );

  return serialize(
    [
      ...withGroup.slice(0, insertAt),
      ...mediaLines,
      ...withGroup.slice(insertAt),
    ],
    endsWithNewline,
    eol,
  );
}

/**
 * The single-segment media playlist that wraps one WebVTT file. HLS has no
 * notion of a bare side-car subtitle file — a SUBTITLES rendition's URI must
 * point at a playlist, and the .vtt is that playlist's only "segment".
 */
export function buildSubtitleMediaPlaylist(
  subtitleId: string,
  durationSeconds: number,
): string {
  const duration =
    Number.isFinite(durationSeconds) && durationSeconds > 0
      ? durationSeconds
      : FALLBACK_DURATION_SECONDS;

  return (
    [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${Math.ceil(duration)}`,
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-PLAYLIST-TYPE:VOD',
      `#EXTINF:${duration.toFixed(3)},`,
      `${subtitleId}.vtt`,
      '#EXT-X-ENDLIST',
    ].join('\n') + '\n'
  );
}

/** URI of the first variant a master lists, or null — used to recover an unknown duration. */
export function firstVariantUri(master: string): string | null {
  const lines = master.replace(/\r\n?/g, '\n').split('\n');
  const streamInf = lines.findIndex((line) => STREAM_INF.test(line));
  if (streamInf === -1) return null;

  for (const line of lines.slice(streamInf + 1)) {
    const uri = line.trim();
    if (uri !== '' && !uri.startsWith('#')) return uri;
  }
  return null;
}

/**
 * URI of the first media segment a variant playlist lists, or null. Used to
 * probe the presentation's real initial PTS, which is what the WebVTT
 * `X-TIMESTAMP-MAP` has to be anchored to.
 */
export function firstSegmentUri(playlist: string): string | null {
  for (const line of playlist.replace(/\r\n?/g, '\n').split('\n')) {
    const uri = line.trim();
    if (uri !== '' && !uri.startsWith('#')) return uri;
  }
  return null;
}

/** Sum of a media playlist's EXTINF values, or null if it declares none. */
export function totalDurationFromMediaPlaylist(
  playlist: string,
): number | null {
  let total = 0;
  let seen = false;

  for (const line of playlist.replace(/\r\n?/g, '\n').split('\n')) {
    const match = EXTINF.exec(line.trim());
    if (!match) continue;
    const value = Number.parseFloat(match[1]);
    if (!Number.isFinite(value)) continue;
    total += value;
    seen = true;
  }

  return seen ? total : null;
}

/** Whether this master mentions subtitles at all — the no-op fast path's guard. */
function hasSubtitleArtifacts(master: string): boolean {
  return master
    .split(/\r\n?|\n/)
    .some(
      (line) =>
        SUBTITLE_MEDIA.test(line) ||
        (STREAM_INF.test(line) && line.includes('SUBTITLES=')),
    );
}

/**
 * RFC 8216 §4.3.4.1 requires every EXT-X-MEDIA tag in one group to carry a
 * DIFFERENT NAME, and nothing stops an admin from labelling two tracks of the
 * same title "English" — the API bounds the label's length, not its
 * uniqueness. Duplicates make the master invalid and give the viewer two menu
 * rows they cannot tell apart, so collisions are suffixed in the renditions'
 * (stable, hence idempotent) order: `English`, `English (2)`, `English (3)`.
 *
 * A label that sanitises away to nothing falls back to the language and then
 * the id, since a blank NAME is unpickable for the same reason.
 */
function uniqueNames(renditions: SubtitleRendition[]): string[] {
  const taken = new Set<string>();

  return renditions.map((rendition) => {
    const base =
      quotedValue(rendition.label) ||
      quotedValue(rendition.language) ||
      rendition.id;

    let name = base;
    for (let suffix = 2; taken.has(name.toLowerCase()); suffix++) {
      name = `${base} (${suffix})`;
    }
    taken.add(name.toLowerCase());
    return name;
  });
}

function buildMediaLine(
  rendition: SubtitleRendition,
  name: string,
  isDefault: boolean,
): string {
  return [
    '#EXT-X-MEDIA:TYPE=SUBTITLES',
    `GROUP-ID="${SUBTITLE_GROUP_ID}"`,
    `NAME="${name}"`,
    `LANGUAGE="${quotedValue(rendition.language)}"`,
    `DEFAULT=${isDefault ? 'YES' : 'NO'}`,
    'AUTOSELECT=YES',
    'FORCED=NO',
    `URI="${SUBTITLE_DIRECTORY}/${rendition.id}.m3u8"`,
  ].join(',');
}

/**
 * An HLS quoted-string may not contain a double quote or a line break —
 * an admin-typed label can contain both, and one stray quote would break
 * the parse of the whole attribute list.
 */
function quotedValue(value: string): string {
  return value.replace(/["\r\n]/g, '').trim();
}

/**
 * Removes any SUBTITLES attribute (ours or a foreign group's) from one
 * `#EXT-X-STREAM-INF:` line without disturbing the rest of its attribute
 * list — the exact inverse of appending it, which is what buys idempotence.
 */
function stripSubtitlesAttribute(line: string): string {
  return line
    .replace(/,\s*SUBTITLES="[^"]*"/g, '')
    .replace(/(?<=:)\s*SUBTITLES="[^"]*",\s*/g, '')
    .replace(SUBTITLES_ATTRIBUTE, '')
    .replace(/,\s*$/, '');
}

function serialize(
  lines: string[],
  endsWithNewline: boolean,
  eol: string,
): string {
  return lines.join(eol) + (endsWithNewline ? eol : '');
}
