import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/storage/minio.service';
import { StorageService } from '../common/storage/storage.service';
import { HlsSubtitlesService } from './hls-subtitles.service';
import { AuditService } from '../audit/audit.service';
import { Role } from '../generated/prisma/client';
import { SubtitlesService } from './subtitles.service';

const VIDEO_ID = '0b94b5e5-7224-4dfd-99a3-4112bb09501c';
const MOVIE_ID = 'ebfce557-db9f-4515-8329-f28fc10dd28f';
const SUBTITLE_ID = 'cc0ce210-d64a-4a83-ab24-33369b711e43';

/** A staff actor for the audit calls — the mocked AuditService records nothing. */
const ACTOR = {
  id: 'admin-1',
  username: 'boss',
  role: Role.ADMIN,
  appRoleId: null,
} as const;

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
  let minioService: { uploadBuffer: jest.Mock; deleteObject: jest.Mock };
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
    // Foldered by the OWNING MOVIE, filename = the subtitle id: what
    // StorageService.subtitleSourceKey() builds for a single upload.
    objectKey: `subtitles/${MOVIE_ID}/${SUBTITLE_ID}.srt`,
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
    minioService = {
      uploadBuffer: jest.fn().mockResolvedValue(undefined),
      deleteObject: jest.fn().mockResolvedValue(undefined),
    };
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
        // The REAL key builder rather than a mock: the key shape is exactly
        // what these assertions are for, and a mocked builder would only
        // prove the spec agrees with itself. StorageService is pure and
        // reads nothing but STORAGE_PATH, which no object key depends on.
        {
          provide: StorageService,
          useValue: new StorageService(new ConfigService()),
        },
        { provide: HlsSubtitlesService, useValue: hlsSubtitlesService },
        {
          provide: AuditService,
          useValue: { record: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    service = module.get(SubtitlesService);
  });

  it('publishes after an upload creates a track', async () => {
    await service.create(
      { videoId: VIDEO_ID, language: 'en', label: 'English' },
      'english.srt',
      Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nHi\n'),
      ACTOR,
    );

    expect(hlsSubtitlesService.publishForVideo).toHaveBeenCalledWith(VIDEO_ID);
  });

  /**
   * The source lands under the movie that owns it, NOT under its own
   * subtitle id: that is what makes a title's sources one prefix delete, and
   * what lets a single `subtitles/<movieId>` token sign every track the
   * stream response hands out. The uploaded filename is deliberately not
   * reused here — the subtitle id is, so two uploads of "english.srt" cannot
   * overwrite each other.
   */
  it('stores the uploaded source under the owning movie, named by subtitle id', async () => {
    await service.create(
      { videoId: VIDEO_ID, language: 'en', label: 'English' },
      'english.srt',
      Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nHi\n'),
      ACTOR,
    );

    const [key] = minioService.uploadBuffer.mock.calls[0] as [string];
    const [, movieId, filename] = key.split('/');
    expect(movieId).toBe(MOVIE_ID);
    expect(filename).toMatch(/^[0-9a-f-]{36}\.srt$/);
    // The row must point at exactly the key that was written.
    expect(prisma.subtitle.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          objectKey: key,
          id: filename.replace('.srt', ''),
        }),
      }),
    );
  });

  it('still stores an .ass upload — the row is kept, only the manifest excludes it', async () => {
    await service.create(
      { videoId: VIDEO_ID, language: 'en', label: 'Styled' },
      'styled.ass',
      Buffer.from('[Script Info]'),
      ACTOR,
    );

    expect(minioService.uploadBuffer).toHaveBeenCalledWith(
      expect.stringMatching(
        new RegExp(`^subtitles/${MOVIE_ID}/[0-9a-f-]{36}\\.ass$`),
      ),
      expect.any(Buffer),
    );
    expect(prisma.subtitle.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ format: 'ASS' }),
      }),
    );
  });

  /**
   * F-008: the default is decided by the DTO's boolean, not by whether the
   * field was present. `false` must neither steal the default from the
   * existing track (updateMany) nor be stored as true.
   */
  it('create with isDefault: false leaves the existing default alone', async () => {
    await service.create(
      { videoId: VIDEO_ID, language: 'fr', label: 'French', isDefault: false },
      'french.srt',
      Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nSalut\n'),
      ACTOR,
    );

    expect(prisma.subtitle.updateMany).not.toHaveBeenCalled();
    expect(prisma.subtitle.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ isDefault: false }),
      }),
    );
  });

  it('create with isDefault: true clears the previous default first', async () => {
    await service.create(
      { videoId: VIDEO_ID, language: 'fr', label: 'French', isDefault: true },
      'french.srt',
      Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nSalut\n'),
      ACTOR,
    );

    expect(prisma.subtitle.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ videoId: VIDEO_ID, isDefault: true }),
        data: { isDefault: false },
      }),
    );
    expect(prisma.subtitle.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ isDefault: true }),
      }),
    );
  });

  it('update with isDefault: false leaves the existing default alone', async () => {
    await service.update(SUBTITLE_ID, { isDefault: false }, ACTOR);

    expect(prisma.subtitle.updateMany).not.toHaveBeenCalled();
    expect(prisma.subtitle.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: SUBTITLE_ID },
        data: expect.objectContaining({ isDefault: false }),
      }),
    );
  });

  it('update with isDefault: true clears the previous default first', async () => {
    await service.update(SUBTITLE_ID, { isDefault: true }, ACTOR);

    expect(prisma.subtitle.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ videoId: VIDEO_ID, isDefault: true }),
        data: { isDefault: false },
      }),
    );
    expect(prisma.subtitle.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: SUBTITLE_ID },
        data: expect.objectContaining({ isDefault: true }),
      }),
    );
  });

  it('publishes after the pre-transcoded bundle flow records a track', async () => {
    await service.createFromExistingKey({
      videoId: VIDEO_ID,
      language: 'en',
      label: 'English',
      format: 'SRT',
      // What the bulk bundle flow writes: same folder as a single upload,
      // but keeping the operator's own filename — that name is how they
      // matched the track to its language in the first place.
      objectKey: `subtitles/${MOVIE_ID}/english.srt`,
    });

    expect(hlsSubtitlesService.publishForVideo).toHaveBeenCalledWith(VIDEO_ID);
  });

  it('publishes after a metadata edit, because label/language are the manifest NAME/LANGUAGE', async () => {
    await service.update(SUBTITLE_ID, { label: 'English (CC)' }, ACTOR);

    expect(hlsSubtitlesService.publishForVideo).toHaveBeenCalledWith(VIDEO_ID);
  });

  it('publishes after set-default so DEFAULT=YES moves with it', async () => {
    await service.setDefault(SUBTITLE_ID, ACTOR);

    expect(hlsSubtitlesService.publishForVideo).toHaveBeenCalledWith(VIDEO_ID);
  });

  it('deletes the published objects and republishes when a track is removed', async () => {
    await service.remove(SUBTITLE_ID, ACTOR);

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

  /**
   * The source file used to be left behind on every delete — nothing else
   * ever referenced it and the row that named it was gone, so it was
   * unreachable storage growing one file per deleted track.
   */
  it('deletes the uploaded source file too', async () => {
    await service.remove(SUBTITLE_ID, ACTOR);

    expect(minioService.deleteObject).toHaveBeenCalledWith(
      existingRow.objectKey,
    );
  });

  it('still succeeds when deleting the source file fails', async () => {
    minioService.deleteObject.mockRejectedValue(new Error('MinIO unreachable'));

    await expect(service.remove(SUBTITLE_ID, ACTOR)).resolves.toBeUndefined();
    expect(prisma.subtitle.delete).toHaveBeenCalled();
  });

  it('leaves the objects in place when the manifest rewrite fails', async () => {
    hlsSubtitlesService.publishForVideo.mockRejectedValue(
      new Error('MinIO unreachable'),
    );

    await expect(service.remove(SUBTITLE_ID, ACTOR)).resolves.toBeUndefined();

    // The master may still advertise this rendition, so its .m3u8/.vtt must
    // survive: an unreferenced object is inert, a dangling URI stalls players.
    expect(hlsSubtitlesService.unpublishSubtitle).not.toHaveBeenCalled();
    // The SOURCE is a different matter — no manifest has ever referenced it,
    // so a failed republish is no reason to keep paying for it.
    expect(minioService.deleteObject).toHaveBeenCalledWith(
      existingRow.objectKey,
    );
  });

  it('does not fail the admin request when publishing throws', async () => {
    hlsSubtitlesService.publishForVideo.mockRejectedValue(
      new Error('MinIO unreachable'),
    );

    await expect(service.setDefault(SUBTITLE_ID, ACTOR)).resolves.toEqual(
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
