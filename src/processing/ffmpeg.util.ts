import ffmpeg from 'fluent-ffmpeg';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ProbeResult {
  durationSeconds: number;
  width: number;
  height: number;
}

// Transcoding shares the Flokinet VPS with the API, admin, website, and
// Postgres — these keep it from starving everything else:
//   - FFMPEG_NICENESS: OS scheduling priority (-20 highest, 20 lowest). Near
//     the lowest means the API wins CPU time whenever both actually want it
//     at the same moment; costs ~nothing when the CPU isn't contended.
//   - FFMPEG_MAX_THREADS: hard ceiling on cores a single transcode can use,
//     so it can't claim all of them even briefly — always leaves headroom
//     for everything else, at the cost of some transcode speed.
const FFMPEG_NICENESS = 19;
const FFMPEG_MAX_THREADS = 6;

// The ONE encode profile both engines share — the desktop Transcoder's half
// is transcoder/electron/ffmpeg/{hwaccel,transcode}.ts, and the specs on
// each side pin it. Every target device decodes exactly one H.264 flavour
// in hardware: 8-bit 4:2:0, High profile, level 4.1.

/**
 * libx264 inherits the SOURCE pixel format, so a 10-bit or 4:2:2 rip (common
 * in HEVC web-DLs and anime) came out as "High 10" H.264 that phones
 * (ExoPlayer/MediaCodec, AVPlayer) and Safari refuse while desktop Chrome
 * plays it in software — easy to miss on a PC (STR-001). `-pix_fmt` must
 * come with the profile: x264 refuses "high profile doesn't support a bit
 * depth of 10" without it. A no-op for the usual 8-bit 4:2:0 source.
 */
export const H264_OUTPUT_FORMAT_ARGS = [
  '-pix_fmt yuv420p',
  '-profile:v high',
  '-level 4.1',
];

/**
 * Exactly one video and (when the source has one) one audio stream, no
 * subtitle or data streams. Under automatic selection the HLS muxer also
 * mapped the first text subtitle track, leaving a stray index0.vtt +
 * index_vtt.m3u8 in every tier that no playlist references (STR-008).
 */
export const STREAM_SELECTION_ARGS = [
  '-map 0:v:0',
  '-map 0:a:0?',
  '-sn',
  '-dn',
];

/**
 * VBV cap on top of `-b:v`, which alone only holds the AVERAGE: a hard
 * scene came out at 3× the BANDWIDTH the master playlist promises, so a
 * viewer whose link sits just above a tier was offered it and then stalled
 * in every action scene (STR-027). 1.3× / 2× the tier bitrate keeps the
 * peak near the declared figure at a slight quality cost in the very
 * hardest scenes. libx264 and the Transcoder's GPU encoders all honour the
 * pair; the Transcoder uses the same ratios.
 */
export const MAXRATE_FACTOR = 1.3;
export const BUFSIZE_FACTOR = 2;

/** `-maxrate`/`-bufsize` for a tier bitrate as RENDITION_TIERS spells it: '2800k' -> '3640k' and '5600k'. */
export function rateCapArgs(videoBitrate: string): string[] {
  const match = /^(\d+)k$/.exec(videoBitrate);
  if (!match) {
    throw new Error(
      `Unsupported video bitrate "${videoBitrate}" — expected a whole number of kbps such as "2800k"`,
    );
  }
  const kbps = Number(match[1]);
  return [
    `-maxrate ${Math.round(kbps * MAXRATE_FACTOR)}k`,
    `-bufsize ${Math.round(kbps * BUFSIZE_FACTOR)}k`,
  ];
}

/** How long ffprobe may take to read a container's headers before it is killed (M-24). */
export const FFPROBE_TIMEOUT_MS = 60_000;

/** ffprobe's JSON for a long multi-stream file is tens of KB; this is a backstop. */
const FFPROBE_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/**
 * How long ONE rendition may transcode before ffmpeg is killed and the
 * pipeline fails the video (M-24). A feature film at `veryfast` on 6
 * threads is well under an hour per tier on this VPS; six hours is far
 * past any real run and still a bound, where there was none. Per rendition,
 * not per video, so a long title with five tiers is not penalised.
 * FFMPEG_RENDITION_TIMEOUT_MINUTES overrides it.
 */
export const DEFAULT_FFMPEG_RENDITION_TIMEOUT_MINUTES = 360;

export function ffmpegRenditionTimeoutMs(): number {
  const raw = Number(process.env.FFMPEG_RENDITION_TIMEOUT_MINUTES);
  const minutes =
    Number.isFinite(raw) && raw > 0
      ? raw
      : DEFAULT_FFMPEG_RENDITION_TIMEOUT_MINUTES;
  return minutes * 60 * 1000;
}

/** The JSON shape `ffprobe -print_format json` emits for what probeVideo needs. */
interface FfprobeJson {
  streams?: Array<{
    codec_type?: string;
    width?: number;
    height?: number;
  }>;
  format?: { duration?: string | number };
}

/** A remux of a short clip copies streams only; a minute is already generous. */
export const FFMPEG_REMUX_TIMEOUT_MS = 120_000;

/**
 * Rewrites an MP4 with its index (the `moov` atom) at the FRONT, streams
 * copied untouched. A phone player can only start a progressive MP4 once
 * it has the index, and an encoder that writes it at the end makes a
 * pre-roll ad download whole before its first frame — the stall the player
 * treats as "failed". Shelled out directly like probeVideo, with a hard
 * timeout and SIGKILL.
 */
