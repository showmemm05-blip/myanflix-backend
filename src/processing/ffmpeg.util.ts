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

export function transcodeToHls(options: {
  inputPath: string;
  outputDir: string;
  segmentPattern: string;
  playlistPath: string;
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

    const command = ffmpeg(options.inputPath)
      .renice(FFMPEG_NICENESS)
      .videoCodec('libx264')
      .audioCodec('aac')
      .audioBitrate('128k')
      .outputOptions([
        `-vf scale=-2:${options.targetHeight}`,
        `-b:v ${options.videoBitrate}`,
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
