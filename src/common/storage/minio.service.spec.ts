import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  CopyObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NotFound,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { MinioService } from './minio.service';
import { requestHostContext } from './request-host.context';
import {
  StreamKeyNotSignable,
  quantizedExpiry,
  signScope,
} from './stream-signature';

// The streamed-copy fallback in copyObject() hands a GetObject body to
// lib-storage's Upload; stubbed so the spec can assert it was constructed
// with the right params without any multipart traffic.
jest.mock('@aws-sdk/lib-storage', () => ({
  Upload: jest.fn().mockImplementation(() => ({
    done: jest.fn().mockResolvedValue(undefined),
  })),
}));

/**
 * Covers imageUrl() only — the read-time repair for PERSISTED image URLs.
 *
 * The bug it exists for: saveImage() bakes an absolute URL into the database
 * using whatever host the machine had at upload time, so every network hop
 * left the catalog pointing at an address nobody can reach any more (the
 * bytes were always fine — only the hostname went stale). imageUrl()
 * discards that host and re-derives it from the current request, the same
 * way playback URLs already worked.
 */
describe('MinioService.imageUrl', () => {
  let service: MinioService;

  const env: Record<string, string> = {
    MINIO_BUCKET: 'movies',
    // The cache server's protocol/port — this base's HOST is deliberately
    // never used by playbackUrl() inside a request.
    STREAM_PUBLIC_BASE_URL: 'http://192.168.100.27:8080',
    STREAM_SIGNING_SECRET: 'unit-test-stream-signing-secret-0123456789',
    MINIO_ENDPOINT: 'http://minio:9000',
    MINIO_ACCESS_KEY: 'key',
    MINIO_SECRET_KEY: 'secret',
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MinioService,
        {
          provide: ConfigService,
          useValue: { get: jest.fn((key: string) => env[key]) },
        },
      ],
    }).compile();

    service = module.get(MinioService);
  });

  /** Runs `fn` as if it were inside a request that arrived at `hostname`. */
  const asRequestFrom = <T>(hostname: string, fn: () => T): T =>
    requestHostContext.run({ hostname }, fn);

  it('re-hosts one of our own URLs whose baked-in host has gone stale', () => {
    // Exactly what the database holds today: the LAN IP the machine had at
    // upload time, long since unreachable.
    const persisted = 'http://192.168.10.122:8080/movies/images/abc-123.jpeg';

    const resolved = asRequestFrom('192.168.100.27', () =>
      service.imageUrl(persisted),
    );

    expect(resolved).toBe(
      'http://192.168.100.27:8080/movies/images/abc-123.jpeg',
    );
  });

  it('follows the host of whichever request is asking, not a fixed one', () => {
    const persisted = 'http://192.168.10.122:8080/movies/images/abc-123.jpeg';

    expect(asRequestFrom('localhost', () => service.imageUrl(persisted))).toBe(
      'http://localhost:8080/movies/images/abc-123.jpeg',
    );
    expect(asRequestFrom('10.0.0.42', () => service.imageUrl(persisted))).toBe(
      'http://10.0.0.42:8080/movies/images/abc-123.jpeg',
    );
  });

  it('leaves an external URL completely untouched', () => {
    // Nothing under our bucket path, so there is no object key to recover
    // and nothing for us to re-host — tmdb/picsum/etc. serve these.
    for (const external of [
      'https://image.tmdb.org/t/p/w500/kqjL17yufvn9OVLyXYpvtyrFfak.jpg',
      'https://picsum.photos/seed/Some%20Title/400/600',
      'not-a-url-at-all',
    ]) {
      expect(
        asRequestFrom('192.168.100.27', () => service.imageUrl(external)),
      ).toBe(external);
    }
  });

  it('is null/undefined-safe', () => {
    expect(service.imageUrl(null)).toBeNull();
    expect(service.imageUrl(undefined)).toBeNull();
    expect(
      asRequestFrom('192.168.100.27', () => service.imageUrl(null)),
    ).toBeNull();
  });

  it('falls back to the configured public base outside any request context', () => {
    expect(
      service.imageUrl('http://192.168.10.122:8080/movies/images/abc-123.jpeg'),
    ).toBe('http://192.168.100.27:8080/movies/images/abc-123.jpeg');
  });

  it('falls back the same way inside a request that carried no Host header', () => {
    // The context middleware used to skip the ALS entirely when Host was
    // empty; it now always runs (so IP/platform are never silently dropped)
    // and stores hostname ''. That must be indistinguishable here from not
    // being in a request at all — an empty host is not an address.
    expect(
      asRequestFrom('', () =>
        service.imageUrl(
          'http://192.168.10.122:8080/movies/images/abc-123.jpeg',
        ),
      ),
    ).toBe('http://192.168.100.27:8080/movies/images/abc-123.jpeg');
  });

  it('does not mutate anything — the stored value is only ever read', () => {
    const persisted = 'http://192.168.10.122:8080/movies/images/abc-123.jpeg';
    asRequestFrom('localhost', () => service.imageUrl(persisted));
    expect(persisted).toBe(
      'http://192.168.10.122:8080/movies/images/abc-123.jpeg',
    );
  });

  describe('external URLs and canonical persistence', () => {
    it('leaves an external URL alone even when its first path segment matches the bucket name', () => {
      // keyFromPublicUrl is host-blind on purpose (that is what repairs stale
      // LAN IPs), so "ours" has to be decided by key namespace as well.
      const external = 'https://cdn.example.com/movies/tt0111161.jpg';
      expect(service.imageUrl(external)).toBe(external);
    });

    it('canonicalImageUrl stores the configured public host, not the requesting one', () => {
      const stale = 'http://192.168.10.122:8080/movies/images/abc.jpeg';
      const canonical = service.canonicalImageUrl(stale);
      expect(canonical).toContain('/movies/images/abc.jpeg');
      expect(canonical).not.toContain('192.168.10.122');
    });

    it('canonicalImageUrl passes external URLs and nullish values through', () => {
      const external = 'https://image.tmdb.org/t/p/w500/poster.jpg';
      expect(service.canonicalImageUrl(external)).toBe(external);
      expect(service.canonicalImageUrl(null)).toBeNull();
      expect(service.canonicalImageUrl(undefined)).toBeUndefined();
    });
  });
});

