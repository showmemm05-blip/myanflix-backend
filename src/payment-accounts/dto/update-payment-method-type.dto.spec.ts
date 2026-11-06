import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { MinioService } from '../../common/storage/minio.service';
import { requestHostContext } from '../../common/storage/request-host.context';
import {
  CreatePaymentMethodTypeDto,
  isOwnUploadedImageUrl,
  ownUploadedImagePurpose,
} from './create-payment-method-type.dto';
import { UpdatePaymentMethodTypeDto } from './update-payment-method-type.dto';

/**
 * F-002: a logo-only PATCH must not reset requiresBankName. Asserted as
 * "undefined / not an own property" rather than via Object.keys — tsconfig
 * targets ES2023, so every declared field is an own `undefined` prop.
 */
describe('UpdatePaymentMethodTypeDto — no inherited requiresBankName default', () => {
  it('{logoUrl} leaves requiresBankName untouched and validates', async () => {
    const instance = plainToInstance(UpdatePaymentMethodTypeDto, {
      logoUrl: 'http://localhost:8080/movies/images/payment/y.png',
    });

    expect(instance.requiresBankName).toBeUndefined();
    expect(
      Object.prototype.hasOwnProperty.call(instance, 'requiresBankName'),
    ).toBe(false);
    expect(await validate(instance)).toHaveLength(0);
  });

  it('{} carries no defined value at all', () => {
    const instance = plainToInstance(UpdatePaymentMethodTypeDto, {}) as Record<
      string,
      unknown
    >;
    expect(Object.entries(instance).filter(([, v]) => v !== undefined)).toEqual(
      [],
    );
  });

  it('keeps an explicit requiresBankName: true', async () => {
    const instance = plainToInstance(UpdatePaymentMethodTypeDto, {
      requiresBankName: true,
    });

    expect(instance.requiresBankName).toBe(true);
    expect(await validate(instance)).toHaveLength(0);
  });
});

describe('CreatePaymentMethodTypeDto — requiresBankName default belongs to createType', () => {
  it('leaves requiresBankName undefined when the body omits it', async () => {
    const instance = plainToInstance(CreatePaymentMethodTypeDto, {
      label: 'x',
    });

    expect(instance.requiresBankName).toBeUndefined();
    expect(await validate(instance)).toHaveLength(0);
  });
});

/**
 * I-15: logoUrl must be a URL like every sibling image field AND one of our
 * own uploaded images — `<host>/<bucket>/images/<purpose>/<file>`, exactly
 * what POST /uploads/image returns. The host is free (a LAN IP or
 * `localhost` with a port is normal here; a stale host is still ours), the
 * path is not: a well-formed off-site address such as
 * `https://evil.example/beacon.gif` must be refused, or a PAYMENT_METHODS
 * staff account could serve a tracking beacon to every user choosing a
 * payment method. null/undefined keep or clear the logo as before.
 */
