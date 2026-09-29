import { Test, TestingModule } from '@nestjs/testing';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MovieStatus } from '../generated/prisma/client';
import {
  REPLACEABLE_MOVIE_STATUSES,
  ResourceUploadTypeRegistry,
} from './resource-upload-type.registry';
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
  };
  let permissionResolver: { can: jest.Mock };

  const user = { id: 'admin-1', role: 'ADMIN' } as never;

  beforeEach(async () => {
    jest.clearAllMocks();

    prisma = {
      movie: { findUnique: jest.fn().mockResolvedValue({ id: 'movie-1' }) },
      book: { findUnique: jest.fn().mockResolvedValue({ id: 'book-1' }) },
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
