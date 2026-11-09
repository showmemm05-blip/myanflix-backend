import { Logger } from '@nestjs/common';
import sharp from 'sharp';
import {
  IMAGE_UPLOAD_UNSUPPORTED_TYPE_CODE,
  ImageStoreService,
} from './image-store.service';
import { isTmdbImageKey } from './image-source';
import { Role } from '../generated/prisma/client';
import type { AuditService } from '../audit/audit.service';
import type { MinioService } from '../common/storage/minio.service';
import type { StorageService } from '../common/storage/storage.service';

/** A staff actor for the audit calls — the mocked AuditService records nothing. */
const ACTOR = {
  id: 'admin-1',
  username: 'boss',
  role: Role.ADMIN,
  appRoleId: null,
} as const;

/**
 * The image store both POST /uploads/image (through UploadsService.saveImage)
 * and the TMDB module save pictures with. The staff-upload cases moved here
 * unchanged from uploads.service.spec.ts when the code was lifted out of
 * UploadsService: a staff upload must behave exactly as it did there. The
 * last block covers the one thing that is new — a picture marked as fetched
 * from TMDB.
 */
describe('ImageStoreService', () => {
  let service: ImageStoreService;
  let storageService: { imageObjectKey: jest.Mock };
  let minioService: { uploadBuffer: jest.Mock; publicUrl: jest.Mock };
  let audit: { record: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    storageService = {
      // Mirrors the real builder (asserted for real in storage.service.spec.ts).
      imageObjectKey: jest.fn(
        (purpose: string, imageId: string, ext: string) =>
          `images/${purpose}/${imageId}${ext}`,
      ),
    };
    minioService = {
      uploadBuffer: jest.fn().mockResolvedValue(undefined),
      publicUrl: jest.fn((key: string) => `https://cdn.example/${key}`),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    service = new ImageStoreService(
      storageService as unknown as StorageService,
      minioService as unknown as MinioService,
      audit as unknown as AuditService,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('save', () => {
    // The type is read off the first bytes (see image-store-magic-bytes.spec),
    // so each stub starts like the image it stands for; sharp's refusal to
    // resize a bare header is logged and the bytes are stored as uploaded.
    const PNG_STUB = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const JPEG_STUB = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const WEBP_STUB = Buffer.from('RIFF\x24\x00\x00\x00WEBPVP8 ', 'latin1');

    beforeEach(() => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });

    it('files the image in the folder its purpose names — the purpose is never guessed or defaulted', async () => {
      const url = await service.save('actor', 'portrait.png', PNG_STUB, ACTOR);

      expect(storageService.imageObjectKey).toHaveBeenCalledWith(
        'actor',
        expect.any(String),
        '.png',
      );
      expect(minioService.uploadBuffer).toHaveBeenCalledWith(
        expect.stringMatching(/^images\/actor\/[0-9a-f-]{36}\.png$/),
        expect.any(Buffer),
      );
      expect(url).toMatch(/^https:\/\/cdn\.example\/images\/actor\//);
    });

    it('keeps every purpose in its own folder', async () => {
      await service.save('payment', 'kbzpay.webp', WEBP_STUB, ACTOR);

      expect(minioService.uploadBuffer).toHaveBeenCalledWith(
        expect.stringContaining('images/payment/'),
        expect.any(Buffer),
      );
    });

    it('records the upload against the staff member with the purpose, key and size (M-22)', async () => {
      await service.save(
        'actor',
        'portrait.png',
        Buffer.concat([PNG_STUB, Buffer.alloc(321 - PNG_STUB.length)]),
        ACTOR,
      );

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'image.upload',
          actor: ACTOR,
          target: expect.objectContaining({ type: 'image', id: null }),
          metadata: expect.objectContaining({
            purpose: 'actor',
            key: expect.stringMatching(/^images\/actor\/[0-9a-f-]{36}\.png$/),
            originalFilename: 'portrait.png',
            fileSize: 321,
          }),
        }),
      );
    });

    it('takes the EXTENSION from the bytes, never from the filename — a JPEG is .jpg whether it was named poster, poster.png or poster.svg', async () => {
      for (const filename of ['poster', 'poster.png', 'poster.svg']) {
        await service.save('movie', filename, JPEG_STUB, ACTOR);
      }

      expect(storageService.imageObjectKey).toHaveBeenCalledTimes(3);
      for (const [purpose, , extension] of storageService.imageObjectKey.mock
        .calls as [string, string, string][]) {
        expect(purpose).toBe('movie');
        expect(extension).toBe('.jpg');
      }
    });

    it('refuses bytes that are not a JPEG / PNG / WebP / GIF with a 400 and stores nothing (SEC-019)', async () => {
      await expect(
        service.save('movie', 'poster.jpg', Buffer.from('bytes'), ACTOR),
      ).rejects.toMatchObject({
        code: IMAGE_UPLOAD_UNSUPPORTED_TYPE_CODE,
        status: 400,
      });

      expect(minioService.uploadBuffer).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('save — artwork is shrunk to a display size before it is stored', () => {
    /** A real encoded image of the given size, made with sharp itself. */
    const makeImage = (
      width: number,
      height: number,
      format: 'jpeg' | 'png' | 'webp',
    ) =>
      sharp({
        create: {
          width,
          height,
          channels: 3,
          background: { r: 200, g: 40, b: 40 },
        },
      })
        .toFormat(format)
        .toBuffer();
    const stored = () => minioService.uploadBuffer.mock.calls[0][1] as Buffer;

    beforeEach(() => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });

    it('a 4000 px wide portrait JPEG poster comes out at most 1300 px wide (phone title page width) and still JPEG, at the same key and URL', async () => {
      const original = await makeImage(4000, 6000, 'jpeg');

      const url = await service.save('movie', 'poster.jpg', original, ACTOR);

      const meta = await sharp(stored()).metadata();
      expect(meta.format).toBe('jpeg');
      expect(meta.width).toBe(1300);
      expect(meta.height).toBe(1950);
      expect(stored().length).toBeLessThan(original.length);
      const [key] = minioService.uploadBuffer.mock.calls[0] as [string];
      expect(key).toMatch(/^images\/movie\/[0-9a-f-]{36}\.jpg$/);
      expect(url).toBe(`https://cdn.example/${key}`);
      // The audit row keeps both sizes.
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            fileSize: stored().length,
            originalSize: original.length,
          }),
        }),
      );
    });

    it('a square 5000 px WebP poster becomes 1300 x 1300 WebP', async () => {
      await service.save(
        'series',
        'poster.webp',
        await makeImage(5000, 5000, 'webp'),
        ACTOR,
      );

      const meta = await sharp(stored()).metadata();
      expect(meta).toMatchObject({ format: 'webp', width: 1300, height: 1300 });
    });

    it('a landscape cover keeps up to 1920 px (it fills a desktop hero), and PNG stays PNG', async () => {
      await service.save(
        'movie',
        'cover.png',
        await makeImage(3840, 2160, 'png'),
        ACTOR,
      );

      const meta = await sharp(stored()).metadata();
      expect(meta).toMatchObject({ format: 'png', width: 1920, height: 1080 });
    });

    it('a 3600 x 1880 lottery ticket frame (the 2x print size) is stored byte for byte; wider than 4000 px is brought to 4000', async () => {
      const frame = await makeImage(3600, 1880, 'png');
      await service.save('lottery_frame', 'frame.png', frame, ACTOR);
      expect(stored().equals(frame)).toBe(true);
      const [key] = minioService.uploadBuffer.mock.calls[0] as [string];
      expect(key).toMatch(/^images\/lottery_frame\/[0-9a-f-]{36}\.png$/);

      minioService.uploadBuffer.mockClear();
      await service.save(
        'lottery_frame',
        'frame.png',
        await makeImage(4800, 2507, 'png'),
        ACTOR,
      );
      const meta = await sharp(stored()).metadata();
      expect(meta).toMatchObject({ format: 'png', width: 4000, height: 2089 });

      // A draw picture (purpose "lottery") keeps its small cap: the frame's
      // size is the frame folder's alone.
      minioService.uploadBuffer.mockClear();
      await service.save(
        'lottery',
        'picture.png',
        await makeImage(1280, 976, 'png'),
        ACTOR,
      );
      expect((await sharp(stored()).metadata()).width).toBe(1000);
    });

    it('a 4000 px wide portrait actor photo still stops at 1000 px (shown small / blurred, never edge to edge)', async () => {
      await service.save(
        'actor',
        'headshot.jpg',
        await makeImage(4000, 6000, 'jpeg'),
        ACTOR,
      );

      const meta = await sharp(stored()).metadata();
      expect(meta).toMatchObject({ format: 'jpeg', width: 1000, height: 1500 });
    });

    it('stores an image that is already small enough byte-for-byte as uploaded', async () => {
      const original = await makeImage(800, 1200, 'jpeg');

      await service.save('movie', 'poster.jpg', original, ACTOR);

      expect(stored()).toBe(original);
    });

    it('falls back to the original bytes when sharp cannot read the image (broken file)', async () => {
      const broken = Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
        Buffer.from('definitely not the rest of a jpeg'),
      ]);

      await expect(
        service.save('movie', 'poster.jpg', broken, ACTOR),
      ).resolves.toMatch(/^https:\/\/cdn\.example\/images\/movie\//);

      expect(stored()).toBe(broken);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            fileSize: broken.length,
            originalSize: broken.length,
          }),
        }),
      );
    });

    it('never touches a purpose that is not artwork (payment logos and QR codes keep every pixel)', async () => {
      const original = await makeImage(3000, 3000, 'png');

      await service.save('payment', 'qr.png', original, ACTOR);

      expect(stored()).toBe(original);
    });

    it('leaves formats other than JPEG / PNG / WebP alone (e.g. GIF)', async () => {
      const gif = await makeImage(3000, 3000, 'png').then((png) =>
        sharp(png).gif().toBuffer(),
      );

      await service.save('movie', 'poster.gif', gif, ACTOR);

      expect(stored()).toBe(gif);
    });
  });

  describe('save — a picture fetched from TMDB (source: tmdb)', () => {
    const JPEG_STUB = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const TMDB_KEY =
      /^images\/movie\/tmdb-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/;

    beforeEach(() => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });

    it('is stored in the same purpose folder under a tmdb-<uuid> name — the name is the mark', async () => {
      const url = await service.save('movie', 'poster.jpg', JPEG_STUB, ACTOR, {
        source: 'tmdb',
        sourceRef: '/abcDEF123.jpg',
      });

      expect(storageService.imageObjectKey).toHaveBeenCalledWith(
        'movie',
        expect.stringMatching(/^tmdb-[0-9a-f-]{36}$/),
        '.jpg',
      );
      const [key] = minioService.uploadBuffer.mock.calls[0] as [string];
      expect(key).toMatch(TMDB_KEY);
      expect(isTmdbImageKey(key)).toBe(true);
      expect(url).toBe(`https://cdn.example/${key}`);
    });

    it('records the same image.upload row, plus where the picture came from', async () => {
      await service.save('actor', 'photo.jpg', JPEG_STUB, ACTOR, {
        source: 'tmdb',
        sourceRef: '/person123.jpg',
      });

      const [key] = minioService.uploadBuffer.mock.calls[0] as [string];
      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith({
        action: 'image.upload',
        actor: ACTOR,
        target: {
          type: 'image',
          id: null,
          label: key.slice('images/actor/'.length),
        },
        metadata: {
          purpose: 'actor',
          key,
          originalFilename: 'photo.jpg',
          fileSize: JPEG_STUB.length,
          originalSize: JPEG_STUB.length,
          source: 'tmdb',
          sourceRef: '/person123.jpg',
        },
      });
    });

    it('leaves sourceRef out of the row when none was given', async () => {
      await service.save('series', 'backdrop.jpg', JPEG_STUB, ACTOR, {
        source: 'tmdb',
      });

      const { metadata } = audit.record.mock.calls[0][0] as {
        metadata: Record<string, unknown>;
      };
      expect(metadata.source).toBe('tmdb');
      expect('sourceRef' in metadata).toBe(false);
    });

    it('a staff upload (no options, or options without a source) keeps a bare uuid and says nothing about a source', async () => {
      await service.save('movie', 'poster.jpg', JPEG_STUB, ACTOR);
      await service.save('movie', 'poster.jpg', JPEG_STUB, ACTOR, {});
      // A reference alone marks nothing: only `source` does.
      await service.save('movie', 'poster.jpg', JPEG_STUB, ACTOR, {
        sourceRef: '/ignored.jpg',
      });

      for (const [key] of minioService.uploadBuffer.mock.calls as [string][]) {
        expect(key).toMatch(/^images\/movie\/[0-9a-f-]{36}\.jpg$/);
        expect(isTmdbImageKey(key)).toBe(false);
      }
      for (const [row] of audit.record.mock.calls as [
        { metadata: Record<string, unknown> },
      ][]) {
        expect(Object.keys(row.metadata).sort()).toEqual([
          'fileSize',
          'key',
          'originalFilename',
          'originalSize',
          'purpose',
        ]);
      }
    });

    it('gets the same checks as a staff upload: wrong bytes are refused and nothing is stored', async () => {
      await expect(
        service.save('movie', 'poster.jpg', Buffer.from('<html>'), ACTOR, {
          source: 'tmdb',
          sourceRef: '/abc.jpg',
        }),
      ).rejects.toMatchObject({
        code: IMAGE_UPLOAD_UNSUPPORTED_TYPE_CODE,
        status: 400,
      });

      expect(minioService.uploadBuffer).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('is resized like any other artwork: a 4000 px poster comes out 1300 px wide, still under its tmdb- name', async () => {
      const original = await sharp({
        create: {
          width: 4000,
          height: 6000,
          channels: 3,
          background: { r: 20, g: 40, b: 200 },
        },
      })
        .jpeg()
        .toBuffer();

      await service.save('movie', 'poster.jpg', original, ACTOR, {
        source: 'tmdb',
        sourceRef: '/big.jpg',
      });

      const [key, stored] = minioService.uploadBuffer.mock.calls[0] as [
        string,
        Buffer,
      ];
      expect(key).toMatch(TMDB_KEY);
      expect((await sharp(stored).metadata()).width).toBe(1300);
    });
  });
});