/**
 * The split-deployment case: API, cache server and storage each on their own
 * host. Deriving the stream host from the request points every viewer at the
 * API's address, which is the one machine that does NOT run the cache server —
 * so a correctly-migrated library returns connection-refused on every segment
 * while the objects sit there, perfectly readable, on the storage host.
 */
describe('MinioService.playbackUrl with a public cache address', () => {
  const buildService = async (
    overrides: Record<string, string>,
  ): Promise<MinioService> => {
    const env: Record<string, string> = {
      MINIO_BUCKET: 'movies',
      STREAM_PUBLIC_BASE_URL: 'http://213.111.155.181:8080',
      MINIO_ENDPOINT: 'http://minio:9000',
      MINIO_ACCESS_KEY: 'key',
      MINIO_SECRET_KEY: 'secret',
      ...overrides,
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MinioService,
        {
          provide: ConfigService,
          useValue: { get: jest.fn((key: string) => env[key]) },
        },
      ],
    }).compile();
    return module.get(MinioService);
  };

  const key = 'videos/33e6e224/hls/master.m3u8';

  it('uses the configured cache host when the base is marked public', async () => {
    const service = await buildService({
      STREAM_PUBLIC_BASE_URL_IS_PUBLIC: 'true',
    });

    const url = requestHostContext.run({ hostname: '185.165.169.16' }, () =>
      service.playbackUrl(key),
    );

    // The API's own host (185.165.169.16) must NOT appear — that box runs no
    // cache server.
    expect(url).toBe(`http://213.111.155.181:8080/movies/${key}`);
  });

  it('still derives the host from the request when the flag is absent', async () => {
    const service = await buildService({});

    const url = requestHostContext.run({ hostname: '192.168.1.50' }, () =>
      service.playbackUrl(key),
    );

    expect(url).toBe(`http://192.168.1.50:8080/movies/${key}`);
  });

  it('ignores a non-"true" value rather than guessing', async () => {
    const service = await buildService({
      STREAM_PUBLIC_BASE_URL_IS_PUBLIC: 'yes',
    });

    const url = requestHostContext.run({ hostname: '192.168.1.50' }, () =>
      service.playbackUrl(key),
    );

    expect(url).toBe(`http://192.168.1.50:8080/movies/${key}`);
  });

  it('re-hosts persisted image URLs onto the cache host too', async () => {
    const service = await buildService({
      STREAM_PUBLIC_BASE_URL_IS_PUBLIC: 'true',
    });

    const url = requestHostContext.run({ hostname: '185.165.169.16' }, () =>
      service.imageUrl('http://192.168.10.122:8080/movies/images/abc-123.jpeg'),
    );

    expect(url).toBe('http://213.111.155.181:8080/movies/images/abc-123.jpeg');
  });
});

