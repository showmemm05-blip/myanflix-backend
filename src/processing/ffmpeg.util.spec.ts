import ffmpeg from 'fluent-ffmpeg';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  BUFSIZE_FACTOR,
  DEFAULT_FFMPEG_RENDITION_TIMEOUT_MINUTES,
  FFPROBE_TIMEOUT_MS,
  H264_OUTPUT_FORMAT_ARGS,
  MAXRATE_FACTOR,
  STREAM_SELECTION_ARGS,
  ffmpegRenditionTimeoutMs,
  probeVideo,
  rateCapArgs,
  scaleFilter,
  transcodeToHls,
} from './ffmpeg.util';
import { RENDITION_TIERS } from './rendition-tiers';

// See pdf.util.spec.ts for why the mock carries promisify's custom hook.
jest.mock('node:child_process', () => {
  const { promisify: p } =
    jest.requireActual<typeof import('node:util')>('node:util');
  const execFileAsync = jest.fn();
  const execFileMock = Object.assign(jest.fn(), {
    [p.custom]: execFileAsync,
  });
  return { execFile: execFileMock };
});

/** A chainable stand-in for a fluent-ffmpeg command that never spawns anything. */
type FakeCommand = {
  handlers: Record<string, (...args: unknown[]) => void>;
  kill: jest.Mock;
  run: jest.Mock;
  on: jest.Mock;
  [chain: string]: unknown;
};
let command: FakeCommand;
jest.mock('fluent-ffmpeg', () => ({
  __esModule: true,
  default: jest.fn(() => command),
}));

const execFileAsync = (execFile as unknown as Record<symbol, jest.Mock>)[
  promisify.custom
];

const PROBE_JSON = JSON.stringify({
  streams: [
    { codec_type: 'audio' },
    { codec_type: 'video', width: 1920, height: 1080 },
  ],
  format: { duration: '5401.4' },
});

