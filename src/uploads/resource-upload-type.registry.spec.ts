import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ResourceUploadTypeRegistry } from './resource-upload-type.registry';
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