/**
 * The signed playback link: the same host rules as playbackUrl(), plus the
 * `/s/<expires>/<signature>/` prefix the cache server's secure_link checks.
 * The signature is recomputed here from the module's own primitives on top
 * of the expiry read back out of the URL — what is being proven is the URL
 * SHAPE and the wiring of scope/secret/TTL, not the hash (that has its own
 * spec next to stream-signature.ts).
 */
describe('MinioService.signedPlaybackUrl', () => {
  const SECRET = 'unit-test-stream-signing-secret-0123456789';
  const MOVIE_ID = 'f41b5f3d-cadf-40ab-b789-4192ee772a5e';
  const masterKey = `videos/${MOVIE_ID}/hls/master.m3u8`;
  const SIGNED = /^(https?:\/\/[^/]+)\/s\/(\d+)\/([\w-]+)\/movies\/(.+)$/;

  const buildService = async (
    overrides: Record<string, string>,
  ): Promise<MinioService> => {
    const env: Record<string, string> = {
      MINIO_BUCKET: 'movies',
      STREAM_PUBLIC_BASE_URL: 'http://213.111.155.181:8080',
      STREAM_SIGNING_SECRET: SECRET,
      MINIO_ENDPOINT: 'http://minio:9000',
      MINIO_ACCESS_KEY: 'key',
      MINIO_SECRET_KEY: 'secret',
      ...overrides,
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MinioService,
        {
          provide: ConfigService,
          useValue: { get: jest.fn((key: string) => env[key]) },
        },
      ],
    }).compile();
    return module.get(MinioService);
  };

  it('derives the host from the request and puts the token in the path', async () => {
    const service = await buildService({});

    const url = requestHostContext.run({ hostname: '192.168.1.5' }, () =>
      service.signedPlaybackUrl(masterKey),
    );

    const match = SIGNED.exec(url);
    expect(match).not.toBeNull();
    const [, base, expires, signature, key] = match!;
    expect(base).toBe('http://192.168.1.5:8080');
    expect(key).toBe(masterKey);
    expect(signature).toBe(
      signScope(`videos/${MOVIE_ID}/hls`, Number(expires), SECRET),
    );
  });

  it('uses the configured base verbatim when it is marked public', async () => {
    const service = await buildService({
      STREAM_PUBLIC_BASE_URL_IS_PUBLIC: 'true',
    });

    const url = requestHostContext.run({ hostname: '185.165.169.16' }, () =>
      service.signedPlaybackUrl(masterKey),
    );

    expect(url).toMatch(
      new RegExp(
        `^http://213\\.111\\.155\\.181:8080/s/\\d+/[\\w-]+/movies/${masterKey}$`,
      ),
    );
  });

  it('expires 12 h from the current hour boundary by default, hour-quantised', async () => {
    const service = await buildService({});
    const now = Math.floor(Date.now() / 1000);

    const expires = Number(
      SIGNED.exec(service.signedPlaybackUrl(masterKey))![2],
    );

    expect(expires).toBe(quantizedExpiry(now, 43_200));
    expect(expires % 3600).toBe(0);
    expect(expires - now).toBeGreaterThan(43_200 - 3600);
    expect(expires - now).toBeLessThanOrEqual(43_200);
  });

  it('honours STREAM_URL_TTL_SECONDS', async () => {
    const service = await buildService({ STREAM_URL_TTL_SECONDS: '7200' });
    const now = Math.floor(Date.now() / 1000);

    const expires = Number(
      SIGNED.exec(service.signedPlaybackUrl(masterKey))![2],
    );

    expect(expires).toBe(quantizedExpiry(now, 7200));
  });

  it('signs one scope for every object of a title, so relative playlist URIs stay covered', async () => {
    const service = await buildService({});

    const [master, segment] = [
      masterKey,
      `videos/${MOVIE_ID}/hls/720p/segment_000.ts`,
    ].map((key) => SIGNED.exec(service.signedPlaybackUrl(key))!);

    // Same expiry, same signature — only the key differs.
    expect(segment[2]).toBe(master[2]);
    expect(segment[3]).toBe(master[3]);
  });

  it('refuses an image key — images stay on the plain, public URL', async () => {
    const service = await buildService({});

    expect(() => service.signedPlaybackUrl('images/abc-123.jpeg')).toThrow(
      StreamKeyNotSignable,
    );
    expect(() =>
      service.signedPlaybackUrl(`videos/${MOVIE_ID}/original.mp4`),
    ).toThrow(StreamKeyNotSignable);
  });

  it('leaves playbackUrl() itself unsigned', async () => {
    const service = await buildService({});

    const url = requestHostContext.run({ hostname: '192.168.1.5' }, () =>
      service.playbackUrl('images/abc-123.jpeg'),
    );

    expect(url).toBe('http://192.168.1.5:8080/movies/images/abc-123.jpeg');
  });
});

