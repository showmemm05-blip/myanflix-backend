import { Test, TestingModule } from '@nestjs/testing';
import { AuditService } from '../audit/audit.service';
import { CodedHttpException } from '../common/errors/coded-http.exception';
import { MinioService } from '../common/storage/minio.service';
import { StorageService } from '../common/storage/storage.service';
import { PrismaService } from '../prisma/prisma.service';
import * as ffmpeg from '../processing/ffmpeg.util';
import { ADS_ERRORS } from './ads-errors';
import { AdVideoService } from './ad-video.service';

jest.mock('node:fs/promises', () => ({
  rm: jest.fn().mockResolvedValue(undefined),
  stat: jest.fn().mockResolvedValue({ size: 4242 }),
}));

const MP4_HEADER = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from('ftypisom', 'latin1'),
]);
const actor = { id: 'staff-1', username: 'staff', role: 'ADMIN' } as never;

async function rejection(
  promise: Promise<unknown>,
): Promise<CodedHttpException> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CodedHttpException) return error;
    throw error;
  }
  throw new Error('expected the call to reject');
}

describe('AdVideoService.attach', () => {
  let service: AdVideoService;
  let prisma: {
    advertisement: Record<
      'findUnique' | 'findUniqueOrThrow' | 'update',
      jest.Mock
    >;
    $transaction: jest.Mock;
  };
  let minio: Record<
    | 'objectStat'
    | 'readBytes'
    | 'downloadFile'
    | 'uploadFile'
    | 'deleteObject'
    | 'deleteByPrefix',
    jest.Mock
  >;
  let audit: { record: jest.Mock };
  let probe: jest.SpyInstance;
  let remux: jest.SpyInstance;

  beforeEach(async () => {
    prisma = {
      advertisement: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'ad-1',
          title: 'Big match',
          format: 'VIDEO',
          videoKey: 'ads/ad-1/v-old1/video.mp4',
          isSkippable: true,
          skipAfterSeconds: 5,
          movies: [],
        }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          isSkippable: true,
          skipAfterSeconds: 5,
          videoKey: 'ads/ad-1/v-old1/video.mp4',
        }),
        update: jest.fn(
          async ({ data }: { data: Record<string, unknown> }) => ({
            id: 'ad-1',
            title: 'Big match',
            ...data,
          }),
        ),
      },
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn(prisma),
      ),
    };
    minio = {
      objectStat: jest.fn(async (key: string) =>
        key.startsWith('temp/')
          ? { size: 4242, etag: 'staged' }
          : { size: 4242, etag: 'final' },
      ),
      readBytes: jest.fn().mockResolvedValue(MP4_HEADER),
      downloadFile: jest.fn().mockResolvedValue({ etag: 'staged' }),
      uploadFile: jest.fn().mockResolvedValue(undefined),
      deleteObject: jest.fn().mockResolvedValue(undefined),
      deleteByPrefix: jest.fn().mockResolvedValue(undefined),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    probe = jest.spyOn(ffmpeg, 'probeVideo').mockResolvedValue({
      durationSeconds: 14.6,
      width: 1280,
      height: 720,
    } as never);
    remux = jest.spyOn(ffmpeg, 'remuxFastStart').mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdVideoService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: MinioService, useValue: minio },
        {
          provide: StorageService,
          useValue: {
            adStagingKey: (id: string) => `temp/ads/${id}/video.mp4`,
            adVideoKey: (id: string, tag: string) =>
              `ads/${id}/v-${tag}/video.mp4`,
            adScratchDir: (id: string, run: string) =>
              `/storage/temp/ads/${id}/${run}`,
            ensureDir: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();
    service = module.get(AdVideoService);
  });

  afterEach(() => jest.restoreAllMocks());

  it('checks, remuxes, uploads a fresh package, updates the row, audits, then cleans up', async () => {
    await service.attach('ad-1', { relativePath: 'video.mp4' }, actor);
    expect(minio.readBytes).toHaveBeenCalledWith('temp/ads/ad-1/video.mp4', 12);
    expect(probe).toHaveBeenCalled();
    expect(remux).toHaveBeenCalled();
    const [key] = minio.uploadFile.mock.calls[0] as [string, string];
    expect(key).toMatch(/^ads\/ad-1\/v-[0-9a-f]{8}\/video\.mp4$/);
    expect(prisma.advertisement.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          videoKey: key,
          videoBytes: 4242,
          videoEtag: 'final',
          durationSeconds: 15,
        }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'advertisement.video_attach' }),
    );
    expect(minio.deleteObject).toHaveBeenCalledWith('temp/ads/ad-1/video.mp4');
    expect(minio.deleteByPrefix).toHaveBeenCalledWith('ads/ad-1/v-old1/');
  });

  it('is 404 when nothing was staged', async () => {
    minio.objectStat.mockResolvedValue(null);
    expect(
      (
        await rejection(
          service.attach('ad-1', { relativePath: 'video.mp4' }, actor),
        )
      ).code,
    ).toBe(ADS_ERRORS.VIDEO_MISSING);
  });

  it('refuses a file that is not an MP4 container, before downloading it', async () => {
    minio.readBytes.mockResolvedValue(
      Buffer.from('RIFF....WEBPVP8 ', 'latin1'),
    );
    expect(
      (
        await rejection(
          service.attach('ad-1', { relativePath: 'video.mp4' }, actor),
        )
      ).code,
    ).toBe(ADS_ERRORS.VIDEO_NOT_MP4);
    expect(minio.downloadFile).not.toHaveBeenCalled();
  });

  it('refuses an unreadable or over-long video', async () => {
    probe.mockRejectedValue(
      new Error('No video stream found in uploaded file'),
    );
    expect(
      (
        await rejection(
          service.attach('ad-1', { relativePath: 'video.mp4' }, actor),
        )
      ).code,
    ).toBe(ADS_ERRORS.VIDEO_UNREADABLE);
    probe.mockResolvedValue({
      durationSeconds: 601,
      width: 1,
      height: 1,
    } as never);
    expect(
      (
        await rejection(
          service.attach('ad-1', { relativePath: 'video.mp4' }, actor),
        )
      ).code,
    ).toBe(ADS_ERRORS.VIDEO_TOO_LONG);
    expect(minio.uploadFile).not.toHaveBeenCalled();
  });

  it('keeps the original when the remux fails', async () => {
    remux.mockRejectedValue(new Error('exotic container'));
    await service.attach('ad-1', { relativePath: 'video.mp4' }, actor);
    expect(minio.uploadFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringMatching(/\/source\.mp4$/),
    );
  });

  it('refuses when skip-after is not shorter than the new duration, and removes the new package', async () => {
    probe.mockResolvedValue({
      durationSeconds: 5,
      width: 1,
      height: 1,
    } as never);
    expect(
      (
        await rejection(
          service.attach('ad-1', { relativePath: 'video.mp4' }, actor),
        )
      ).code,
    ).toBe(ADS_ERRORS.SKIP_AFTER_TOO_LONG);
    expect(prisma.advertisement.update).not.toHaveBeenCalled();
    expect(minio.deleteByPrefix).toHaveBeenCalledWith(
      expect.stringMatching(/^ads\/ad-1\/v-[0-9a-f]{8}\/$/),
    );
    expect(minio.deleteObject).not.toHaveBeenCalled();
  });

  it('checks the skip fields sent with the file against the NEW length, and stores them', async () => {
    probe.mockResolvedValue({
      durationSeconds: 10,
      width: 1,
      height: 1,
    } as never);
    // The stored skip-after (5) would pass; the form raises it beyond the new file.
    expect(
      (
        await rejection(
          service.attach(
            'ad-1',
            { relativePath: 'video.mp4', skipAfterSeconds: 12 },
            actor,
          ),
        )
      ).code,
    ).toBe(ADS_ERRORS.SKIP_AFTER_TOO_LONG);
    // Lowering it with the file lands both in one transaction.
    await service.attach(
      'ad-1',
      { relativePath: 'video.mp4', isSkippable: true, skipAfterSeconds: 3 },
      actor,
    );
    expect(prisma.advertisement.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          durationSeconds: 10,
          isSkippable: true,
          skipAfterSeconds: 3,
        }),
      }),
    );
    // Not skippable drops the second even when the stored row had one.
    await service.attach(
      'ad-1',
      { relativePath: 'video.mp4', isSkippable: false },
      actor,
    );
    expect(prisma.advertisement.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          isSkippable: false,
          skipAfterSeconds: null,
        }),
      }),
    );
  });

  it('refuses when another attach landed meanwhile, and removes its own package', async () => {
    prisma.advertisement.findUniqueOrThrow.mockResolvedValue({
      isSkippable: false,
      skipAfterSeconds: null,
      videoKey: 'ads/ad-1/v-other/video.mp4',
    });
    expect(
      (
        await rejection(
          service.attach('ad-1', { relativePath: 'video.mp4' }, actor),
        )
      ).code,
    ).toBe(ADS_ERRORS.VIDEO_ATTACH_CONFLICT);
    expect(prisma.advertisement.update).not.toHaveBeenCalled();
    expect(minio.deleteByPrefix).toHaveBeenCalledWith(
      expect.stringMatching(/^ads\/ad-1\/v-[0-9a-f]{8}\/$/),
    );
    expect(minio.deleteByPrefix).not.toHaveBeenCalledWith('ads/ad-1/v-old1/');
  });

  it('is 404 when the staged file vanished before the download', async () => {
    minio.downloadFile.mockRejectedValue(new Error('NoSuchKey'));
    expect(
      (
        await rejection(
          service.attach('ad-1', { relativePath: 'video.mp4' }, actor),
        )
      ).code,
    ).toBe(ADS_ERRORS.VIDEO_MISSING);
  });

  it('needs the one allowed filename', async () => {
    expect(
      (
        await rejection(
          service.attach('ad-1', { relativePath: 'clip.mp4' }, actor),
        )
      ).code,
    ).toBe(ADS_ERRORS.VIDEO_MISSING);
  });
});
