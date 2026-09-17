import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import type { App } from 'supertest/types';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  AccessType,
  BookStatus,
  BookType,
  ChapterStatus,
  MovieStatus,
  Role,
  SubtitleFormat,
  UserStatus,
  VideoStatus,
} from '../src/generated/prisma/client';

interface Envelope<T> {
  success: boolean;
  data: T;
}

interface StreamInfo {
  playlistUrl: string;
  subtitles: { id: string; url: string }[];
}

interface PageItem {
  pageNumber: number;
  url: string;
}

/**
 * The stream grant end to end: the real AppModule (global JwtAuthGuard,
 * real subscription check) against the isolated e2e database. What is
 * proven here is that a subscribed member's stream response carries ONLY
 * signed `/s/<expires>/<sig>/` playback URLs — the cache server refuses
 * anything else — that an unsubscribed member still gets the 403, and that
 * book pages come back signed the same way. Guest -> 401 is already covered
 * by guest-catalog.e2e-spec.ts.
 */
describe('Stream grant (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let configService: ConfigService;

  let subscribedUserId: string;
  let subscribedToken: string;
  let unsubscribedUserId: string;
  let unsubscribedToken: string;
  let planId: string;
  let movieId: string;
  let subtitleId: string;
  let bulkSubtitleId: string;
  let bookId: string;
  let editionId: string;
  let chapterId: string;

  async function signToken(id: string): Promise<string> {
    return jwtService.signAsync(
      { sub: id },
      { secret: configService.get<string>('JWT_SECRET'), expiresIn: '15m' },
    );
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    // Pipe/filter/interceptor are registered globally by AppModule — see
    // the note in deposits.e2e-spec.ts.
    app.setGlobalPrefix('api');
    await app.init();

    prisma = app.get(PrismaService);
    jwtService = app.get(JwtService);
    configService = app.get(ConfigService);

    const suffix = randomUUID().slice(0, 8);

    const subscribed = await prisma.user.create({
      data: {
        username: `stream_sub_${suffix}`,
        password: 'unused-in-these-tests',
        role: Role.USER,
        status: UserStatus.ACTIVE,
      },
    });
    subscribedUserId = subscribed.id;
    subscribedToken = await signToken(subscribed.id);

    const unsubscribed = await prisma.user.create({
      data: {
        username: `stream_nosub_${suffix}`,
        password: 'unused-in-these-tests',
        role: Role.USER,
        status: UserStatus.ACTIVE,
      },
    });
    unsubscribedUserId = unsubscribed.id;
    unsubscribedToken = await signToken(unsubscribed.id);

    const plan = await prisma.subscriptionPlan.create({
      data: { name: `Stream plan ${suffix}`, price: 5000, durationDays: 30 },
    });
    planId = plan.id;
    await prisma.userSubscription.create({
      data: {
        userId: subscribedUserId,
        planId,
        amount: plan.price,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });

    const movie = await prisma.movie.create({
      data: {
        title: `Signed stream ${suffix}`,
        description: 'stream grant fixture',
        genre: 'Action',
        language: 'Burmese',
        releaseYear: 2026,
        duration: 100,
        accessType: AccessType.SUBSCRIPTION,
        status: MovieStatus.PUBLISHED,
      },
    });
    movieId = movie.id;

    // The exact key shapes the real pipeline persists (StorageService
    // hlsMasterKey / SubtitlesService) — anything else is unsignable.
    const video = await prisma.video.create({
      data: {
        movieId,
        originalFilename: 'fixture.mp4',
        originalPath: `videos/${movieId}/original.mp4`,
        status: VideoStatus.READY,
        duration: 6000,
        resolution: '1920x1080',
        hlsMasterPath: `videos/${movieId}/hls/master.m3u8`,
        renditions: [
          {
            resolution: '720p',
            playlistPath: `videos/${movieId}/hls/720p/index.m3u8`,
          },
        ],
      },
    });
    subtitleId = randomUUID();
    await prisma.subtitle.create({
      data: {
        id: subtitleId,
        videoId: video.id,
        language: 'en',
        label: 'English',
        format: SubtitleFormat.SRT,
        objectKey: `subtitles/${movieId}/${subtitleId}.srt`,
        isDefault: true,
      },
    });
    // Both ingest paths write into the same movie-keyed source folder, but
    // with different filenames: the single upload names the file after the
    // subtitle id (above), while the bulk/external bundle keeps the
    // operator's own basename (ResourceUploadTypeRegistry.buildKey ->
    // `subtitles/${movieId}/<name>.srt`). /stream signs every subtitle url,
    // so both filenames have to sign under the one `subtitles/<movieId>`
    // scope or the whole lookup 500s.
    bulkSubtitleId = randomUUID();
    await prisma.subtitle.create({
      data: {
        id: bulkSubtitleId,
        videoId: video.id,
        language: 'my',
        label: 'Myanmar',
        format: SubtitleFormat.SRT,
        objectKey: `subtitles/${movieId}/myanmar.srt`,
        isDefault: false,
      },
    });

    const book = await prisma.book.create({
      data: {
        title: `Signed pages ${suffix}`,
        author: 'Fixture Author',
        description: 'stream grant fixture',
        type: BookType.PDF,
      },
    });
    bookId = book.id;
    const edition = await prisma.bookEdition.create({
      data: {
        bookId,
        language: 'Burmese',
        status: BookStatus.PUBLISHED,
        publishedAt: new Date(),
      },
    });
    editionId = edition.id;
    const chapter = await prisma.bookChapter.create({
      data: {
        editionId,
        title: 'Chapter 1',
        order: 1,
        status: ChapterStatus.READY,
        pageCount: 2,
        processedPages: 2,
      },
    });
    chapterId = chapter.id;
    await prisma.bookPage.createMany({
      data: [1, 2].map((pageNumber) => ({
        chapterId,
        pageNumber,
        imageKey: `books/${bookId}/${editionId}/${chapterId}/pages/page-${String(pageNumber).padStart(3, '0')}.webp`,
        width: 1200,
        height: 1800,
        fileSize: 100_000,
      })),
    });
  });

  afterAll(async () => {
    // Isolated test database — safe to hard-delete everything this suite
    // made. Video/subtitle/page rows cascade from their parents.
    await prisma.movie.deleteMany({ where: { id: movieId } });
    await prisma.book.deleteMany({ where: { id: bookId } });
    await prisma.user.deleteMany({
      where: { id: { in: [subscribedUserId, unsubscribedUserId] } },
    });
    await prisma.subscriptionPlan.deleteMany({ where: { id: planId } });
    await app.close();
  });

  const api = () => request(app.getHttpServer());

  describe('GET /videos/:id/stream', () => {
    it('subscribed USER: 200 with a signed playlist URL and nothing unsigned anywhere', async () => {
      const res = await api()
        .get(`/api/videos/${movieId}/stream`)
        .set('Authorization', `Bearer ${subscribedToken}`)
        .expect(200);

      const body = res.body as Envelope<StreamInfo>;
      expect(body.data.playlistUrl).toMatch(
        new RegExp(
          `/s/\\d+/[\\w-]+/movies/videos/${movieId}/hls/master\\.m3u8$`,
        ),
      );
      expect(body.data.subtitles).toHaveLength(2);
      const byId = new Map(body.data.subtitles.map((s) => [s.id, s.url]));
      expect(byId.get(subtitleId)).toMatch(
        new RegExp(
          `/s/\\d+/[\\w-]+/movies/subtitles/${movieId}/${subtitleId}\\.srt$`,
        ),
      );
      expect(byId.get(bulkSubtitleId)).toMatch(
        new RegExp(`/s/\\d+/[\\w-]+/movies/subtitles/${movieId}/myanmar\\.srt$`),
      );

      // Not a single plain (token-less) bucket URL in the whole payload.
      const text = JSON.stringify(body);
      expect(text).not.toMatch(/:\/\/[^/"]+\/movies\//);
    });

    it('unsubscribed USER: 403 with the existing message', async () => {
      const res = await api()
        .get(`/api/videos/${movieId}/stream`)
        .set('Authorization', `Bearer ${unsubscribedToken}`)
        .expect(403);

      expect(JSON.stringify(res.body)).toContain(
        'An active subscription is required to start streaming',
      );
    });

    it('guest: 401', async () => {
      await api().get(`/api/videos/${movieId}/stream`).expect(401);
    });
  });

  describe('GET /books/:id/editions/:editionId/chapters/:chapterId/pages', () => {
    it('member: every page url is signed with the chapter scope', async () => {
      const res = await api()
        .get(
          `/api/books/${bookId}/editions/${editionId}/chapters/${chapterId}/pages`,
        )
        .set('Authorization', `Bearer ${unsubscribedToken}`)
        .expect(200);

      const body = res.body as Envelope<PageItem[]>;
      expect(body.data.map((page) => page.pageNumber)).toEqual([1, 2]);
      for (const page of body.data) {
        expect(page.url).toMatch(
          new RegExp(
            `/s/\\d+/[\\w-]+/movies/books/${bookId}/${editionId}/${chapterId}/pages/page-\\d+\\.webp$`,
          ),
        );
      }
      // One chapter-scoped token shared by the whole array.
      const tokens = new Set(
        body.data.map((page) => /\/s\/(\d+\/[\w-]+)\//.exec(page.url)?.[1]),
      );
      expect(tokens.size).toBe(1);
    });

    it('guest: 401', async () => {
      await api()
        .get(
          `/api/books/${bookId}/editions/${editionId}/chapters/${chapterId}/pages`,
        )
        .expect(401);
    });
  });
});