/**
 * The object-level helpers the video-replace swap and the playback diagnosis
 * rely on. `S3Client.prototype.send` is stubbed per command constructor —
 * what is being proven is which S3 command goes out with which parameters,
 * never a live bucket.
 */
describe('MinioService object helpers', () => {
  const GIB = 1024 * 1024 * 1024;
  let service: MinioService;
  let send: jest.SpyInstance;
  /** Every command `send` saw, by constructor name, with its input. */
  const sent = (): { name: string; input: Record<string, unknown> }[] =>
    send.mock.calls.map(([command]) => ({
      name: (command as object).constructor.name,
      input: (command as { input: Record<string, unknown> }).input,
    }));

  const env: Record<string, string> = {
    MINIO_BUCKET: 'movies',
    STREAM_PUBLIC_BASE_URL: 'http://192.168.100.27:8080',
    STREAM_SIGNING_SECRET: 'unit-test-stream-signing-secret-0123456789',
    MINIO_ENDPOINT: 'http://minio:9000',
    MINIO_ACCESS_KEY: 'key',
    MINIO_SECRET_KEY: 'secret',
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MinioService,
        {
          provide: ConfigService,
          useValue: { get: jest.fn((key: string) => env[key]) },
        },
      ],
    }).compile();
    service = module.get(MinioService);
    send = jest.spyOn(S3Client.prototype, 'send');
    (Upload as unknown as jest.Mock).mockClear();
  });

  afterEach(() => {
    send.mockRestore();
  });

  describe('copyObject', () => {
    it('issues one server-side CopyObject for a source under the 5 GiB cap, typed by the DESTINATION key', async () => {
      send.mockImplementation(async (command: { constructor: unknown }) => {
        if (command.constructor === HeadObjectCommand)
          return { ContentLength: 1234 };
        if (command.constructor === CopyObjectCommand) return {};
        throw new Error(`unexpected ${command.constructor}`);
      });

      await service.copyObject(
        'temp/video-replace/m1/hls/720p/index.m3u8',
        'videos/m1/hls/720p/index.m3u8',
      );

      const copies = sent().filter((c) => c.name === 'CopyObjectCommand');
      expect(copies).toHaveLength(1);
      expect(copies[0].input).toEqual({
        Bucket: 'movies',
        CopySource: 'movies/temp/video-replace/m1/hls/720p/index.m3u8',
        Key: 'videos/m1/hls/720p/index.m3u8',
        ContentType: 'application/vnd.apple.mpegurl',
        MetadataDirective: 'REPLACE',
      });
      expect(Upload).not.toHaveBeenCalled();
    });

    it('streams GetObject -> multipart Upload for a source at or above the cap — never a single CopyObject', async () => {
      const body = { pipe: jest.fn() };
      send.mockImplementation(async (command: { constructor: unknown }) => {
        if (command.constructor === HeadObjectCommand)
          return { ContentLength: 6 * GIB };
        if (command.constructor === GetObjectCommand) return { Body: body };
        throw new Error(`unexpected ${command.constructor}`);
      });

      await service.copyObject(
        'temp/video-replace/m1/original.mkv',
        'videos/m1/original.mkv',
      );

      expect(sent().map((c) => c.name)).toEqual([
        'HeadObjectCommand',
        'GetObjectCommand',
      ]);
      expect(Upload).toHaveBeenCalledWith(
        expect.objectContaining({
          params: expect.objectContaining({
            Bucket: 'movies',
            Key: 'videos/m1/original.mkv',
            Body: body,
            ContentType: 'video/x-matroska',
          }),
        }),
      );
    });

    it('throws instead of silently copying nothing when the source is missing', async () => {
      send.mockImplementation(async (command: { constructor: unknown }) => {
        if (command.constructor === HeadObjectCommand)
          throw new NotFound({ message: 'nope', $metadata: {} });
        throw new Error(`unexpected ${command.constructor}`);
      });

      await expect(
        service.copyObject('temp/video-replace/m1/gone.ts', 'videos/m1/x.ts'),
      ).rejects.toThrow('does not exist');
      expect(sent().some((c) => c.name === 'CopyObjectCommand')).toBe(false);
    });
  });

  describe('listObjects / listKeys', () => {
    it('walks every page of the listing and keeps each key with its stamp', async () => {
      const stamp = new Date('2026-09-01T00:00:00Z');
      send
        .mockResolvedValueOnce({
          Contents: [{ Key: 'videos/m1/a.ts', LastModified: stamp }],
          IsTruncated: true,
          NextContinuationToken: 'page-2',
        })
        .mockResolvedValueOnce({
          Contents: [{ Key: 'videos/m1/b.ts' }, { Key: undefined }],
          IsTruncated: false,
        });

      const objects = await service.listObjects('videos/m1/');

      expect(objects).toEqual([
        { key: 'videos/m1/a.ts', lastModified: stamp },
        { key: 'videos/m1/b.ts', lastModified: undefined },
      ]);
      expect(sent().map((c) => c.input.ContinuationToken)).toEqual([
        undefined,
        'page-2',
      ]);
      expect(sent().every((c) => c.input.Prefix === 'videos/m1/')).toBe(true);
    });

    it('listKeys is the same walk reduced to keys', async () => {
      send.mockResolvedValueOnce({
        Contents: [{ Key: 'subtitles/m1/english.vtt' }],
        IsTruncated: false,
      });

      expect(await service.listKeys('subtitles/m1/')).toEqual([
        'subtitles/m1/english.vtt',
      ]);
    });
  });

  describe('downloadFile', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'minio-spec-'));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('streams the object to disk and reports the ETag of the bytes it got, unquoted', async () => {
      send.mockImplementation((command: { constructor: unknown }) =>
        command.constructor === GetObjectCommand
          ? Promise.resolve({
              Body: Readable.from([Buffer.from('%PDF-1.7')]),
              ETag: '"abc123"',
            })
          : Promise.reject(new Error('unexpected command')),
      );
      const target = join(dir, 'original.pdf');

      const result = await service.downloadFile(
        'documents/books/b/e/c/original.pdf',
        target,
      );

      expect(result).toEqual({ etag: 'abc123' });
      expect(readFileSync(target, 'utf8')).toBe('%PDF-1.7');
    });

    it('reports a null ETag when the server sends none', async () => {
      send.mockImplementation(() =>
        Promise.resolve({ Body: Readable.from([Buffer.from('x')]) }),
      );

      await expect(
        service.downloadFile(
          'documents/books/b/e/c/original.pdf',
          join(dir, 'x'),
        ),
      ).resolves.toEqual({ etag: null });
    });
  });

  describe('deleteKeys', () => {
    it('sends nothing for an empty list', async () => {
      await service.deleteKeys([]);
      expect(send).not.toHaveBeenCalled();
    });

    it('batches DeleteObjects at 1000 keys per request', async () => {
      send.mockResolvedValue({});
      const keys = Array.from({ length: 1001 }, (_, i) => `videos/m1/${i}.ts`);

      await service.deleteKeys(keys);

      const batches = sent().filter((c) => c.name === 'DeleteObjectsCommand');
      expect(batches).toHaveLength(2);
      const objectsOf = (input: Record<string, unknown>) =>
        (input.Delete as { Objects: { Key: string }[] }).Objects;
      expect(objectsOf(batches[0].input)).toHaveLength(1000);
      expect(objectsOf(batches[1].input)).toEqual([
        { Key: 'videos/m1/1000.ts' },
      ]);
    });
  });

  describe('signedPlaybackPath / playbackBaseUrl', () => {
    const MOVIE_ID = 'f41b5f3d-cadf-40ab-b789-4192ee772a5e';
    const masterKey = `videos/${MOVIE_ID}/hls/master.m3u8`;

    it('is exactly the path half of signedPlaybackUrl — same token, no origin', () => {
      requestHostContext.run({ hostname: '192.168.1.5' }, () => {
        const url = service.signedPlaybackUrl(masterKey);
        const path = service.signedPlaybackPath(masterKey);
        expect(path).toMatch(
          new RegExp(`^/s/\\d+/[\\w-]+/movies/${masterKey}$`),
        );
        expect(url).toBe(`http://192.168.1.5:8080${path}`);
        expect(service.playbackBaseUrl()).toBe('http://192.168.1.5:8080');
      });
    });

    it('refuses an unsignable key exactly like the full URL does', () => {
      expect(() =>
        service.signedPlaybackPath(`temp/video-replace/${MOVIE_ID}/x.ts`),
      ).toThrow(StreamKeyNotSignable);
    });
  });
});