export async function remuxFastStart(
  inputPath: string,
  outputPath: string,
): Promise<void> {
  await execFileAsync(
    'ffmpeg',
    [
      '-y',
      '-v',
      'error',
      '-i',
      inputPath,
      '-c',
      'copy',
      '-movflags',
      '+faststart',
      outputPath,
    ],
    { timeout: FFMPEG_REMUX_TIMEOUT_MS, killSignal: 'SIGKILL' },
  );
}

/**
 * Container duration and the first video stream's dimensions. Shells out
 * to ffprobe directly (the same binary fluent-ffmpeg would resolve from
 * PATH) so the call can carry a hard timeout and SIGKILL: fluent-ffmpeg's
 * ffprobe wrapper exposes neither, and a crafted file that makes the probe
 * hang used to hang the whole pipeline with it (M-24).
 */
export async function probeVideo(inputPath: string): Promise<ProbeResult> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      'ffprobe',
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        inputPath,
      ],
      {
        timeout: FFPROBE_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: FFPROBE_MAX_OUTPUT_BYTES,
      },
    ));
  } catch (error) {
    const e = error as { killed?: boolean; signal?: string | null };
    if (e?.killed === true && e?.signal === 'SIGKILL') {
      throw new Error(
        `ffprobe did not finish within ${FFPROBE_TIMEOUT_MS / 1000} s and was stopped`,
      );
    }
    throw error instanceof Error ? error : new Error(String(error));
  }

  let data: FfprobeJson;
  try {
    data = JSON.parse(stdout) as FfprobeJson;
  } catch {
    throw new Error('ffprobe returned unreadable output');
  }
  const videoStream = (data.streams ?? []).find(
    (s) => s.codec_type === 'video',
  );
  if (!videoStream) throw new Error('No video stream found in uploaded file');

  const duration = Number(data.format?.duration ?? 0);
  return {
    durationSeconds: Math.round(Number.isFinite(duration) ? duration : 0),
    width: videoStream.width ?? 0,
    height: videoStream.height ?? 0,
  };
}

/**
 * The scale filter for one rung: the picture is scaled to fit INSIDE the
 * tier's 16:9 box (RENDITION_TIERS width x height), aspect kept, both sides
 * even. A 16:9 source fills the box — identical to the old `scale=-2:<h>`
 * — while a 1920x800 widescreen film's 1080p rung comes out 1920x800 and
 * its 720p rung 1280x534 instead of being denied 1080p altogether.
 * fitInsideBox() in rendition-tiers.ts predicts the size this produces for
 * the master playlist's RESOLUTION. One word, so fluent-ffmpeg passes it as
 * "-vf <filter>" (see the outputOptions note below).
 */
export function scaleFilter(targetWidth: number, targetHeight: number): string {
  return `scale=w=${targetWidth}:h=${targetHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2`;
}

export function transcodeToHls(options: {
  inputPath: string;
  outputDir: string;
  segmentPattern: string;
  playlistPath: string;
  /** The tier's box (RENDITION_TIERS width/height), not the output size. */
  targetWidth: number;
  targetHeight: number;
  videoBitrate: string;
}): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timeoutMs = ffmpegRenditionTimeoutMs();
    let timedOut = false;
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      if (error) rejectPromise(error);
      else resolvePromise();
    };

    // Every outputOptions entry is "-flag value" or a bare flag: fluent-ffmpeg
    // only splits a string of exactly two words, so a three-word option
    // would reach ffmpeg as one argument.
    const command = ffmpeg(options.inputPath)
      .renice(FFMPEG_NICENESS)
      .videoCodec('libx264')
      .audioCodec('aac')
      .audioBitrate('128k')
      // Stereo: 128 kb/s spread over a 5.1 source's six channels sounds
      // worse than two, and some phone browsers downmix badly (STR-013).
      .audioChannels(2)
      .outputOptions([
        ...STREAM_SELECTION_ARGS,
        `-vf ${scaleFilter(options.targetWidth, options.targetHeight)}`,
        ...H264_OUTPUT_FORMAT_ARGS,
        `-b:v ${options.videoBitrate}`,
        ...rateCapArgs(options.videoBitrate),
        '-preset veryfast',
        `-threads ${FFMPEG_MAX_THREADS}`,
        '-sc_threshold 0',
        '-g 48',
        '-hls_time 6',
        '-hls_playlist_type vod',
        `-hls_segment_filename ${options.segmentPattern}`,
      ])
      .output(options.playlistPath)
      .on('error', (err: Error) =>
        settle(
          timedOut
            ? new Error(
                `ffmpeg did not finish the ${options.targetHeight}p rendition within ${timeoutMs / 60_000} minutes and was stopped`,
              )
            : err,
        ),
      )
      .on('end', () => settle());

    // The watchdog (M-24): a transcode that is still running when the
    // budget is up is killed outright, which surfaces through the 'error'
    // handler above as a readable failure instead of a pipeline that never
    // returns and a video stuck at PROCESSING.
    const watchdog = setTimeout(() => {
      timedOut = true;
      command.kill('SIGKILL');
    }, timeoutMs);
    // A pending budget must never be what keeps the process alive.
    watchdog.unref();

    command.run();
  });
}
