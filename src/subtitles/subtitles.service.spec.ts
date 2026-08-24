import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/storage/minio.service';
import { HlsSubtitlesService } from './hls-subtitles.service';
import { SubtitlesService } from './subtitles.service';

const VIDEO_ID = '0b94b5e5-7224-4dfd-99a3-4112bb09501c';
const MOVIE_ID = 'ebfce557-db9f-4515-8329-f28fc10dd28f';
const SUBTITLE_ID = 'cc0ce210-d64a-4a83-ab24-33369b711e43';

/**
 * The wiring, not the mechanics: every write path that can change what a
 * player should see has to reach the publisher, and none of them may fail
 * the admin's request when the storage layer misbehaves.
 */
describe('SubtitlesService — publishing on write', () => {
  let service: SubtitlesService;
  let prisma: {
    video: { findUnique: jest.Mock };
    subtitle: {
      create: jest.Mock;
      delete: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      findUnique: jest.Mock;
      findUniqueOrThrow: jest.Mock;
    };
    $transaction: jest.Mock;
  };
  let minioService: { uploadBuffer: jest.Mock };
  let hlsSubtitlesService: {
    publishForVideo: jest.Mock;
    publishForMovie: jest.Mock;
    unpublishSubtitle: jest.Mock;
  };

  const existingRow = {
    id: SUBTITLE_ID,
    videoId: VIDEO_ID,
    language: 'en',
    label: 'English',
    format: 'SRT',
    objectKey: `subtitles/${SUBTITLE_ID}/original.srt`,
    isDefault: false,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    prisma = {
      video: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: VIDEO_ID, movieId: MOVIE_ID }),
      },
      subtitle: {
        create: jest.fn().mockResolvedValue(existingRow),
        delete: jest.fn().mockResolvedValue(existingRow),
        update: jest.fn().mockResolvedValue(existingRow),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findUnique: jest.fn().mockResolvedValue(existingRow),
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ ...existingRow, isDefault: true }),
      },
      $transaction: jest.fn().mockResolvedValue([]),
    };
    minioService = { uploadBuffer: jest.fn().mockResolvedValue(undefined) };
    hlsSubtitlesService = {
      publishForVideo: jest
        .fn()
        .mockResolvedValue({ published: [], excluded: [] }),
      publishForMovie: jest
        .fn()
        .mockResolvedValue({ published: [], excluded: [] }),
      unpublishSubtitle: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SubtitlesService,
        { provide: PrismaService, useValue: prisma },
        { provide: MinioService, useValue: minioService },
        { provide: HlsSubtitlesService, useValue: hlsSubtitlesService },
      ],
    }).compile();

    service = module.get(SubtitlesService);
  });

  it('publishes after an upload creates a track', async () => {
    await service.create(
      { videoId: VIDEO_ID, language: 'en', label: 'English' },
      'english.srt',
      Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nHi\n'),
    );

    expect(hlsSubtitlesService.publishForVideo).toHaveBeenCalledWith(VIDEO_ID);
  });

  it('still stores an .ass upload — the row is kept, only the manifest excludes it', async () => {
    await service.create(
      { videoId: VIDEO_ID, language: 'en', label: 'Styled' },
      'styled.ass',
      Buffer.from('[Script Info]'),
    );

    expect(minioService.uploadBuffer).toHaveBeenCalledWith(
      expect.stringMatching(/^subtitles\/.+\/original\.ass$/),
      expect.any(Buffer),
    );
    expect(prisma.subtitle.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ format: 'ASS' }),
      }),
    );
  });

  it('publishes after the pre-transcoded bundle flow records a track', async () => {
    await service.createFromExistingKey({
      videoId: VIDEO_ID,
      language: 'en',
      label: 'English',
      format: 'SRT',
      objectKey: `videos/${MOVIE_ID}/subtitles/english.srt`,
    });

    expect(hlsSubtitlesService.publishForVideo).toHaveBeenCalledWith(VIDEO_ID);
  });

  it('publishes after a metadata edit, because label/language are the manifest NAME/LANGUAGE', async () => {
    await service.update(SUBTITLE_ID, { label: 'English (CC)' });

    expect(hlsSubtitlesService.publishForVideo).toHaveBeenCalledWith(VIDEO_ID);
  });

  it('publishes after set-default so DEFAULT=YES moves with it', async () => {
    await service.setDefault(SUBTITLE_ID);

    expect(hlsSubtitlesService.publishForVideo).toHaveBeenCalledWith(VIDEO_ID);
  });

  it('deletes the published objects and republishes when a track is removed', async () => {
    await service.remove(SUBTITLE_ID);

    expect(hlsSubtitlesService.unpublishSubtitle).toHaveBeenCalledWith(
      MOVIE_ID,
      SUBTITLE_ID,
    );
    expect(hlsSubtitlesService.publishForVideo).toHaveBeenCalledWith(VIDEO_ID);
    // The manifest goes first: the re-publish is best-effort, so if it fails
    // the worst case has to be an unreferenced object, never a master still
    // advertising a rendition whose objects have already been deleted.
    const unpublishOrder =
      hlsSubtitlesService.unpublishSubtitle.mock.invocationCallOrder[0];
    const publishOrder =
      hlsSubtitlesService.publishForVideo.mock.invocationCallOrder[0];
    expect(publishOrder).toBeLessThan(unpublishOrder);
  });

  it('leaves the objects in place when the manifest rewrite fails', async () => {
    hlsSubtitlesService.publishForVideo.mockRejectedValue(
      new Error('MinIO unreachable'),
    );

    await expect(service.remove(SUBTITLE_ID)).resolves.toBeUndefined();

    // The master may still advertise this rendition, so its .m3u8/.vtt must
    // survive: an unreferenced object is inert, a dangling URI stalls players.
    expect(hlsSubtitlesService.unpublishSubtitle).not.toHaveBeenCalled();
  });

  it('does not fail the admin request when publishing throws', async () => {
    hlsSubtitlesService.publishForVideo.mockRejectedValue(
      new Error('MinIO unreachable'),
    );

    await expect(service.setDefault(SUBTITLE_ID)).resolves.toEqual(
      expect.objectContaining({ id: SUBTITLE_ID }),
    );
  });

  it('exposes an idempotent backfill for one subtitle', async () => {
    await service.republish(SUBTITLE_ID);

    expect(prisma.subtitle.findUnique).toHaveBeenCalledWith({
      where: { id: SUBTITLE_ID },
    });
    expect(hlsSubtitlesService.publishForVideo).toHaveBeenCalledWith(VIDEO_ID);
  });

  it('exposes the same backfill addressed by movie', async () => {
    await service.republishForMovie(MOVIE_ID);

    expect(hlsSubtitlesService.publishForMovie).toHaveBeenCalledWith(MOVIE_ID);
  });
});
