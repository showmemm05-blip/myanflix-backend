import { Test, TestingModule } from '@nestjs/testing';
import sharp from 'sharp';
import { AuditService } from '../audit/audit.service';
import { CodedHttpException } from '../common/errors/coded-http.exception';
import { MinioService } from '../common/storage/minio.service';
import { StorageService } from '../common/storage/storage.service';
import { PrismaService } from '../prisma/prisma.service';
import { ADS_ERRORS } from './ads-errors';
import { AdImageService } from './ad-image.service';
import { AdsAdminService } from './ads-admin.service';

const actor = { id: 'staff-1', username: 'staff', role: 'ADMIN' } as never;

/** A GIF header with the given logical screen size (enough for the sniffer and the size read). */
function gif(width: number, height: number, bytes = 32): Buffer {
  const buffer = Buffer.alloc(bytes);
  buffer.write('GIF89a', 0, 'latin1');
  buffer.writeUInt16LE(width, 6);
  buffer.writeUInt16LE(height, 8);
  return buffer;
}

const png = (width: number, height: number) =>
  sharp({
    create: { width, height, channels: 3, background: '#c00' },
  })
    .png()
    .toBuffer();

const file = (buffer: Buffer) => ({ buffer }) as Express.Multer.File;

async function rejection(
  promise: Promise<unknown>,
): Promise<CodedHttpException> {
  try {
    await promise;
  } catch (error) {
    return error as CodedHttpException;
  }
  throw new Error('expected the call to reject');
}

describe('AdImageService', () => {
  let service: AdImageService;
  let stored: Record<string, unknown>;
  let prisma: {
    advertisement: { update: jest.Mock };
    $transaction: jest.Mock;
  };
  let minio: { uploadBuffer: jest.Mock; deleteObject: jest.Mock };
  let audit: { record: jest.Mock };
  let ads: { findRow: jest.Mock; findOne: jest.Mock };

  beforeEach(async () => {
    stored = {
      id: 'ad-1',
      title: 'Shop',
      format: 'CORNER',
      imageKey: null,
      movies: [],
    };
    prisma = {
      advertisement: {
        update: jest.fn(
          async ({ data }: { data: Record<string, unknown> }) => ({
            ...stored,
            ...data,
          }),
        ),
      },
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn(prisma),
      ),
    };
    minio = {
      uploadBuffer: jest.fn().mockResolvedValue(undefined),
      deleteObject: jest.fn().mockResolvedValue(undefined),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    ads = {
      findRow: jest.fn(async () => stored),
      findOne: jest.fn().mockResolvedValue({ id: 'ad-1' }),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdImageService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: MinioService, useValue: minio },
        {
          provide: StorageService,
          useValue: {
            adImagePrefix: (id: string) => `images/ad/${id}`,
            adImageKey: (id: string, tag: string, ext: string) =>
              `images/ad/${id}/${tag}${ext}`,
          },
        },
        { provide: AdsAdminService, useValue: ads },
      ],
    }).compile();
    service = module.get(AdImageService);
  });

  it('stores a GIF byte-for-byte, sized from its header, audited, then answers the ad', async () => {
    const bytes = gif(320, 100);
    await expect(service.attach('ad-1', file(bytes), actor)).resolves.toEqual({
      id: 'ad-1',
    });
    const [key, body] = minio.uploadBuffer.mock.calls[0] as [string, Buffer];
    expect(key).toMatch(/^images\/ad\/ad-1\/[0-9a-f]{8}\.gif$/);
    expect(body.equals(bytes)).toBe(true);
    expect(prisma.advertisement.update).toHaveBeenCalledWith({
      where: { id: 'ad-1' },
      data: expect.objectContaining({
        imageKey: key,
        imageBytes: bytes.length,
        imageWidth: 320,
        imageHeight: 100,
      }),
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'advertisement.image_attach',
        metadata: expect.objectContaining({ width: 320, height: 100 }),
      }),
    );
    expect(minio.deleteObject).not.toHaveBeenCalled();
  });

  it('scales a wide still picture down to 960 px, keeping its type', async () => {
    await service.attach('ad-1', file(await png(1920, 480)), actor);
    const [key, body] = minio.uploadBuffer.mock.calls[0] as [string, Buffer];
    expect(key).toMatch(/\.png$/);
    const meta = await sharp(body).metadata();
    expect([meta.width, meta.height]).toEqual([960, 240]);
    expect(prisma.advertisement.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ imageWidth: 960, imageHeight: 240 }),
      }),
    );
  });

  it('refuses a video ad, a missing file, a non-picture, a huge file and a bad shape', async () => {
    stored.format = 'VIDEO';
    expect(
      (await rejection(service.attach('ad-1', file(gif(100, 100)), actor)))
        .code,
    ).toBe(ADS_ERRORS.FORMAT_MISMATCH);
    stored.format = 'CORNER';
    expect(
      (await rejection(service.attach('ad-1', undefined, actor))).code,
    ).toBe(ADS_ERRORS.IMAGE_UNSUPPORTED);
    expect(
      (
        await rejection(
          service.attach('ad-1', file(Buffer.from('%PDF-1.7 hello')), actor),
        )
      ).code,
    ).toBe(ADS_ERRORS.IMAGE_UNSUPPORTED);
    const tooBig = await rejection(
      service.attach('ad-1', file(gif(100, 100, 3 * 1024 * 1024 + 1)), actor),
    );
    expect(tooBig.code).toBe(ADS_ERRORS.IMAGE_TOO_LARGE);
    expect(tooBig.getStatus()).toBe(413);
    expect(
      (await rejection(service.attach('ad-1', file(gif(10, 100)), actor))).code,
    ).toBe(ADS_ERRORS.IMAGE_SHAPE_INVALID);
    expect(
      (await rejection(service.attach('ad-1', file(gif(900, 100)), actor)))
        .code,
    ).toBe(ADS_ERRORS.IMAGE_SHAPE_INVALID);
    expect(minio.uploadBuffer).not.toHaveBeenCalled();
  });

  it('deletes the replaced picture, but only inside this ad’s own folder', async () => {
    stored.imageKey = 'images/ad/ad-1/old.png';
    await service.attach('ad-1', file(gif(100, 100)), actor);
    expect(minio.deleteObject).toHaveBeenCalledWith('images/ad/ad-1/old.png');

    minio.deleteObject.mockClear();
    stored.imageKey = 'images/ad/other-ad/old.png';
    await service.attach('ad-1', file(gif(100, 100)), actor);
    expect(minio.deleteObject).not.toHaveBeenCalled();
  });

  it('takes the new object back out when the row cannot be updated', async () => {
    prisma.$transaction.mockRejectedValueOnce(new Error('db down'));
    await expect(
      service.attach('ad-1', file(gif(100, 100)), actor),
    ).rejects.toThrow('db down');
    const [key] = minio.uploadBuffer.mock.calls[0] as [string];
    expect(minio.deleteObject).toHaveBeenCalledWith(key);
  });
});