describe('logoUrl is validated as one of our uploaded images (create and update alike)', () => {
  const OWN_UPLOAD_URLS = [
    'http://localhost:9000/movies/images/payment/kbz.png',
    'http://192.168.1.5:9000/movies/images/payment/kbz.png',
    'https://cdn.example.com/movies/images/payment/kbz.png',
    // A staff upload under another purpose folder is still our own object.
    'http://192.168.1.5:8080/movies/images/other/wave.webp',
  ];

  async function logoErrors(logoUrl: unknown) {
    const createErrors = await validate(
      plainToInstance(CreatePaymentMethodTypeDto, { label: 'x', logoUrl }),
    );
    const updateErrors = await validate(
      plainToInstance(UpdatePaymentMethodTypeDto, { logoUrl }),
    );
    return {
      create: createErrors.map((e) => e.property),
      update: updateErrors.map((e) => e.property),
    };
  }

  it.each(OWN_UPLOAD_URLS)('accepts the upload URL %s', async (logoUrl) => {
    expect(await logoErrors(logoUrl)).toEqual({ create: [], update: [] });
  });

  it('accepts null (clear the logo) and an omitted field (keep it)', async () => {
    expect(
      await validate(
        plainToInstance(UpdatePaymentMethodTypeDto, { logoUrl: null }),
      ),
    ).toHaveLength(0);
    expect(
      await validate(
        plainToInstance(CreatePaymentMethodTypeDto, { label: 'x' }),
      ),
    ).toHaveLength(0);
  });

  it.each(['not a url', '', 'javascript:alert(1)', 'http://'])(
    'rejects the non-URL string %p on create and on update',
    async (logoUrl) => {
      expect(await logoErrors(logoUrl)).toEqual({
        create: ['logoUrl'],
        update: ['logoUrl'],
      });
    },
  );

  it.each([
    // The audit's example: a well-formed off-site beacon.
    'https://evil.example/beacon.gif',
    // Our bucket name, but not under images/.
    'https://evil.example/movies/beacon.gif',
    // Our layout under a bucket that is not ours — the service would store
    // this verbatim, so it has to be refused here.
    'https://evil.example/other-bucket/images/payment/beacon.gif',
    // Our bucket, images/, but a folder that is not a purpose.
    'http://192.168.1.5:8080/movies/images/beacon.gif',
    'http://192.168.1.5:8080/movies/images/not-a-purpose/beacon.gif',
    // One segment too deep (avatars live under images/user/<userId>/).
    'http://192.168.1.5:8080/movies/images/user/u1/avatar.png',
    // Nothing after the purpose folder.
    'http://192.168.1.5:8080/movies/images/payment/',
    // Right path, wrong scheme.
    'ftp://192.168.1.5/movies/images/payment/kbz.png',
  ])(
    'rejects the well-formed but foreign URL %s on create and on update',
    async (logoUrl) => {
      expect(await logoErrors(logoUrl)).toEqual({
        create: ['logoUrl'],
        update: ['logoUrl'],
      });
    },
  );

  it('names the one rule a foreign URL fails, so staff see why', async () => {
    const [error] = await validate(
      plainToInstance(UpdatePaymentMethodTypeDto, {
        logoUrl: 'https://evil.example/beacon.gif',
      }),
    );
    expect(error.constraints).toEqual({
      isOwnUploadedImageUrl:
        'logoUrl must be the URL of an image uploaded through POST /uploads/image',
    });
  });

  it('ownUploadedImagePurpose names the purpose folder of an own upload, null otherwise', () => {
    expect(
      ownUploadedImagePurpose(
        'http://192.168.1.5:8080/movies/images/lottery_frame/f.png',
      ),
    ).toBe('lottery_frame');
    expect(
      ownUploadedImagePurpose(
        'http://192.168.1.5:8080/movies/images/payment/kbz.png',
      ),
    ).toBe('payment');
    for (const value of [
      'http://192.168.1.5:8080/movies/images/poster/kbz.png',
      'https://evil.example/beacon.gif',
      'http://192.168.1.5:8080/movies/images/payment/',
      null,
      42,
    ]) {
      expect(ownUploadedImagePurpose(value)).toBeNull();
    }
  });

  it('honours a non-default MINIO_BUCKET the same way MinioService does', () => {
    const before = process.env.MINIO_BUCKET;
    process.env.MINIO_BUCKET = 'myanflix';
    try {
      expect(
        isOwnUploadedImageUrl(
          'http://192.168.1.5:8080/myanflix/images/payment/kbz.png',
        ),
      ).toBe(true);
      expect(
        isOwnUploadedImageUrl(
          'http://192.168.1.5:8080/movies/images/payment/kbz.png',
        ),
      ).toBe(false);
    } finally {
      if (before === undefined) delete process.env.MINIO_BUCKET;
      else process.env.MINIO_BUCKET = before;
    }
  });

  /**
   * Guards the coupling: the admin sends either the URL POST /uploads/image
   * returned (MinioService.publicUrl) or the one it read back from the list
   * (MinioService.imageUrl -> playbackUrl, re-hosted to the current
   * request). Both must keep passing, whatever host they carry.
   */
  describe('accepts exactly what MinioService hands the admin', () => {
    const env: Record<string, string> = {
      MINIO_BUCKET: 'movies',
      STREAM_PUBLIC_BASE_URL: 'http://192.168.100.27:8080',
      STREAM_SIGNING_SECRET: 'unit-test-stream-signing-secret-0123456789',
      MINIO_ENDPOINT: 'http://minio:9000',
      MINIO_ACCESS_KEY: 'key',
      MINIO_SECRET_KEY: 'secret',
    };
    let minio: MinioService;

    beforeEach(async () => {
      const module = await Test.createTestingModule({
        providers: [
          MinioService,
          {
            provide: ConfigService,
            useValue: { get: jest.fn((key: string) => env[key]) },
          },
        ],
      }).compile();
      minio = module.get(MinioService);
    });

    const key = 'images/payment/3f1c2a9e-0d7b-4c6a-9c1e-2b6f5a8d7e10.png';

    it('the persisted upload URL (publicUrl)', async () => {
      const url = minio.publicUrl(key);
      expect(url).toBe(
        'http://192.168.100.27:8080/movies/images/payment/3f1c2a9e-0d7b-4c6a-9c1e-2b6f5a8d7e10.png',
      );
      expect(await logoErrors(url)).toEqual({ create: [], update: [] });
    });

    it('the re-hosted URL the admin read back (imageUrl inside a request)', async () => {
      const stale = `http://10.0.0.9:8080/movies/${key}`;
      const url = requestHostContext.run({ hostname: '192.168.1.50' }, () =>
        minio.imageUrl(stale),
      );
      expect(url).toBe(`http://192.168.1.50:8080/movies/${key}`);
      expect(await logoErrors(url)).toEqual({ create: [], update: [] });
      // And the service still recognises what passed as its own object.
      expect(minio.canonicalImageUrl(url)).toBe(minio.publicUrl(key));
    });
  });
});
