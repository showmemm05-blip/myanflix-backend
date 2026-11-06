import { HttpStatus, Logger } from '@nestjs/common';
import sharp from 'sharp';
import {
  FRAME_IMAGE_UPLOAD_MAX_BYTES,
  IMAGE_UPLOAD_MAX_BYTES,
  IMAGE_UPLOAD_TOO_LARGE_CODE,
  IMAGE_UPLOAD_UNSUPPORTED_TYPE_CODE,
  IMAGE_UPLOAD_UNSUPPORTED_TYPE_MESSAGE,
  UploadsService,
  imageUploadByteLimit,
  imageUploadTooLargeMessage,
} from './uploads.service';
import { CodedHttpException } from '../common/errors/coded-http.exception';
import { Role } from '../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { StorageService } from '../common/storage/storage.service';
import type { MinioService } from '../common/storage/minio.service';
import type { VideosService } from '../videos/videos.service';
import type { VideoDurationService } from '../videos/video-duration.service';
import type { ProcessingService } from '../processing/processing.service';
import type { SubtitlesService } from '../subtitles/subtitles.service';
import type { AuditService } from '../audit/audit.service';
import type { ResourceUploadTypeRegistry } from './resource-upload-type.registry';

/**
 * POST /uploads/image decides what a file is from its magic bytes — before
 * the key is built, before anything is stored under the public images/
 * folder and before sharp opens it (SEC-008 / SEC-019). sharp is mocked
 * here so the one thing the resizing specs in uploads.service.spec.ts
 * cannot show is pinned: refused bytes never reach it.
 */
jest.mock('sharp', () => jest.fn());

const sharpMock = sharp as unknown as jest.Mock;

const ACTOR = {
  id: 'admin-1',
  username: 'boss',
  role: Role.ADMIN,
  appRoleId: null,
} as const;

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const JPEG_HEADER = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46,
]);
const WEBP_HEADER = Buffer.from('RIFF\x24\x00\x00\x00WEBPVP8 ', 'latin1');
const GIF_HEADER = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1');

