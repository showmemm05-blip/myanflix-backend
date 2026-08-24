import {
  initialPtsFromTransportStream,
  TS_PACKET_SIZE,
} from './mpegts-pts';

/** Video PES (0xE0) / audio PES (0xC0) — the two stream ids that matter here. */
const VIDEO_STREAM_ID = 0xe0;
const AUDIO_STREAM_ID = 0xc0;

/**
 * One 188-byte transport packet carrying the start of a PES packet with `pts`.
 * Written out by hand rather than checked in as a binary fixture so the bit
 * layout the parser relies on is visible next to the assertions.
 */
function tsPacketWithPts(options: {
  pid: number;
  streamId: number;
  pts: number;
  /** Emit the packet with no PTS/DTS flags — a continuation-style payload. */
  withoutPts?: boolean;
}): Buffer {
  const packet = Buffer.alloc(TS_PACKET_SIZE, 0xff);

  packet[0] = 0x47;
  packet[1] = 0x40 | ((options.pid >> 8) & 0x1f); // payload_unit_start_indicator
  packet[2] = options.pid & 0xff;
  packet[3] = 0x10; // payload only, continuity counter 0

  const p = 4;
  packet[p] = 0x00; // PES start code prefix
  packet[p + 1] = 0x00;
  packet[p + 2] = 0x01;
  packet[p + 3] = options.streamId;
  packet[p + 4] = 0x00; // PES packet length (unbounded)
  packet[p + 5] = 0x00;
  packet[p + 6] = 0x80; // '10' marker
  packet[p + 7] = options.withoutPts ? 0x00 : 0x80; // PTS present
  packet[p + 8] = options.withoutPts ? 0x00 : 0x05; // header data length

  if (!options.withoutPts) {
    // '0010' prefix, then PTS[32:30] / [29:22] / [21:15] / [14:7] / [6:0]
    // split across five bytes, each ending in a marker bit.
    const pts = options.pts;
    const at = p + 9;
    packet[at] = 0x21 | ((Math.floor(pts / 1_073_741_824) & 0x07) << 1);
    packet[at + 1] = Math.floor(pts / 4_194_304) & 0xff;
    packet[at + 2] = ((Math.floor(pts / 32_768) & 0x7f) << 1) | 0x01;
    packet[at + 3] = Math.floor(pts / 128) & 0xff;
    packet[at + 4] = ((pts & 0x7f) << 1) | 0x01;
  }

  return packet;
}

describe('initialPtsFromTransportStream', () => {
  it('reads the PTS out of a single PES packet', () => {
    const packet = tsPacketWithPts({
      pid: 256,
      streamId: VIDEO_STREAM_ID,
      pts: 132_000,
    });

    expect(initialPtsFromTransportStream(packet)).toBe(132_000);
  });

  it('takes the EARLIEST across streams — hls.js anchors to min(video, audio)', () => {
    const stream = Buffer.concat([
      tsPacketWithPts({ pid: 256, streamId: VIDEO_STREAM_ID, pts: 132_000 }),
      tsPacketWithPts({ pid: 257, streamId: AUDIO_STREAM_ID, pts: 129_910 }),
      tsPacketWithPts({ pid: 256, streamId: VIDEO_STREAM_ID, pts: 135_000 }),
    ]);

    // The real value measured off this deployment's ffmpeg-muxed renditions —
    // 1.443s, nowhere near the conventional 900000 (10s).
    expect(initialPtsFromTransportStream(stream)).toBe(129_910);
  });

  it('handles a 33-bit PTS past the 32-bit boundary', () => {
    // 2^32 + 1234: assembling this with `<<` instead of multiplication would
    // overflow into the sign bit and come back negative.
    const pts = 4_294_968_530;
    const packet = tsPacketWithPts({
      pid: 256,
      streamId: VIDEO_STREAM_ID,
      pts,
    });

    expect(initialPtsFromTransportStream(packet)).toBe(pts);
  });

  it('locks onto the packet grid when the read starts mid-packet', () => {
    const stream = Buffer.concat([
      Buffer.alloc(37, 0x47), // 0x47 is an ordinary payload byte too
      tsPacketWithPts({ pid: 256, streamId: VIDEO_STREAM_ID, pts: 90_000 }),
      tsPacketWithPts({ pid: 256, streamId: VIDEO_STREAM_ID, pts: 93_600 }),
    ]);

    expect(initialPtsFromTransportStream(stream)).toBe(90_000);
  });

  it('ignores packets that declare no PTS', () => {
    const stream = Buffer.concat([
      tsPacketWithPts({
        pid: 256,
        streamId: VIDEO_STREAM_ID,
        pts: 0,
        withoutPts: true,
      }),
      tsPacketWithPts({ pid: 257, streamId: AUDIO_STREAM_ID, pts: 129_910 }),
    ]);

    expect(initialPtsFromTransportStream(stream)).toBe(129_910);
  });

  it('returns null for bytes that are not MPEG-TS at all', () => {
    // An fMP4 segment lands here in the bundle flow; its timeline genuinely
    // starts at 0, which is what the caller falls back to.
    const fmp4 = Buffer.from('\0\0\0\x18ftypmp42\0\0\0\0mp42iso6', 'binary');

    expect(initialPtsFromTransportStream(fmp4)).toBeNull();
  });

  it('returns null for a transport stream carrying no timestamped PES', () => {
    const padding = Buffer.alloc(TS_PACKET_SIZE * 3, 0x00);
    for (let i = 0; i < 3; i++) {
      padding[i * TS_PACKET_SIZE] = 0x47;
      padding[i * TS_PACKET_SIZE + 1] = 0x1f; // null PID 0x1FFF
      padding[i * TS_PACKET_SIZE + 2] = 0xff;
      padding[i * TS_PACKET_SIZE + 3] = 0x10;
    }

    expect(initialPtsFromTransportStream(padding)).toBeNull();
  });
});
