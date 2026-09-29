import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The storage lock-down (F-003) in assertions: who may read the bucket
 * anonymously, and what the cache server tells MinIO about who is asking.
 *
 * Two ops files live outside this repo and decide that together:
 *
 *  - storage-server/policies/*.json — the anonymous-read bucket policy. It may
 *    only cover what the cache server serves (images, HLS, subtitle sources,
 *    book pages), never an original, a document or staging, and only for the
 *    cache server's own address.
 *  - cacheserver/nginx/templates/default.conf.template — MinIO evaluates the
 *    policy's aws:SourceIp from X-Forwarded-For / X-Real-IP / Forwarded
 *    BEFORE the socket address. If the cache passed those through, MinIO
 *    would judge a cache MISS by the viewer's address (or by whatever a
 *    viewer typed into the header) instead of the cache's, and every MISS
 *    from a viewer behind a proxy that adds X-Forwarded-For — including a
 *    TLS proxy put in front of the cache later — would 403.
 *
 * Like nginx-scopes.spec.ts, a missing sibling tree SKIPS with the reason
 * visible: the backend can be checked out on its own.
 */
const ROOT = join(__dirname, '..', '..', '..', '..');
const CACHE_TEMPLATE = join(
  ROOT,
  'cacheserver',
  'nginx',
  'templates',
  'default.conf.template',
);
const POLICIES = {
  production: join(
    ROOT,
    'storage-server',
    'policies',
    'movies-read-from-cache.json',
  ),
  local: join(
    ROOT,
    'storage-server',
    'policies',
    'movies-read-from-cache.local.json',
  ),
} as const;

const ID = '731798fd-ca56-4650-86b6-32e96169c25e';

/** Keys the cache serves — the policy must let the cache read every one. */
const CACHE_SERVED_KEYS = [
  `images/movie/${ID}.jpg`,
  `images/user/${ID}/1727500000000.png`,
  `videos/${ID}/hls/master.m3u8`,
  `videos/${ID}/hls/v-c6592c79/720p/segment_000.ts`,
  `videos/${ID}/hls/v-c6592c79/subs/${ID}.vtt`,
  `audio/${ID}/hls/master.m3u8`,
  `subtitles/${ID}/${ID}.srt`,
  `books/${ID}/${ID}/${ID}/pages/page-001.webp`,
];

/** Keys only the backend reads, with its access key — no anonymous grant. */
const BACKEND_ONLY_KEYS = [
  `videos/${ID}/original.mp4`,
  `audio/${ID}/original.m4a`,
  `documents/books/${ID}/${ID}/${ID}/original.pdf`,
  `documents/bank-screenshots/transactions/${ID}/a3bc636e.png`,
  `temp/${ID}/part-source.bin`,
];

interface PolicyStatement {
  Effect: string;
  Principal: { AWS: string[] };
  Action: string[];
  Resource: string[];
  Condition?: { IpAddress?: { 'aws:SourceIp'?: string[] } };
}

/** MinIO/S3 resource matching: `*` is any run of characters, `/` included. */
const resourceMatches = (pattern: string, arn: string): boolean =>
  new RegExp(
    `^${pattern
      .split('*')
      .map((part) =>
        part
          .split('?')
          .map((p) => p.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
          .join('.'),
      )
      .join('.*')}$`,
  ).test(arn);

const ipv4ToInt = (ip: string): number =>
  ip.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0);

/** [first, last] address of an IPv4 CIDR, as integers. */
const cidrRange = (cidr: string): [number, number] => {
  const [ip, bits = '32'] = cidr.split('/');
  const size = 2 ** (32 - Number(bits));
  const first = Math.floor(ipv4ToInt(ip) / size) * size;
  return [first, first + size - 1];
};

const overlaps = (a: string, b: string): boolean => {
  const [a0, a1] = cidrRange(a);
  const [b0, b1] = cidrRange(b);
  return a0 <= b1 && b0 <= a1;
};

