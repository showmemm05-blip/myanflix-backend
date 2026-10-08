import ffmpeg from 'fluent-ffmpeg';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  DEFAULT_FFMPEG_RENDITION_TIMEOUT_MINUTES,
  FFPROBE_TIMEOUT_MS,
  ffmpegRenditionTimeoutMs,
  probeVideo,
  transcodeToHls,
} from './ffmpeg.util';

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
          '-vf scale=-2:720',
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
});
