/**
 * SubRip (.srt) -> WebVTT (.vtt), as pure text-in/text-out functions.
 *
 * Neither client can render SRT: a browser `<track>`/hls.js and iOS/Android
 * native HLS all speak WebVTT only, so an SRT file served as-is renders
 * absolutely nothing. The two formats are close enough that the conversion
 * is textual — a header, a decimal separator, and dropping the cue counters
 * — which is why this lives here as a dependency-free helper rather than
 * shelling out to ffmpeg for a few kilobytes of text.
 *
 * Deliberately no I/O and no Nest: everything here is deterministic and
 * unit-testable on its own (see srt-to-vtt.spec.ts). Storage lives in
 * HlsSubtitlesService.
 */

/**
 * Builds the `X-TIMESTAMP-MAP` header line, which anchors this file's
 * `00:00:00.000` to a point on the presentation's MPEG-TS clock.
 *
 * `mpegtsPts` MUST be the initial PTS of the media this rendition accompanies,
 * because every player that honours the tag shifts each cue by
 * `(MPEGTS - actual_initial_PTS) / 90000` seconds. It is therefore probed off
 * the first segment (see mpegts-pts.ts), never assumed.
 *
 * In particular it is NOT the widely-copied 900000 (10s). That is Apple's
 * mediafilesegmenter convention; ffmpeg's mpegts muxer — which produces every
 * rendition in this deployment — starts a VOD stream at its default mux delay
 * instead, around 1.4s (~129 900 ticks). Writing 900000 over ffmpeg output
 * pushes every cue ~8.6s late, and does it silently: the manifest stays valid
 * and the track still appears in the player's menu.
 *
 * Zero is the correct value for media whose timeline genuinely starts at 0
 * (fMP4), and is also what both hls.js and AVFoundation assume when the tag is
 * absent — so it is the safe fallback when the initial PTS cannot be read.
 */
export function hlsTimestampMap(mpegtsPts: number): string {
  const pts =
    Number.isFinite(mpegtsPts) && mpegtsPts > 0 ? Math.round(mpegtsPts) : 0;
  return `X-TIMESTAMP-MAP=MPEGTS:${pts},LOCAL:00:00:00.000`;
}

/** `00:00:01,234` / `0:00:01.234` — hours may be unpadded, ms 1-3 digits. */
const CUE_TIMESTAMP = /(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})/g;

/** A bare SRT cue counter: a line that is nothing but digits. */
const CUE_COUNTER = /^\d+$/;

const CUE_ARROW = '-->';

/**
 * Normalises the wire form of a subtitle file so everything downstream can
 * assume LF line endings and no byte-order mark. A BOM in particular is
 * fatal rather than cosmetic: a U+FEFF ahead of `WEBVTT` is not a valid WebVTT
 * signature, and players reject the whole file.
 */
export function normalizeSubtitleText(source: string): string {
  return source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

/** Whether this text is already WebVTT (so conversion must leave it alone). */
export function isWebVtt(source: string): boolean {
  return /^WEBVTT(\s|$)/.test(normalizeSubtitleText(source));
}

/**
 * Converts SRT to WebVTT. Idempotent by construction: text that already
 * carries the `WEBVTT` signature is returned normalised but otherwise
 * untouched, so running this over its own output (or over a .vtt an admin
 * uploaded directly) is a no-op.
 */
export function srtToVtt(source: string): string {
  const text = normalizeSubtitleText(source);
  if (isWebVtt(text)) return text;

  const cues = text
    .split(/\n{2,}/)
    .map((block) => convertBlock(block))
    .filter((block): block is string => block !== null);

  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}

/**
 * Inserts the HLS timestamp map for `mpegtsPts` directly after the `WEBVTT`
 * signature line, which is the only place a WebVTT header block is allowed to
 * carry it. Idempotent — a file that already has one is returned unchanged, so
 * the publisher can re-run over its own output, and a hand-authored .vtt that
 * already declares its own anchor keeps it.
 */
export function withHlsTimestampMap(vtt: string, mpegtsPts: number): string {
  const text = normalizeSubtitleText(vtt);
  if (text.includes('X-TIMESTAMP-MAP')) return text;

  const map = hlsTimestampMap(mpegtsPts);
  const lines = text.split('\n');
  // Guaranteed by srtToVtt(), but a hand-uploaded .vtt reaches here too.
  if (!/^WEBVTT/.test(lines[0] ?? '')) {
    return `WEBVTT\n${map}\n\n${text.replace(/^\n+/, '')}`;
  }

  lines.splice(1, 0, map);
  return lines.join('\n');
}

/**
 * One `\n\n`-separated SRT block -> one WebVTT cue, or null for a block
 * that carries no timing at all (a stray counter left by a truncated file,
 * trailing whitespace). Those are dropped rather than passed through: an
 * orphan line in a WebVTT body is a parse error, and one bad block makes
 * players discard everything after it.
 */
function convertBlock(block: string): string | null {
  const lines = block.split('\n').filter((line) => line.trim() !== '');
  if (lines.length === 0) return null;

  // The counter is only a counter when a timing line follows it — a cue
  // whose visible text happens to be "42" must survive.
  if (
    CUE_COUNTER.test(lines[0].trim()) &&
    lines.length > 1 &&
    lines[1].includes(CUE_ARROW)
  ) {
    lines.shift();
  }

  const timingIndex = lines.findIndex((line) => line.includes(CUE_ARROW));
  if (timingIndex === -1) return null;

  lines[timingIndex] = convertTimestamps(lines[timingIndex]);
  return lines.join('\n');
}

/**
 * `00:00:01,234 --> 00:00:03,456` -> `00:00:01.234 --> 00:00:03.456`.
 * Hours are padded to two digits and milliseconds to three, because WebVTT
 * requires both widths exactly while SRT writers in the wild do not.
 * Anything after the second timestamp (cue settings such as `line:90%`) is
 * left alone.
 */
function convertTimestamps(line: string): string {
  return line.replace(
    CUE_TIMESTAMP,
    (_match, hours: string, minutes: string, seconds: string, ms: string) =>
      `${hours.padStart(2, '0')}:${minutes}:${seconds}.${ms.padEnd(3, '0')}`,
  );
}