describe('ffmpeg.util (M-24)', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    execFileAsync.mockReset();
    command = {
      handlers: {},
      kill: jest.fn(),
      run: jest.fn(),
      on: jest.fn(),
    };
    for (const chain of [
      'renice',
      'videoCodec',
      'audioCodec',
      'audioBitrate',
      'audioChannels',
      'outputOptions',
      'output',
    ]) {
      command[chain] = jest.fn(() => command);
    }
    command.on.mockImplementation(
      (event: string, handler: (...args: unknown[]) => void) => {
        command.handlers[event] = handler;
        return command;
      },
    );
  });

  afterEach(() => {
    jest.useRealTimers();
    process.env = { ...ORIGINAL_ENV };
  });

  describe('probeVideo', () => {
    it('runs ffprobe with a hard timeout and SIGKILL', async () => {
      execFileAsync.mockResolvedValue({ stdout: PROBE_JSON, stderr: '' });

      await probeVideo('/scratch/original.mkv');

      expect(execFileAsync).toHaveBeenCalledWith(
        'ffprobe',
        expect.arrayContaining([
          '-print_format',
          'json',
          '/scratch/original.mkv',
        ]),
        expect.objectContaining({
          timeout: FFPROBE_TIMEOUT_MS,
          killSignal: 'SIGKILL',
        }),
      );
    });

    it("returns the rounded duration and the FIRST video stream's size, as the old wrapper did", async () => {
      execFileAsync.mockResolvedValue({ stdout: PROBE_JSON, stderr: '' });

      await expect(probeVideo('/scratch/original.mkv')).resolves.toEqual({
        durationSeconds: 5401,
        width: 1920,
        height: 1080,
      });
    });

    it('rejects a file with no video stream', async () => {
      execFileAsync.mockResolvedValue({
        stdout: JSON.stringify({
          streams: [{ codec_type: 'audio' }],
          format: {},
        }),
        stderr: '',
      });

      await expect(probeVideo('/scratch/audio.mp3')).rejects.toThrow(
        'No video stream found in uploaded file',
      );
    });

    it('turns a killed ffprobe into a readable failure instead of a hang', async () => {
      execFileAsync.mockRejectedValue(
        Object.assign(new Error('killed'), { killed: true, signal: 'SIGKILL' }),
      );

      await expect(probeVideo('/scratch/evil.mkv')).rejects.toThrow(
        /ffprobe did not finish within 60 s/,
      );
    });

    it('treats a missing duration as 0 and tolerates numeric JSON fields', async () => {
      execFileAsync.mockResolvedValue({
        stdout: JSON.stringify({
          streams: [{ codec_type: 'video', width: 640, height: 480 }],
          format: {},
        }),
        stderr: '',
      });

      await expect(probeVideo('/scratch/x.mp4')).resolves.toEqual({
        durationSeconds: 0,
        width: 640,
        height: 480,
      });
    });
  });

  describe('transcodeToHls watchdog', () => {
    const options = {
      inputPath: '/scratch/original.mkv',
      outputDir: '/scratch/hls/720p',
      segmentPattern: '/scratch/hls/720p/segment_%03d.ts',
      playlistPath: '/scratch/hls/720p/index.m3u8',
      targetWidth: 1280,
      targetHeight: 720,
      videoBitrate: '2800k',
    };

    it('kills ffmpeg with SIGKILL when a rendition runs past the budget and fails with a readable reason', async () => {
      jest.useFakeTimers();
      process.env.FFMPEG_RENDITION_TIMEOUT_MINUTES = '2';

      const run = transcodeToHls(options);
      expect(command.run).toHaveBeenCalled();
      expect(command.kill).not.toHaveBeenCalled();

      jest.advanceTimersByTime(2 * 60 * 1000);
      expect(command.kill).toHaveBeenCalledWith('SIGKILL');
      // What fluent-ffmpeg reports after a kill.
      command.handlers.error(
        new Error('ffmpeg was killed with signal SIGKILL'),
      );

      await expect(run).rejects.toThrow(
        'ffmpeg did not finish the 720p rendition within 2 minutes and was stopped',
      );
    });

    it('resolves on a normal end and never fires the watchdog afterwards', async () => {
      jest.useFakeTimers();

      const run = transcodeToHls(options);
      command.handlers.end();
      await expect(run).resolves.toBeUndefined();

      jest.advanceTimersByTime(ffmpegRenditionTimeoutMs() + 1);
      expect(command.kill).not.toHaveBeenCalled();
    });

    it('passes an ordinary ffmpeg error through unchanged', async () => {
      jest.useFakeTimers();
      const run = transcodeToHls(options);
      command.handlers.error(
        new Error('Invalid data found when processing input'),
      );

      await expect(run).rejects.toThrow(
        'Invalid data found when processing input',
      );
    });

    it('still passes the same encoder settings — the fix adds a bound, not a different transcode', () => {
      jest.useFakeTimers();
      void transcodeToHls(options);

      expect(ffmpeg).toHaveBeenCalledWith('/scratch/original.mkv');
      expect(command.renice).toHaveBeenCalledWith(19);
      expect(command.videoCodec).toHaveBeenCalledWith('libx264');
      expect(command.outputOptions).toHaveBeenCalledWith(
        expect.arrayContaining([
          '-vf scale=w=1280:h=720:force_original_aspect_ratio=decrease:force_divisible_by=2',
          '-b:v 2800k',
          '-threads 6',
        ]),
      );
      expect(command.output).toHaveBeenCalledWith(options.playlistPath);
    });

    it('defaults the budget to 6 hours per rendition and ignores a nonsense override', () => {
      expect(ffmpegRenditionTimeoutMs()).toBe(
        DEFAULT_FFMPEG_RENDITION_TIMEOUT_MINUTES * 60 * 1000,
      );
      process.env.FFMPEG_RENDITION_TIMEOUT_MINUTES = 'soon';
      expect(ffmpegRenditionTimeoutMs()).toBe(360 * 60 * 1000);
      process.env.FFMPEG_RENDITION_TIMEOUT_MINUTES = '90';
      expect(ffmpegRenditionTimeoutMs()).toBe(90 * 60 * 1000);
    });
  });

  /**
   * The encode profile the desktop Transcoder mirrors
   * (transcoder/test/encode-profile.test.ts pins its half). A real 10-bit
   * encode played on a phone cannot run here (no media, no devices), so
   * these pin the arguments ffmpeg receives.
   */
  describe('transcodeToHls encode profile (STR-001, STR-008, STR-013, STR-027)', () => {
    const options = {
      inputPath: '/scratch/original.mkv',
      outputDir: '/scratch/hls/720p',
      segmentPattern: '/scratch/hls/720p/segment_%03d.ts',
      playlistPath: '/scratch/hls/720p/index.m3u8',
      targetWidth: 1280,
      targetHeight: 720,
      videoBitrate: '2800k',
    };
    const outputOptionsPassed = (): string[] => {
      jest.useFakeTimers();
      void transcodeToHls(options);
      return (command.outputOptions as jest.Mock).mock.calls[0][0] as string[];
    };

    it('pins 8-bit 4:2:0 High 4.1 output, so a 10-bit source can no longer become High-10 H.264 (STR-001)', () => {
      expect(outputOptionsPassed()).toEqual(
        expect.arrayContaining([
          '-pix_fmt yuv420p',
          '-profile:v high',
          '-level 4.1',
        ]),
      );
      expect(H264_OUTPUT_FORMAT_ARGS).toContain('-pix_fmt yuv420p');
    });

    it('keeps exactly one video and one optional audio stream — no subtitle or data streams, so no stray .vtt per tier (STR-008)', () => {
      expect(outputOptionsPassed()).toEqual(
        expect.arrayContaining(['-map 0:v:0', '-map 0:a:0?', '-sn', '-dn']),
      );
      expect(STREAM_SELECTION_ARGS).toEqual([
        '-map 0:v:0',
        '-map 0:a:0?',
        '-sn',
        '-dn',
      ]);
    });

    it('downmixes the audio to stereo (STR-013)', () => {
      outputOptionsPassed();
      expect(command.audioCodec).toHaveBeenCalledWith('aac');
      expect(command.audioBitrate).toHaveBeenCalledWith('128k');
      expect(command.audioChannels).toHaveBeenCalledWith(2);
    });

    it('caps the peak at 1.3x the tier bitrate with a 2x buffer, next to -b:v (STR-027)', () => {
      expect(outputOptionsPassed()).toEqual(
        expect.arrayContaining([
          '-b:v 2800k',
          '-maxrate 3640k',
          '-bufsize 5600k',
        ]),
      );
    });

    it('derives a whole-kbps cap for every rendition tier', () => {
      expect(MAXRATE_FACTOR).toBe(1.3);
      expect(BUFSIZE_FACTOR).toBe(2);
      for (const tier of RENDITION_TIERS) {
        const kbps = Number(tier.videoBitrate.slice(0, -1));
        expect(rateCapArgs(tier.videoBitrate)).toEqual([
          `-maxrate ${Math.round(kbps * 1.3)}k`,
          `-bufsize ${kbps * 2}k`,
        ]);
      }
      expect(rateCapArgs('5000k')).toEqual([
        '-maxrate 6500k',
        '-bufsize 10000k',
      ]);
      expect(() => rateCapArgs('5M')).toThrow(/Unsupported video bitrate/);
    });

    it('leaves the rest of the command as it was: scale, preset, threads, GOP and HLS muxing', () => {
      expect(outputOptionsPassed()).toEqual(
        expect.arrayContaining([
          '-vf scale=w=1280:h=720:force_original_aspect_ratio=decrease:force_divisible_by=2',
          '-preset veryfast',
          '-threads 6',
          '-sc_threshold 0',
          '-g 48',
          '-hls_time 6',
          '-hls_playlist_type vod',
          '-hls_segment_filename /scratch/hls/720p/segment_%03d.ts',
        ]),
      );
      expect(command.videoCodec).toHaveBeenCalledWith('libx264');
    });

    it('passes every option as a bare flag or "-flag value" — the only shapes fluent-ffmpeg splits', () => {
      for (const option of outputOptionsPassed()) {
        expect(option.split(' ').length).toBeLessThanOrEqual(2);
      }
    });
  });

  /**
   * The widescreen ladder (owner, 2026-10-12): every rung is scaled to fit
   * INSIDE its 16:9 box instead of to a bare height, so a 1920x800 film's
   * 1080p rung is 1920x800 and its 720p rung 1280x534. rendition-tiers.spec.ts
   * pins the sizes the filter produces; this pins the filter itself.
   */
  describe('transcodeToHls scale filter (widescreen ladder)', () => {
    it('fits the picture inside the tier box, aspect kept, both sides even', () => {
      expect(scaleFilter(1920, 1080)).toBe(
        'scale=w=1920:h=1080:force_original_aspect_ratio=decrease:force_divisible_by=2',
      );
      for (const tier of RENDITION_TIERS) {
        expect(scaleFilter(tier.width, tier.height)).toBe(
          `scale=w=${tier.width}:h=${tier.height}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
        );
      }
    });

    it('passes the requested tier box as ONE "-vf <filter>" option, and no bare-height scale any more', () => {
      jest.useFakeTimers();
      void transcodeToHls({
        inputPath: '/scratch/original.mkv',
        outputDir: '/scratch/hls/1080p',
        segmentPattern: '/scratch/hls/1080p/segment_%03d.ts',
        playlistPath: '/scratch/hls/1080p/index.m3u8',
        targetWidth: 1920,
        targetHeight: 1080,
        videoBitrate: '5000k',
      });

      const passed = (command.outputOptions as jest.Mock).mock
        .calls[0][0] as string[];
      expect(passed.filter((option) => option.startsWith('-vf '))).toEqual([
        '-vf scale=w=1920:h=1080:force_original_aspect_ratio=decrease:force_divisible_by=2',
      ]);
      expect(passed).not.toContainEqual(expect.stringContaining('scale=-2:'));
    });
  });
});
