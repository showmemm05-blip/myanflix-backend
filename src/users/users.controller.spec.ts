import { Test, TestingModule } from '@nestjs/testing';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import type { App } from 'supertest/types';
import { Role, UserStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/storage/minio.service';
import { MoviesService } from '../movies/movies.service';
import { VideosService } from '../videos/videos.service';
import { WalletAdjustmentsService } from '../wallet/wallet-adjustments.service';
import { PermissionsGuard } from '../roles/guards/permissions.guard';
import { AuthorityService } from '../roles/authority.service';
import { PermissionResolverService } from '../roles/permission-resolver.service';
import { createSeededPermissionResolver } from '../../test/seeded-permission-resolver';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { UserRelationshipsService } from './user-relationships.service';

const USER_ID = 'a3c9d7f0-1111-2222-3333-444455556666';

function makeUserRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: USER_ID,
    username: 'john',
    password: 'hashed',
    phone: null,
    displayName: null,
    avatar: null,
    role: Role.USER,
    status: UserStatus.ACTIVE,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    lastLoginAt: null,
    ...overrides,
  };
}

/** Stands in for the authenticated request — attaches the same shape the JWT strategy produces. */
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<{ user?: Record<string, unknown> }>();
    req.user = {
      id: USER_ID,
      username: 'john',
      role: Role.USER,
      appRoleId: null,
    };
    return true;
  }
}

/** Cheap stand-in for a real stored hash — 4 rounds keeps the suite fast. */
const CURRENT_PASSWORD = 'current-password';
const CURRENT_PASSWORD_HASH = bcrypt.hashSync(CURRENT_PASSWORD, 4);

