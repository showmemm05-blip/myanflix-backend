import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { MinioService } from './minio.service';
import { requestHostContext } from './request-host.context';

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
      expect(asRequestFrom('192.168.100.27', () => service.imageUrl(external))).toBe(
        external,
      );
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
