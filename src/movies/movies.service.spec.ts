import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { MoviesService } from './movies.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { MinioService } from '../common/storage/minio.service';
import { MovieStatus } from '../generated/prisma/client';

describe('MoviesService', () => {
  let service: MoviesService;
  let prisma: {
    movie: { create: jest.Mock; findUnique: jest.Mock; delete: jest.Mock };
    series: { findUnique: jest.Mock };
  };
  let minioService: {
    deleteByPrefix: jest.Mock;
    deleteObject: jest.Mock;
    keyFromPublicUrl: jest.Mock;
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    prisma = {
      movie: { create: jest.fn(), findUnique: jest.fn(), delete: jest.fn() },
      series: { findUnique: jest.fn() },
    };
    minioService = {
      deleteByPrefix: jest.fn().mockResolvedValue(undefined),
      deleteObject: jest.fn().mockResolvedValue(undefined),
      keyFromPublicUrl: jest.fn((url: string) => `images/${url.split('/').pop()}`),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MoviesService,
        { provide: PrismaService, useValue: prisma },
        { provide: WalletService, useValue: {} },
        { provide: MinioService, useValue: minioService },
      ],
    }).compile();

    service = module.get(MoviesService);
  });

  describe('createUploadPlaceholder', () => {
    it(
      'creates a movie with only the given title populated and every other ' +
        'field defaulted, starting at UPLOADING — the bulk upload flow only knows the title at this point',
      async () => {
        prisma.movie.create.mockResolvedValue({ id: 'movie-1', title: 'My Cool Movie', status: MovieStatus.UPLOADING });

        const result = await service.createUploadPlaceholder('My Cool Movie');

        expect(prisma.movie.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            title: 'My Cool Movie',
            description: '',
            genre: '',
            language: '',
            duration: 0,
            price: 0,
            isPremium: true,
            status: MovieStatus.UPLOADING,
          }),
        });
        expect(result).toEqual({ id: 'movie-1', title: 'My Cool Movie', status: MovieStatus.UPLOADING });
      },
    );

    it('never sets status to PUBLISHED — that only ever happens via an explicit admin action', async () => {
      prisma.movie.create.mockResolvedValue({ id: 'movie-1' });

      await service.createUploadPlaceholder('Anything');

      const callData = prisma.movie.create.mock.calls[0][0].data;
      expect(callData.status).toBe(MovieStatus.UPLOADING);
      expect(callData.status).not.toBe(MovieStatus.PUBLISHED);
    });

    it('as an episode: throws NotFoundException when the series does not exist, without creating anything', async () => {
      prisma.series.findUnique.mockResolvedValue(null);

      await expect(
        service.createUploadPlaceholder('Episode 1', { seriesId: 'series-1', seasonNumber: 1, episodeNumber: 1 }),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.movie.create).not.toHaveBeenCalled();
    });

    it('as an episode: carries season/episode position and inherits genre/language/releaseYear from the show', async () => {
      prisma.series.findUnique.mockResolvedValue({
        id: 'series-1',
        genre: 'Drama',
        language: 'Burmese',
        releaseYear: 2020,
      });
      prisma.movie.create.mockResolvedValue({ id: 'movie-1' });

      await service.createUploadPlaceholder('Episode 3', { seriesId: 'series-1', seasonNumber: 2, episodeNumber: 3 });

      expect(prisma.movie.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          title: 'Episode 3',
          seriesId: 'series-1',
          seasonNumber: 2,
          episodeNumber: 3,
          genre: 'Drama',
          language: 'Burmese',
          releaseYear: 2020,
          status: MovieStatus.UPLOADING,
        }),
      });
    });

    it('as a standalone movie: leaves every series field unset', async () => {
      prisma.movie.create.mockResolvedValue({ id: 'movie-1' });

      await service.createUploadPlaceholder('Just A Movie');

      const callData = prisma.movie.create.mock.calls[0][0].data;
      expect(callData.seriesId).toBeUndefined();
      expect(callData.seasonNumber).toBeUndefined();
      expect(callData.episodeNumber).toBeUndefined();
      expect(prisma.series.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('purchase', () => {
    it('rejects buying an individual episode — the whole series is the product, never single episodes', async () => {
      prisma.movie.findUnique.mockResolvedValue({
        id: 'movie-1',
        status: MovieStatus.PUBLISHED,
        seriesId: 'series-1',
      });

      await expect(service.purchase('user-1', 'movie-1')).rejects.toThrow(ConflictException);
    });
  });

  describe('remove', () => {
    it('throws NotFoundException when the movie does not exist', async () => {
      prisma.movie.findUnique.mockResolvedValue(null);

      await expect(service.remove('movie-1')).rejects.toThrow(NotFoundException);
      expect(prisma.movie.delete).not.toHaveBeenCalled();
    });

    it('deletes the DB row, then cleans up its whole videos/<id>/ tree and its three images in storage', async () => {
      prisma.movie.findUnique.mockResolvedValue({
        id: 'movie-1',
        posterUrl: 'http://cache/movies/images/poster.jpg',
        coverUrl: 'http://cache/movies/images/cover.jpg',
        thumbnailUrl: 'http://cache/movies/images/thumb.jpg',
        videos: [],
      });

      await service.remove('movie-1');

      expect(prisma.movie.delete).toHaveBeenCalledWith({ where: { id: 'movie-1' } });
      expect(minioService.deleteByPrefix).toHaveBeenCalledWith('videos/movie-1/');
      expect(minioService.deleteObject).toHaveBeenCalledWith('images/poster.jpg');
      expect(minioService.deleteObject).toHaveBeenCalledWith('images/cover.jpg');
      expect(minioService.deleteObject).toHaveBeenCalledWith('images/thumb.jpg');
    });

    it('skips any image field that was never set, instead of trying to delete a null URL', async () => {
      prisma.movie.findUnique.mockResolvedValue({
        id: 'movie-1',
        posterUrl: null,
        coverUrl: null,
        thumbnailUrl: null,
        videos: [],
      });

      await service.remove('movie-1');

      expect(minioService.deleteObject).not.toHaveBeenCalled();
    });

    it(
      'deletes a manually-uploaded subtitle (global subtitles/<id>/ prefix) individually, but does not ' +
        'double-delete a bundle-detected one that the videos/<movieId>/ prefix delete already caught',
      async () => {
        prisma.movie.findUnique.mockResolvedValue({
          id: 'movie-1',
          posterUrl: null,
          coverUrl: null,
          thumbnailUrl: null,
          videos: [
            {
              id: 'video-1',
              subtitles: [
                { objectKey: 'subtitles/sub-1/original.vtt' }, // manually uploaded — separate global prefix
                { objectKey: 'videos/movie-1/subtitles/english.vtt' }, // bundle-detected — already under the deleted prefix
              ],
            },
          ],
        });

        await service.remove('movie-1');

        expect(minioService.deleteObject).toHaveBeenCalledWith('subtitles/sub-1/original.vtt');
        expect(minioService.deleteObject).not.toHaveBeenCalledWith('videos/movie-1/subtitles/english.vtt');
      },
    );

    it('still deletes the movie even if storage cleanup fails — a storage hiccup must not block removing it from the catalog', async () => {
      prisma.movie.findUnique.mockResolvedValue({ id: 'movie-1', posterUrl: null, coverUrl: null, thumbnailUrl: null, videos: [] });
      minioService.deleteByPrefix.mockRejectedValue(new Error('storage server unreachable'));

      await expect(service.remove('movie-1')).resolves.toBeUndefined();
      expect(prisma.movie.delete).toHaveBeenCalledWith({ where: { id: 'movie-1' } });
    });
  });
});
