import { Test, TestingModule } from '@nestjs/testing';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  Injectable,
  ValidationPipe,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import request from 'supertest';
import type { App } from 'supertest/types';
import { MovieStatus, Role } from '../generated/prisma/client';
import { MinioService } from '../common/storage/minio.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthorityService } from '../roles/authority.service';
import { PermissionResolverService } from '../roles/permission-resolver.service';
import {
  createRoleAwarePermissionResolver,
  seededRoleRow,
} from '../../test/seeded-permission-resolver';
import { MoviesController } from './movies.controller';
import { MoviesService } from './movies.service';

const MOVIE_ID = '22222222-2222-4222-8222-222222222222';

/**
 * Stands in for the global JwtAuthGuard: `x-test-role` picks the account kind
 * and the optional `x-test-app-role` puts the caller on a custom AppRole. The
 * real PermissionsGuard then runs unmocked, so these cases prove both halves
 * of F11 — the new gate refuses an edit-only role, and the seeded roles that
 * publish movies today keep publishing them.
 */
@Injectable()
class FakeJwtAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      user?: Record<string, unknown>;
    }>();
    req.user = {
      id: 'admin-1',
      username: 'boss',
      role: req.headers['x-test-role'] ?? Role.SUPER_ADMIN,
      appRoleId: req.headers['x-test-app-role'] ?? null,
    };
    return true;
  }
}

describe('MoviesController — publish/unpublish gate (F11)', () => {
  let app: INestApplication<App>;
  let moviesService: { getStatusOrThrow: jest.Mock; update: jest.Mock };

  const movieRow = {
    id: MOVIE_ID,
    title: 'A Movie',
    description: '',
    posterUrl: null,
    coverUrl: null,
    thumbnailUrl: null,
    genre: '',
    language: '',
    releaseYear: 2026,
    duration: 100,
    rating: null,
    accessType: 'FREE',
    status: MovieStatus.PUBLISHED,
    seriesId: null,
    seasonNumber: null,
    episodeNumber: null,
    categories: [],
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  };

  beforeEach(async () => {
    moviesService = {
      getStatusOrThrow: jest.fn().mockResolvedValue(MovieStatus.DRAFT),
      update: jest.fn().mockResolvedValue(movieRow),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [MoviesController],
      providers: [
        AuthorityService,
        { provide: MoviesService, useValue: moviesService },
        { provide: MinioService, useValue: { imageUrl: (u: string) => u } },
        {
          provide: PermissionResolverService,
          useValue: createRoleAwarePermissionResolver([
            seededRoleRow(Role.SUPER_ADMIN, 'role-super'),
            seededRoleRow(Role.ADMIN, 'role-admin'),
            seededRoleRow(Role.CONTENT_UPLOADER, 'role-uploader'),
            seededRoleRow(Role.USER, 'role-user'),
            // A plausible custom role: may edit the catalogue, may not decide
            // what the public sees.
            {
              id: 'role-editor',
              key: 'CATALOGUE_EDITOR',
              permissions: ['MOVIES.VIEW', 'MOVIES.EDIT'],
            },
          ]),
        },
        // AuthorityService's other dependency — this route never reaches it.
        { provide: PrismaService, useValue: {} },
        { provide: APP_GUARD, useClass: FakeJwtAuthGuard },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const asEditor = (test: request.Test) =>
    test.set('x-test-role', Role.ADMIN).set('x-test-app-role', 'role-editor');

  it('F11: refuses to publish a movie with only MOVIES.EDIT', async () => {
    moviesService.getStatusOrThrow.mockResolvedValue(MovieStatus.DRAFT);

    await asEditor(
      request(app.getHttpServer())
        .put(`/movies/${MOVIE_ID}`)
        .send({ status: MovieStatus.PUBLISHED }),
    ).expect(403);

    expect(moviesService.update).not.toHaveBeenCalled();
  });

  it('F11: refuses to unpublish a movie with only MOVIES.EDIT', async () => {
    moviesService.getStatusOrThrow.mockResolvedValue(MovieStatus.PUBLISHED);

    await asEditor(
      request(app.getHttpServer())
        .put(`/movies/${MOVIE_ID}`)
        .send({ status: MovieStatus.ARCHIVED }),
    ).expect(403);

    expect(moviesService.update).not.toHaveBeenCalled();
  });

  it('F11: still allows an ordinary field edit with only MOVIES.EDIT', async () => {
    await asEditor(
      request(app.getHttpServer())
        .put(`/movies/${MOVIE_ID}`)
        .send({ title: 'Renamed' }),
    ).expect(200);

    expect(moviesService.update).toHaveBeenCalled();
    // No status in the payload — the gate must not even look the movie up.
    expect(moviesService.getStatusOrThrow).not.toHaveBeenCalled();
  });

  it('F11: still allows editing a PUBLISHED movie that stays published', async () => {
    moviesService.getStatusOrThrow.mockResolvedValue(MovieStatus.PUBLISHED);

    await asEditor(
      request(app.getHttpServer())
        .put(`/movies/${MOVIE_ID}`)
        .send({ title: 'Renamed', status: MovieStatus.PUBLISHED }),
    ).expect(200);

    expect(moviesService.update).toHaveBeenCalled();
  });

  it.each([Role.ADMIN, Role.CONTENT_UPLOADER])(
    'F11: %s still publishes movies — the seeds grant PUBLISH to every role with EDIT',
    async (role) => {
      moviesService.getStatusOrThrow.mockResolvedValue(MovieStatus.DRAFT);

      await request(app.getHttpServer())
        .put(`/movies/${MOVIE_ID}`)
        .set('x-test-role', role)
        .send({ status: MovieStatus.PUBLISHED })
        .expect(200);

      expect(moviesService.update).toHaveBeenCalled();
    },
  );

  it.each([Role.ADMIN, Role.CONTENT_UPLOADER])(
    'F11: %s still unpublishes movies',
    async (role) => {
      moviesService.getStatusOrThrow.mockResolvedValue(MovieStatus.PUBLISHED);

      await request(app.getHttpServer())
        .put(`/movies/${MOVIE_ID}`)
        .set('x-test-role', role)
        .send({ status: MovieStatus.DRAFT })
        .expect(200);

      expect(moviesService.update).toHaveBeenCalled();
    },
  );
});