describe('UsersController — self-service "me" routes (profile, password, avatar)', () => {
  let app: INestApplication<App>;
  let prisma: {
    user: { findUnique: jest.Mock; update: jest.Mock };
    wallet: { findUnique: jest.Mock };
    transaction: { aggregate: jest.Mock };
    userSubscription: { findFirst: jest.Mock };
  };
  let minio: {
    uploadBuffer: jest.Mock;
    deleteObject: jest.Mock;
    playbackUrl: jest.Mock;
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    // A one-row stand-in for the users table: `update` mutates it and
    // `findUnique` reads it back, the way the real Prisma client behaves when
    // a route writes and then re-reads the profile (PATCH /users/me does).
    // Tests that need a different starting row still override findUnique.
    let row = makeUserRow();
    prisma = {
      user: {
        findUnique: jest.fn(() => Promise.resolve(row)),
        update: jest
          .fn()
          .mockImplementation(({ data }: { data: Record<string, unknown> }) => {
            row = makeUserRow({ ...row, ...data });
            return Promise.resolve(row);
          }),
      },
      wallet: { findUnique: jest.fn().mockResolvedValue(null) },
      transaction: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: null } }),
      },
      userSubscription: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    minio = {
      uploadBuffer: jest.fn().mockResolvedValue(undefined),
      deleteObject: jest.fn().mockResolvedValue(undefined),
      playbackUrl: jest.fn(
        (key: string) => `http://cache.test:8080/movies/${key}`,
      ),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        UsersService,
        // UsersService's escalation guards for PATCH /users/:id/role; none of
        // the avatar routes reach them (their own spec covers those).
        AuthorityService,
        { provide: PrismaService, useValue: prisma },
        { provide: MinioService, useValue: minio },
        { provide: MoviesService, useValue: {} },
        { provide: VideosService, useValue: {} },
        { provide: WalletAdjustmentsService, useValue: {} },
        // Constructor dependency of UsersController (GET /users/relationships)
        // — the real class, since its only dependency is the mocked Prisma.
        // Its own behavior is covered by user-relationships.service.spec.ts.
        UserRelationshipsService,
        {
          provide: PermissionResolverService,
          useValue: createSeededPermissionResolver(),
        },
      ],
    })
      .overrideGuard(PermissionsGuard)
      .useClass(FakeAuthGuard)
      .compile();

    app = moduleFixture.createNestApplication();
    // Same configuration as the global APP_PIPE in app.module.ts — the
    // profile DTOs (trimming, length limits, forbidNonWhitelisted) are only
    // meaningful with it in place.
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

  // Real file signatures — uploadAvatar verifies magic bytes, not just the
  // declared Content-Type.
  const PNG_BYTES = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('png-payload'),
  ]);
  const JPEG_BYTES = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.from('jpeg-payload'),
  ]);
  const WEBP_BYTES = Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.from([0x2a, 0x00, 0x00, 0x00]),
    Buffer.from('WEBP'),
    Buffer.from('webp-payload'),
  ]);

  describe('POST /users/me/avatar', () => {
    it('uploads the image under a versioned images/avatars/ key and responds with the profile shape (avatarUrl, never the raw key)', async () => {
      const response = await request(app.getHttpServer())
        .post('/users/me/avatar')
        .attach('file', PNG_BYTES, {
          filename: 'photo.png',
          contentType: 'image/png',
        })
        .expect(201);

      expect(minio.uploadBuffer).toHaveBeenCalledTimes(1);
      const [uploadedKey] = minio.uploadBuffer.mock.calls[0] as [
        string,
        Buffer,
      ];
      expect(uploadedKey).toMatch(
        new RegExp(`^images/avatars/${USER_ID}-\\d+\\.png$`),
      );
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: { avatar: uploadedKey },
      });

      expect(response.body.avatarUrl).toBe(
        `http://cache.test:8080/movies/${uploadedKey}`,
      );
      expect(response.body).not.toHaveProperty('avatar');
      expect(response.body.id).toBe(USER_ID);
      expect(response.body.username).toBe('john');
      // Same shape as GET /users/me — the wallet summary rides along.
      expect(response.body.balance).toBe(0);
    });

    it('derives the object-key extension from the validated MIME type, never from the client filename', async () => {
      await request(app.getHttpServer())
        .post('/users/me/avatar')
        .attach('file', WEBP_BYTES, {
          filename: 'totally-a-photo.exe',
          contentType: 'image/webp',
        })
        .expect(201);

      const [uploadedKey] = minio.uploadBuffer.mock.calls[0] as [
        string,
        Buffer,
      ];
      expect(uploadedKey).toMatch(/\.webp$/);
      expect(uploadedKey).not.toContain('exe');
    });

    it('rejects a non-whitelisted MIME type with 400 and never touches storage', async () => {
      await request(app.getHttpServer())
        .post('/users/me/avatar')
        .attach('file', Buffer.from('GIF89a...'), {
          filename: 'anim.gif',
          contentType: 'image/gif',
        })
        .expect(400);

      expect(minio.uploadBuffer).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('rejects a whitelisted MIME whose bytes are not actually that format (spoofed Content-Type) with 400', async () => {
      await request(app.getHttpServer())
        .post('/users/me/avatar')
        .attach('file', Buffer.from('#!/bin/sh\necho pwned'), {
          filename: 'photo.png',
          contentType: 'image/png',
        })
        .expect(400);

      expect(minio.uploadBuffer).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('rejects a missing file with 400', async () => {
      await request(app.getHttpServer()).post('/users/me/avatar').expect(400);

      expect(minio.uploadBuffer).not.toHaveBeenCalled();
    });

    it('rejects a file over 5 MB via the interceptor limits before any storage work', async () => {
      await request(app.getHttpServer())
        .post('/users/me/avatar')
        .attach('file', Buffer.alloc(5 * 1024 * 1024 + 1), {
          filename: 'huge.png',
          contentType: 'image/png',
        })
        .expect(413);

      expect(minio.uploadBuffer).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('best-effort deletes the previous avatar object when replacing', async () => {
      const oldKey = `images/avatars/${USER_ID}-1000.jpg`;
      prisma.user.findUnique.mockResolvedValue(makeUserRow({ avatar: oldKey }));

      await request(app.getHttpServer())
        .post('/users/me/avatar')
        .attach('file', JPEG_BYTES, {
          filename: 'photo.jpg',
          contentType: 'image/jpeg',
        })
        .expect(201);

      expect(minio.deleteObject).toHaveBeenCalledWith(oldKey);
    });

    it('never deletes a previous key that is not under images/avatars/', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUserRow({ avatar: 'videos/movie-1/original.mp4' }),
      );

      await request(app.getHttpServer())
        .post('/users/me/avatar')
        .attach('file', PNG_BYTES, {
          filename: 'photo.png',
          contentType: 'image/png',
        })
        .expect(201);

      expect(minio.deleteObject).not.toHaveBeenCalled();
    });

    it('still succeeds when deleting the previous object fails (delete is best-effort)', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUserRow({ avatar: `images/avatars/${USER_ID}-1000.png` }),
      );
      minio.deleteObject.mockRejectedValue(new Error('minio down'));

      const response = await request(app.getHttpServer())
        .post('/users/me/avatar')
        .attach('file', PNG_BYTES, {
          filename: 'photo.png',
          contentType: 'image/png',
        })
        .expect(201);

      expect(response.body.avatarUrl).toMatch(/^http:\/\/cache\.test:8080/);
    });
  });

  describe('DELETE /users/me/avatar', () => {
    it('clears the avatar, best-effort deletes the old object, and responds with avatarUrl null', async () => {
      const oldKey = `images/avatars/${USER_ID}-1000.png`;
      prisma.user.findUnique.mockResolvedValue(makeUserRow({ avatar: oldKey }));

      const response = await request(app.getHttpServer())
        .delete('/users/me/avatar')
        .expect(200);

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: { avatar: null },
      });
      expect(minio.deleteObject).toHaveBeenCalledWith(oldKey);
      expect(response.body.avatarUrl).toBeNull();
      expect(response.body).not.toHaveProperty('avatar');
    });

    it('is a harmless no-op on storage when there was no avatar to begin with', async () => {
      await request(app.getHttpServer()).delete('/users/me/avatar').expect(200);

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: { avatar: null },
      });
      expect(minio.deleteObject).not.toHaveBeenCalled();
    });
  });
  describe('PATCH /users/me', () => {
    it('trims the display name, persists it, and responds with the full GET /users/me shape', async () => {
      const response = await request(app.getHttpServer())
        .patch('/users/me')
        .send({ displayName: '  Ada Lovelace  ' })
        .expect(200);

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: { displayName: 'Ada Lovelace' },
      });
      expect(response.body.displayName).toBe('Ada Lovelace');
      // Wholesale-replaceable: the same fields GET /users/me returns.
      expect(response.body.id).toBe(USER_ID);
      expect(response.body.username).toBe('john');
      expect(response.body.avatarUrl).toBeNull();
      expect(response.body.balance).toBe(0);
      expect(Array.isArray(response.body.permissions)).toBe(true);
      expect(response.body.roleName).toBeTruthy();
      expect(response.body).not.toHaveProperty('password');
      expect(response.body).not.toHaveProperty('avatar');
    });

    it('clears the display name when an explicit null is sent', async () => {
      await request(app.getHttpServer())
        .patch('/users/me')
        .send({ displayName: 'Ada' })
        .expect(200);

      const response = await request(app.getHttpServer())
        .patch('/users/me')
        .send({ displayName: null })
        .expect(200);

      expect(prisma.user.update).toHaveBeenLastCalledWith({
        where: { id: USER_ID },
        data: { displayName: null },
      });
      expect(response.body.displayName).toBeNull();
    });

    it('leaves the row untouched when displayName is omitted entirely', async () => {
      await request(app.getHttpServer())
        .patch('/users/me')
        .send({})
        .expect(200);

      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('rejects a whitespace-only display name with 400 and writes nothing', async () => {
      const response = await request(app.getHttpServer())
        .patch('/users/me')
        .send({ displayName: '   ' })
        .expect(400);

      expect(String(response.body.message)).toContain('1 and 40 characters');
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('rejects a display name longer than 40 characters with 400', async () => {
      await request(app.getHttpServer())
        .patch('/users/me')
        .send({ displayName: 'a'.repeat(41) })
        .expect(400);

      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('accepts exactly 40 characters (the boundary is inclusive)', async () => {
      const name = 'a'.repeat(40);
      const response = await request(app.getHttpServer())
        .patch('/users/me')
        .send({ displayName: name })
        .expect(200);

      expect(response.body.displayName).toBe(name);
    });

    it('rejects a non-string display name with 400', async () => {
      await request(app.getHttpServer())
        .patch('/users/me')
        .send({ displayName: 42 })
        .expect(400);

      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('refuses to edit the login identities — username and phone are not accepted here', async () => {
      await request(app.getHttpServer())
        .patch('/users/me')
        .send({ displayName: 'Ada', username: 'someone-else' })
        .expect(400);

      await request(app.getHttpServer())
        .patch('/users/me')
        .send({ phone: '+959123456789' })
        .expect(400);

      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /users/me/password', () => {
    beforeEach(() => {
      prisma.user.findUnique.mockResolvedValue(
        makeUserRow({ password: CURRENT_PASSWORD_HASH }),
      );
    });

    it('replaces the stored hash when the current password matches, and responds { changed: true }', async () => {
      const response = await request(app.getHttpServer())
        .patch('/users/me/password')
        .send({
          currentPassword: CURRENT_PASSWORD,
          newPassword: 'brand-new-password',
        })
        .expect(200);

      expect(response.body).toEqual({ changed: true });
      expect(prisma.user.update).toHaveBeenCalledTimes(1);
      const { where, data } = prisma.user.update.mock.calls[0][0] as {
        where: { id: string };
        data: { password: string };
      };
      expect(where).toEqual({ id: USER_ID });
      // Hashed, never stored in the clear, and it verifies against the new password.
      expect(data.password).not.toBe('brand-new-password');
      expect(await bcrypt.compare('brand-new-password', data.password)).toBe(
        true,
      );
    });

    it('rejects a wrong current password with 400 and never writes', async () => {
      const response = await request(app.getHttpServer())
        .patch('/users/me/password')
        .send({
          currentPassword: 'not-my-password',
          newPassword: 'brand-new-password',
        })
        .expect(400);

      expect(String(response.body.message)).toBe(
        'Your current password is incorrect',
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('rejects a new password shorter than 8 characters with 400 and never writes', async () => {
      const response = await request(app.getHttpServer())
        .patch('/users/me/password')
        .send({ currentPassword: CURRENT_PASSWORD, newPassword: 'short7c' })
        .expect(400);

      expect(String(response.body.message)).toContain('at least 8 characters');
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('rejects a missing current password with 400', async () => {
      await request(app.getHttpServer())
        .patch('/users/me/password')
        .send({ newPassword: 'brand-new-password' })
        .expect(400);

      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });
});