describe('movies bucket anonymous-read policies', () => {
  for (const [name, path] of Object.entries(POLICIES)) {
    describe(name, () => {
      if (!existsSync(path)) {
        it.skip(`SKIPPED — ${path} is not present (storage-server/ is a separate deploy unit)`, () => {
          // Intentionally empty: recorded as a skip so the reason is visible.
        });
        return;
      }

      const policy = JSON.parse(readFileSync(path, 'utf8')) as {
        Statement: PolicyStatement[];
      };

      it('is one anonymous GetObject grant with a source-address condition', () => {
        expect(policy.Statement).toHaveLength(1);
        const [statement] = policy.Statement;
        expect(statement.Effect).toBe('Allow');
        expect(statement.Principal).toEqual({ AWS: ['*'] });
        // No ListBucket: nobody enumerates keys anonymously.
        expect(statement.Action).toEqual(['s3:GetObject']);
        expect(
          statement.Condition?.IpAddress?.['aws:SourceIp']?.length ?? 0,
        ).toBeGreaterThan(0);
      });

      it('covers every key the cache serves', () => {
        const [statement] = policy.Statement;
        for (const key of CACHE_SERVED_KEYS) {
          const arn = `arn:aws:s3:::movies/${key}`;
          expect({
            key,
            granted: statement.Resource.some((r) => resourceMatches(r, arn)),
          }).toEqual({ key, granted: true });
        }
      });

      it('covers no original, document or staging object', () => {
        const [statement] = policy.Statement;
        for (const key of BACKEND_ONLY_KEYS) {
          const arn = `arn:aws:s3:::movies/${key}`;
          expect({
            key,
            granted: statement.Resource.some((r) => resourceMatches(r, arn)),
          }).toEqual({ key, granted: false });
        }
      });
    });
  }

  describe('local', () => {
    if (!existsSync(POLICIES.local)) {
      it.skip(`SKIPPED — ${POLICIES.local} is not present`, () => {
        // Intentionally empty.
      });
      return;
    }

    it("does not allow Docker's bridge range, where the upload proxy sits", () => {
      // The upload proxy reaches MinIO over the storage compose network
      // (172.16.0.0/12 by Docker's default pools; 172.19.0.3 when measured).
      // Allowing that range re-opens anonymous reads through the public :8443
      // proxy, which is exactly the hole this policy exists to close.
      //
      // The one exception is a single bridge GATEWAY address (x.x.x.1/32):
      // after a Docker Desktop restart on 2026-09-29 MinIO saw the cache
      // (and every published-port client) as 172.19.0.1, the gateway of
      // storage-server_default. No container can hold a gateway address,
      // so allowing exactly that /32 never admits the upload proxy.
      const policy = JSON.parse(readFileSync(POLICIES.local, 'utf8')) as {
        Statement: PolicyStatement[];
      };
      const allowed =
        policy.Statement[0].Condition?.IpAddress?.['aws:SourceIp'] ?? [];
      const isBridgeGateway = (cidr: string): boolean =>
        /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.1\/32$/.test(cidr);
      expect(
        allowed.filter(
          (cidr) => overlaps(cidr, '172.16.0.0/12') && !isBridgeGateway(cidr),
        ),
      ).toEqual([]);
      expect(allowed.filter((cidr) => overlaps(cidr, '172.19.0.3/32'))).toEqual(
        [],
      );
    });
  });
});

describe('cache server → storage request headers', () => {
  if (!existsSync(CACHE_TEMPLATE)) {
    it.skip(`SKIPPED — ${CACHE_TEMPLATE} is not present (cacheserver/ is a separate deploy unit)`, () => {
      // Intentionally empty.
    });
    return;
  }

  const template = readFileSync(CACHE_TEMPLATE, 'utf8');
  // Comments mention these headers too; only directives count.
  const directives = template
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter(Boolean);
  const firstLocation = directives.findIndex((d) => d.startsWith('location'));

  it.each(['X-Forwarded-For', 'X-Real-IP', 'Forwarded'])(
    'blanks %s for every location (server level)',
    (header) => {
      // An empty value makes nginx drop the header, so MinIO sees the cache's
      // own socket address, which is what the bucket policy allows.
      const at = directives.indexOf(`proxy_set_header ${header} "";`);
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeLessThan(firstLocation);
    },
  );

  it('sets no proxy_set_header inside a location (that would drop the inherited ones)', () => {
    // nginx inherits proxy_set_header only into a block that defines none of
    // its own — one header set in a location silently discards the blanks.
    const inLocations = directives
      .slice(firstLocation)
      .filter((d) => d.startsWith('proxy_set_header'));
    expect(inLocations).toEqual([]);
  });
});
