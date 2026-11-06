import { Test, TestingModule } from '@nestjs/testing';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MovieStatus } from '../generated/prisma/client';
import { BadRequestException } from '@nestjs/common';
import {
  DIRECT_UPLOAD_MOVIE_STATUSES,
  REPLACEABLE_MOVIE_STATUSES,
  ResourceUploadTypeRegistry,
} from './resource-upload-type.registry';
import {
  DEFAULT_MAX_AD_VIDEO_UPLOAD_BYTES,
  DEFAULT_MAX_DOCUMENT_UPLOAD_BYTES,
  DEFAULT_MAX_VIDEO_UPLOAD_BYTES,
} from './upload-limits';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionResolverService } from '../roles/permission-resolver.service';
import { StorageService } from '../common/storage/storage.service';

/**
 * buildKey is the ONE place a bundle's relativePath becomes an object key,
 * for all three upload paths (presigned, multipart, chunked), so the real
 * StorageService is used here rather than a mock — the point of these cases
 * is the actual key shape, not that some function was called.
 */
describe('ResourceUploadTypeRegistry', () => {
  let registry: ResourceUploadTypeRegistry;
  let prisma: {
    movie: { findUnique: jest.Mock };
    book: { findUnique: jest.Mock };
    advertisement: { findUnique: jest.Mock };
  };
  let permissionResolver: { can: jest.Mock };

  const user = { id: 'admin-1', role: 'ADMIN' } as never;

  beforeEach(async () => {
    jest.clearAllMocks();

    prisma = {
      movie: { findUnique: jest.fn().mockResolvedValue({ id: 'movie-1' }) },
      book: { findUnique: jest.fn().mockResolvedValue({ id: 'book-1' }) },
      advertisement: {
        findUnique: jest.fn().mockResolvedValue({ id: 'ad-1' }),
      },
    };
    permissionResolver = { can: jest.fn().mockResolvedValue(true) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ResourceUploadTypeRegistry,
        { provide: PrismaService, useValue: prisma },
        { provide: PermissionResolverService, useValue: permissionResolver },
        StorageService,
        {
          provide: ConfigService,
          useValue: { get: () => '/storage' },
        },
      ],
    }).compile();

    registry = module.get(ResourceUploadTypeRegistry);
  });

  describe('buildKey — movie', () => {
    const key = (relativePath: string) =>
      registry.resolve('movie').buildKey('movie-1', relativePath);

    it('keeps the original and every HLS file in the movie video namespace', () => {
      expect(key('original.mp4')).toBe('videos/movie-1/original.mp4');
      expect(key('original.mkv')).toBe('videos/movie-1/original.mkv');
      expect(key('hls/master.m3u8')).toBe('videos/movie-1/hls/master.m3u8');
      expect(key('hls/720p/segment_000.ts')).toBe(
        'videos/movie-1/hls/720p/segment_000.ts',
      );
    });

    it(
      'routes an uploaded subtitle SOURCE out of videos/ and into subtitles/<movieId>/ — ' +
        "keeping the operator's own filename, which is how they identify the track",
      () => {
        expect(key('subtitles/english.vtt')).toBe(
          'subtitles/movie-1/english.vtt',
        );
        expect(key('subtitles/myanmar.srt')).toBe(
          'subtitles/movie-1/myanmar.srt',
        );
      },
    );

    it('flattens a nested subtitle path to its basename so the prefix stays exactly one level deep', () => {
      expect(key('subtitles/final/english.vtt')).toBe(
        'subtitles/movie-1/english.vtt',
      );
    });

    it('does not mistake an hls subtitle rendition folder for a subtitle SOURCE', () => {
      // videos/<id>/hls/subs/ is GENERATED output that must stay under the
      // signed HLS prefix — only a root-level "subtitles/" path is a source.
      expect(key('hls/subs/track-1.m3u8')).toBe(
        'videos/movie-1/hls/subs/track-1.m3u8',
      );
    });
  });

  describe('assertExists — movie (a DIRECT upload onto the live keys, M-22)', () => {
    it.each([MovieStatus.UPLOADING, MovieStatus.FAILED])(
      'lets a %s movie take a direct upload — a placeholder still being filled, or a rejected bundle being retried',
      async (status) => {
        prisma.movie.findUnique.mockResolvedValue({ id: 'movie-1', status });
        await expect(
          registry.resolve('movie').assertExists('movie-1'),
        ).resolves.toBeUndefined();
      },
    );

    it.each([
      MovieStatus.PUBLISHED,
      MovieStatus.READY_TO_PUBLISH,
      MovieStatus.DRAFT,
      MovieStatus.PROCESSING,
      MovieStatus.ARCHIVED,
    ])(
      'refuses a %s movie with 409 that points at the movie-replace flow — presign-batch / multipart/init / chunked init all reject before a byte lands',
      async (status) => {
        prisma.movie.findUnique.mockResolvedValue({ id: 'movie-1', status });
        const attempt = registry.resolve('movie').assertExists('movie-1');
        await expect(attempt).rejects.toThrow(ConflictException);
        await expect(attempt).rejects.toThrow(/movie-replace/);
        await expect(attempt).rejects.toThrow(new RegExp(status));
      },
    );

    it('is exactly the two states finalize acts on', () => {
      expect([...DIRECT_UPLOAD_MOVIE_STATUSES]).toEqual([
        MovieStatus.UPLOADING,
        MovieStatus.FAILED,
      ]);
    });
  });

  describe('assertFileSizeAllowed — the per-type size budget (M-23)', () => {
    const ORIGINAL_ENV = { ...process.env };
    afterEach(() => {
      process.env = { ...ORIGINAL_ENV };
    });

    it('accepts a video right at 60 GB and refuses one byte more', () => {
      expect(() =>
        registry.assertFileSizeAllowed(
          'movie',
          DEFAULT_MAX_VIDEO_UPLOAD_BYTES,
          'original.mkv',
        ),
      ).not.toThrow();
      expect(() =>
        registry.assertFileSizeAllowed(
          'movie',
          DEFAULT_MAX_VIDEO_UPLOAD_BYTES + 1,
          'original.mkv',
        ),
      ).toThrow(BadRequestException);
      expect(() =>
        registry.assertFileSizeAllowed(
          'movie',
          DEFAULT_MAX_VIDEO_UPLOAD_BYTES + 1,
          'original.mkv',
        ),
      ).toThrow(
        /"original.mkv" is \d+ bytes — the limit for a movie upload is 60 GB/,
      );
    });

    it('gives a replacement bundle the same video budget', () => {
      expect(() =>
        registry.assertFileSizeAllowed(
          'movie-replace',
          DEFAULT_MAX_VIDEO_UPLOAD_BYTES + 1,
        ),
      ).toThrow(BadRequestException);
      expect(() =>
        registry.assertFileSizeAllowed(
          'movie-replace',
          DEFAULT_MAX_VIDEO_UPLOAD_BYTES,
        ),
      ).not.toThrow();
    });

    it('caps a book PDF at 500 MB', () => {
      expect(() =>
        registry.assertFileSizeAllowed(
          'book',
          DEFAULT_MAX_DOCUMENT_UPLOAD_BYTES,
        ),
      ).not.toThrow();
      expect(() =>
        registry.assertFileSizeAllowed(
          'book',
          DEFAULT_MAX_DOCUMENT_UPLOAD_BYTES + 1,
        ),
      ).toThrow(/the limit for a book upload is 500 MB/);
    });

    it('caps a pre-roll ad MP4 at 200 MB', () => {
      expect(() =>
        registry.assertFileSizeAllowed('ad', DEFAULT_MAX_AD_VIDEO_UPLOAD_BYTES),
      ).not.toThrow();
      expect(() =>
        registry.assertFileSizeAllowed(
          'ad',
          DEFAULT_MAX_AD_VIDEO_UPLOAD_BYTES + 1,
        ),
      ).toThrow(/the limit for a ad upload is 200 MB/);
    });

    it('can be raised or lowered through the environment without a code change', () => {
      process.env.UPLOAD_MAX_DOCUMENT_BYTES = '1000';
      expect(() => registry.assertFileSizeAllowed('book', 1001)).toThrow(
        BadRequestException,
      );
      expect(() => registry.assertFileSizeAllowed('book', 1000)).not.toThrow();
    });

    it('ignores a nonsense environment value and keeps the default', () => {
      process.env.UPLOAD_MAX_VIDEO_BYTES = 'lots';
      expect(() =>
        registry.assertFileSizeAllowed('movie', DEFAULT_MAX_VIDEO_UPLOAD_BYTES),
      ).not.toThrow();
    });

    it('rejects an unknown resourceType like resolve() does', () => {
      expect(() => registry.assertFileSizeAllowed('podcast', 1)).toThrow(
        NotFoundException,
      );
    });
  });

  describe('buildKey — movie-replace (a replacement bundle for an existing title)', () => {
    const key = (relativePath: string) =>
      registry.resolve('movie-replace').buildKey('movie-1', relativePath);

    it('stages every bundle file verbatim under temp/video-replace/<movieId>/ — never on the live keys', () => {
      expect(key('original.mp4')).toBe(
        'temp/video-replace/movie-1/original.mp4',
      );
      expect(key('hls/master.m3u8')).toBe(
        'temp/video-replace/movie-1/hls/master.m3u8',
      );
      expect(key('hls/720p/segment_000.ts')).toBe(
        'temp/video-replace/movie-1/hls/720p/segment_000.ts',
      );
    });

    it('keeps a subtitle source under the staging prefix too — the videos/ vs subtitles/ split happens at swap time', () => {
      expect(key('subtitles/english.vtt')).toBe(
        'temp/video-replace/movie-1/subtitles/english.vtt',
      );
    });

    it('stages under temp/, a prefix the cache server denies unconditionally and nothing can sign', () => {
      expect(key('hls/720p/index.m3u8').startsWith('temp/')).toBe(true);
      expect(key('hls/720p/index.m3u8').startsWith('videos/')).toBe(false);
    });

    it('requires MEDIA.UPLOAD, the same permission as a fresh bundle', () => {
      expect(registry.resolve('movie-replace').permission).toBe('MEDIA.UPLOAD');
    });

    it.each([
      MovieStatus.PUBLISHED,
      MovieStatus.READY_TO_PUBLISH,
      MovieStatus.FAILED,
    ])('lets a %s movie stage a replacement', async (status) => {
      prisma.movie.findUnique.mockResolvedValue({ id: 'movie-1', status });
      await expect(
        registry.resolve('movie-replace').assertExists('movie-1'),
      ).resolves.toBeUndefined();
    });

    it.each([
      MovieStatus.DRAFT,
      MovieStatus.UPLOADING,
      MovieStatus.PROCESSING,
      MovieStatus.ARCHIVED,
    ])(
      'refuses with ConflictException to stage for a %s movie — presign-batch/multipart/init reject before a byte lands',
      async (status) => {
        prisma.movie.findUnique.mockResolvedValue({ id: 'movie-1', status });
        await expect(
          registry.resolve('movie-replace').assertExists('movie-1'),
        ).rejects.toThrow(ConflictException);
      },
    );

    it('throws NotFoundException for a movie that does not exist', async () => {
      prisma.movie.findUnique.mockResolvedValue(null);
      await expect(
        registry.resolve('movie-replace').assertExists('movie-1'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('REPLACEABLE_MOVIE_STATUSES', () => {
    it('is exactly the three states the owner allows a replacement for', () => {
      expect([...REPLACEABLE_MOVIE_STATUSES]).toEqual([
        MovieStatus.PUBLISHED,
        MovieStatus.READY_TO_PUBLISH,
        MovieStatus.FAILED,
      ]);
    });
  });

  describe('buildKey — book', () => {
    it('lands a chapter PDF under documents/, never under books/ (which holds generated reader output only)', () => {
      expect(
        registry
          .resolve('book')
          .buildKey('book-1', 'edition-1/chapter-1/original.pdf'),
      ).toBe('documents/books/book-1/edition-1/chapter-1/original.pdf');
    });
  });

  describe('buildKey — ad', () => {
    it('stages the one allowed file under temp/ads/<adId>/, never on a served key', () => {
      expect(registry.resolve('ad').buildKey('ad-1', 'video.mp4')).toBe(
        'temp/ads/ad-1/video.mp4',
      );
    });

    it('refuses any other filename or a nested path', () => {
      expect(() => registry.resolve('ad').buildKey('ad-1', 'clip.mp4')).toThrow(
        BadRequestException,
      );
      expect(() =>
        registry.resolve('ad').buildKey('ad-1', 'hls/video.mp4'),
      ).toThrow(BadRequestException);
    });

    it('needs the ad row and ADS.MANAGE', async () => {
      prisma.advertisement.findUnique.mockResolvedValue(null);
      await expect(registry.resolve('ad').assertExists('ad-1')).rejects.toThrow(
        NotFoundException,
      );
      permissionResolver.can.mockResolvedValue(false);
      await expect(registry.assertPermission('ad', user)).rejects.toThrow(
        ForbiddenException,
      );
      expect(permissionResolver.can).toHaveBeenCalledWith(user, 'ADS.MANAGE');
    });
  });

  describe('resolve / assertExists / assertPermission', () => {
    it('rejects an unknown resourceType', () => {
      expect(() => registry.resolve('podcast')).toThrow(NotFoundException);
    });

    it('throws when the owning row does not exist', async () => {
      prisma.movie.findUnique.mockResolvedValue(null);
      await expect(
        registry.resolve('movie').assertExists('movie-1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws when the caller lacks the type-specific permission', async () => {
      permissionResolver.can.mockResolvedValue(false);
      await expect(registry.assertPermission('book', user)).rejects.toThrow(
        ForbiddenException,
      );
      expect(permissionResolver.can).toHaveBeenCalledWith(user, 'BOOKS.EDIT');
    });
  });
});