describe('UploadsService.saveImage — the magic bytes decide, before sharp and before storage', () => {
  let service: UploadsService;
  let imageObjectKey: jest.Mock;
  let uploadBuffer: jest.Mock;
  let record: jest.Mock;

  beforeEach(() => {
    sharpMock.mockReset();
    // Any bytes that reach sharp here are a stub header, which it cannot
    // decode — the service logs that and stores the bytes as uploaded, as
    // it always did for a file it cannot resize.
    sharpMock.mockImplementation(() => {
      throw new Error('Input buffer contains unsupported image format');
    });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    imageObjectKey = jest.fn(
      (purpose: string, imageId: string, ext: string) =>
        `images/${purpose}/${imageId}${ext}`,
    );
    uploadBuffer = jest.fn().mockResolvedValue(undefined);
    record = jest.fn().mockResolvedValue(undefined);
    service = new UploadsService(
      {} as PrismaService,
      { imageObjectKey } as unknown as StorageService,
      {
        uploadBuffer,
        publicUrl: (key: string) => `https://cdn.example/${key}`,
      } as unknown as MinioService,
      {} as VideosService,
      {} as VideoDurationService,
      {} as ProcessingService,
      {} as SubtitlesService,
      { record } as unknown as AuditService,
      {} as ResourceUploadTypeRegistry,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("too many bytes: a 413 with a stable code, by the purpose's own cap", () => {
    /** A buffer that starts like a PNG and is `size` bytes long. */
    const pngOf = (size: number) => {
      const bytes = Buffer.alloc(size);
      PNG_SIGNATURE.copy(bytes);
      return bytes;
    };

    it('keeps 10 MB for every purpose but the ticket frame, which gets 25 MB', () => {
      expect(IMAGE_UPLOAD_MAX_BYTES).toBe(10 * 1024 * 1024);
      expect(FRAME_IMAGE_UPLOAD_MAX_BYTES).toBe(25 * 1024 * 1024);
      expect(imageUploadByteLimit('lottery_frame')).toBe(
        FRAME_IMAGE_UPLOAD_MAX_BYTES,
      );
      for (const purpose of [
        'movie',
        'series',
        'lottery',
        'promo',
        'payment',
        'other',
      ] as const) {
        expect(imageUploadByteLimit(purpose)).toBe(IMAGE_UPLOAD_MAX_BYTES);
      }
    });

    it('refuses a poster one byte over 10 MB before sniffing, sharp, a key, storage or an audit row', async () => {
      const attempt = service.saveImage(
        'movie',
        'poster.png',
        pngOf(IMAGE_UPLOAD_MAX_BYTES + 1),
        ACTOR,
      );

      await expect(attempt).rejects.toBeInstanceOf(CodedHttpException);
      const error = await attempt.catch((e: CodedHttpException) => e);
      expect(error.getStatus()).toBe(HttpStatus.PAYLOAD_TOO_LARGE);
      expect(error.getResponse()).toEqual({
        message: imageUploadTooLargeMessage(IMAGE_UPLOAD_MAX_BYTES),
        code: IMAGE_UPLOAD_TOO_LARGE_CODE,
        maxBytes: IMAGE_UPLOAD_MAX_BYTES,
      });
      expect(error.message).toBe(
        'The image is too large — up to 10 MB is allowed',
      );
      expect(sharpMock).not.toHaveBeenCalled();
      expect(imageObjectKey).not.toHaveBeenCalled();
      expect(uploadBuffer).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    it('stores a ticket frame of the same size — its cap is 25 MB — and refuses one over that', async () => {
      const frame = pngOf(IMAGE_UPLOAD_MAX_BYTES + 1);
      const url = await service.saveImage(
        'lottery_frame',
        'frame.png',
        frame,
        ACTOR,
      );
      expect(url).toMatch(/^https:\/\/cdn\.example\/images\/lottery_frame\//);
      expect(uploadBuffer).toHaveBeenCalledWith(expect.any(String), frame);

      uploadBuffer.mockClear();
      const attempt = service.saveImage(
        'lottery_frame',
        'frame.png',
        pngOf(FRAME_IMAGE_UPLOAD_MAX_BYTES + 1),
        ACTOR,
      );
      await expect(attempt).rejects.toMatchObject({
        code: IMAGE_UPLOAD_TOO_LARGE_CODE,
        message: 'The image is too large — up to 25 MB is allowed',
      });
      expect(uploadBuffer).not.toHaveBeenCalled();
    });

    it('checks the cap before the byte sniff: an over-size non-image is a 413, not a 400', async () => {
      const attempt = service.saveImage(
        'movie',
        'poster.jpg',
        Buffer.alloc(IMAGE_UPLOAD_MAX_BYTES + 1, 'x'),
        ACTOR,
      );
      await expect(attempt).rejects.toMatchObject({
        code: IMAGE_UPLOAD_TOO_LARGE_CODE,
      });
    });
  });

  describe('refused bytes: a 400 with a stable code, and nothing else happens', () => {
    it.each([
      [
        'a PDF renamed to poster.jpg',
        'poster.jpg',
        Buffer.from('%PDF-1.7\n%âãÏÓ\n'),
      ],
      [
        'an SVG renamed to poster.png',
        'poster.png',
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'),
      ],
      [
        'an HTML page renamed to cover.webp',
        'cover.webp',
        Buffer.from('<!DOCTYPE html><script>alert(1)</script>'),
      ],
      [
        'a JPEG truncated after 2 bytes',
        'poster.jpg',
        JPEG_HEADER.subarray(0, 2),
      ],
      [
        'a PNG truncated inside its signature',
        'poster.png',
        PNG_SIGNATURE.subarray(0, 7),
      ],
      ['an empty file', 'poster.jpg', Buffer.alloc(0)],
      ['plain text', 'poster.jpg', Buffer.from('bytes')],
    ])('%s', async (_label, filename, bytes) => {
      const attempt = service.saveImage('movie', filename, bytes, ACTOR);

      await expect(attempt).rejects.toBeInstanceOf(CodedHttpException);
      await expect(attempt).rejects.toMatchObject({
        code: IMAGE_UPLOAD_UNSUPPORTED_TYPE_CODE,
        message: IMAGE_UPLOAD_UNSUPPORTED_TYPE_MESSAGE,
      });
      const error = await attempt.catch((e: CodedHttpException) => e);
      expect(error.getStatus()).toBe(HttpStatus.BAD_REQUEST);
      expect(error.getResponse()).toEqual({
        message: IMAGE_UPLOAD_UNSUPPORTED_TYPE_MESSAGE,
        code: IMAGE_UPLOAD_UNSUPPORTED_TYPE_CODE,
      });

      // Refused before a key exists, before any byte lands under images/,
      // before an audit row is written — and before sharp sees the bytes.
      expect(sharpMock).not.toHaveBeenCalled();
      expect(imageObjectKey).not.toHaveBeenCalled();
      expect(uploadBuffer).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    it("refuses the same bytes for a purpose that is never resized — the check is not sharp's", async () => {
      await expect(
        service.saveImage('payment', 'logo.png', Buffer.from('<svg/>'), ACTOR),
      ).rejects.toMatchObject({ code: IMAGE_UPLOAD_UNSUPPORTED_TYPE_CODE });

      expect(sharpMock).not.toHaveBeenCalled();
      expect(uploadBuffer).not.toHaveBeenCalled();
    });
  });

  describe("accepted bytes: the stored extension is the one the bytes say, never the filename's", () => {
    it.each([
      ['JPEG', 'poster.png', JPEG_HEADER, '.jpg'],
      ['PNG', 'poster.jpg', PNG_SIGNATURE, '.png'],
      ['WebP', 'poster.jpg', WEBP_HEADER, '.webp'],
      ['GIF', 'poster.jpg', GIF_HEADER, '.gif'],
      ['JPEG with no extension at all', 'poster', JPEG_HEADER, '.jpg'],
      ['JPEG under a .svg name', 'poster.svg', JPEG_HEADER, '.jpg'],
      ['PNG under a .html name', 'poster.html', PNG_SIGNATURE, '.png'],
    ])(
      '%s named %s is stored as %s',
      async (_label, filename, bytes, extension) => {
        const url = await service.saveImage('movie', filename, bytes, ACTOR);

        expect(imageObjectKey).toHaveBeenCalledWith(
          'movie',
          expect.any(String),
          extension,
        );
        const [key, stored] = uploadBuffer.mock.calls[0] as [string, Buffer];
        expect(key).toMatch(
          new RegExp(`^images/movie/[0-9a-f-]{36}\\${extension}$`),
        );
        expect(stored).toBe(bytes);
        expect(url).toBe(`https://cdn.example/${key}`);
        expect(record).toHaveBeenCalledWith(
          expect.objectContaining({
            action: 'image.upload',
            metadata: expect.objectContaining({
              key,
              originalFilename: filename,
            }),
          }),
        );
      },
    );

    it('opens an artwork JPEG / PNG / WebP with sharp only AFTER the byte check, and keeps the bytes when sharp cannot resize them', async () => {
      await service.saveImage('movie', 'poster.jpg', JPEG_HEADER, ACTOR);

      expect(sharpMock).toHaveBeenCalledTimes(1);
      expect(sharpMock).toHaveBeenCalledWith(JPEG_HEADER);
      expect(uploadBuffer).toHaveBeenCalledWith(
        expect.any(String),
        JPEG_HEADER,
      );
    });

    it('never opens a GIF with sharp — it is stored as uploaded, every frame kept', async () => {
      await service.saveImage('movie', 'poster.gif', GIF_HEADER, ACTOR);

      expect(sharpMock).not.toHaveBeenCalled();
      expect(uploadBuffer).toHaveBeenCalledWith(expect.any(String), GIF_HEADER);
    });

    it('never opens a purpose that is not artwork with sharp (payment logos keep every pixel)', async () => {
      await service.saveImage('payment', 'logo.png', PNG_SIGNATURE, ACTOR);

      expect(sharpMock).not.toHaveBeenCalled();
      expect(uploadBuffer).toHaveBeenCalledWith(
        expect.stringMatching(/^images\/payment\/[0-9a-f-]{36}\.png$/),
        PNG_SIGNATURE,
      );
    });
  });
});
