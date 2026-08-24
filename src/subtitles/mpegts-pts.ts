/**
 * Reads the initial presentation timestamp out of an MPEG-TS segment.
 *
 * Why this exists: a WebVTT rendition inside an HLS master carries an
 * `X-TIMESTAMP-MAP` that anchors the file's `00:00:00.000` to a point on the
 * media's MPEG-TS clock. Every player that honours the tag (hls.js, iOS
 * AVFoundation, ExoPlayer) shifts every cue by
 * `(MPEGTS - actual_initial_PTS) / 90000` seconds, so the ONLY value that
 * leaves the cues where the subtitle author put them is the presentation's
 * real initial PTS.
 *
 * That value is a property of the muxer, not a constant. The widely-copied
 * `MPEGTS:900000` (10s) comes from Apple's mediafilesegmenter; ffmpeg's
 * mpegts muxer instead applies its default mux delay and starts a VOD
 * rendition at roughly 1.4s (~129 900). Hardcoding either one mis-syncs the
 * other — and the failure is silent, because the manifest stays structurally
 * valid and the track still appears in the menu. Hence: probe, don't assume.
 *
 * Deliberately a dependency-free parser over the first megabyte rather than a
 * shell-out to ffprobe: the backend already has the bytes a range-request
 * away, the answer is in the first few PES packets, and this stays pure and
 * unit-testable.
 */

/** Fixed MPEG-TS packet length. */
export const TS_PACKET_SIZE = 188;

/**
 * How much of a segment to pull when probing. The first audio and video PES
 * packets sit within the first few kilobytes; a megabyte is generous slack
 * for a large I-frame ahead of the first audio packet while still being a
 * fraction of a full segment.
 */
export const PTS_PROBE_BYTES = 1_048_576;

const SYNC_BYTE = 0x47;
const NULL_PID = 0x1fff;

/** Elementary-stream ids that carry a PTS: 0xC0-0xDF audio, 0xE0-0xEF video. */
const FIRST_ELEMENTARY_STREAM_ID = 0xc0;
const LAST_ELEMENTARY_STREAM_ID = 0xef;

/**
 * The earliest PTS (90 kHz ticks) any elementary stream in `data` presents at,
 * or null when the buffer is not MPEG-TS or carries no timestamped PES packet.
 *
 * The minimum across streams — not just the video's — is deliberate: it is the
 * same quantity hls.js anchors to (`mp4-remuxer` sets its `initPTS` to
 * `min(videoInitPTS, audioInitPTS)`), and with ffmpeg's muxer the audio track
 * is typically a couple of frames ahead of the video.
 *
 * Returning null rather than guessing is meaningful: fMP4 segments land here
 * too, and their timeline genuinely starts at 0, which is what the caller
 * falls back to.
 */
export function initialPtsFromTransportStream(
  data: Uint8Array,
): number | null {
  const start = findSyncOffset(data);
  if (start === null) return null;

  let earliest: number | null = null;

  for (
    let offset = start;
    offset + TS_PACKET_SIZE <= data.length;
    offset += TS_PACKET_SIZE
  ) {
    // Lost packet lock — a truncated or corrupt read. Whatever was found
    // before this point is still valid; anything after it is not trustworthy.
    if (data[offset] !== SYNC_BYTE) break;

    const pid = ((data[offset + 1] & 0x1f) << 8) | data[offset + 2];
    if (pid === NULL_PID) continue;

    // A PES header only ever appears at the start of a payload unit.
    const payloadUnitStart = (data[offset + 1] & 0x40) !== 0;
    if (!payloadUnitStart) continue;

    const adaptationFieldControl = (data[offset + 3] >> 4) & 0x03;
    if ((adaptationFieldControl & 0x01) === 0) continue; // adaptation field only

    let payload = offset + 4;
    if ((adaptationFieldControl & 0x02) !== 0) payload += data[payload] + 1;

    // The PTS occupies bytes 9..13 of the PES header; a payload that cannot
    // hold them is a continuation or a malformed packet either way.
    if (payload + 14 > offset + TS_PACKET_SIZE) continue;

    const pts = readPesPts(data, payload);
    if (pts === null) continue;
    if (earliest === null || pts < earliest) earliest = pts;
  }

  return earliest;
}

/**
 * Locks onto the packet grid. A range-read can begin mid-packet, and a lone
 * 0x47 is a perfectly ordinary payload byte — so a candidate only counts when
 * the byte exactly one packet later is a sync byte too (or the buffer ends
 * first).
 */
function findSyncOffset(data: Uint8Array): number | null {
  const limit = Math.min(data.length, TS_PACKET_SIZE * 2);
  for (let offset = 0; offset < limit; offset++) {
    if (data[offset] !== SYNC_BYTE) continue;
    if (
      offset + TS_PACKET_SIZE >= data.length ||
      data[offset + TS_PACKET_SIZE] === SYNC_BYTE
    ) {
      return offset;
    }
  }
  return null;
}

/**
 * The PTS of the PES packet starting at `at`, or null when there is no PES
 * header there / it is not a timestamped elementary stream.
 */
function readPesPts(data: Uint8Array, at: number): number | null {
  // PES start code prefix.
  if (data[at] !== 0x00 || data[at + 1] !== 0x00 || data[at + 2] !== 0x01) {
    return null;
  }

  const streamId = data[at + 3];
  if (
    streamId < FIRST_ELEMENTARY_STREAM_ID ||
    streamId > LAST_ELEMENTARY_STREAM_ID
  ) {
    return null;
  }

  // 0b10 = PTS only, 0b11 = PTS followed by DTS. 0b00 = neither.
  const ptsDtsFlags = (data[at + 7] & 0xc0) >> 6;
  if (ptsDtsFlags < 2) return null;

  const p = at + 9;
  // A PTS is 33 bits, split across five bytes by marker bits. Assembled with
  // multiplication rather than `<<`: JavaScript's bitwise operators coerce to
  // 32 bits, so shifting the top bits left by 30 would overflow into the sign.
  return (
    (data[p] & 0x0e) * 536_870_912 + // PTS[32:30] << 30
    data[p + 1] * 4_194_304 + // PTS[29:22] << 22
    (data[p + 2] & 0xfe) * 16_384 + // PTS[21:15] << 15
    data[p + 3] * 128 + // PTS[14:7]  << 7
    ((data[p + 4] & 0xfe) >> 1) // PTS[6:0]
  );
}
