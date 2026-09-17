import {
  IMAGE_PURPOSES,
  LOCAL_SCRATCH_ROOT,
  LOCAL_SCRATCH_ROOTS,
  MEDIA_CLASSES,
  NGINX_SCOPE_ALTERNATION,
  OWN_KEY_PREFIXES,
  STREAM_SCOPE_PATTERNS,
  isImagePurpose,
} from './media-taxonomy';

/**
 * The registry is pure data, so these are contract assertions rather than
 * behaviour tests: every one of them fails the moment a row is added, removed
 * or reordered in a way the rest of the system has not been told about.
 */
describe('IMAGE_PURPOSES', () => {
  it('is the nine purpose folders, all lowercase and unique', () => {
    expect([...IMAGE_PURPOSES]).toEqual([
      'actor',
      'movie',
      'series',
      'book',
      'bookauthor',
      'category',
      'payment',
      'music',
      'other',
    ]);
    expect(new Set(IMAGE_PURPOSES).size).toBe(IMAGE_PURPOSES.length);
    for (const purpose of IMAGE_PURPOSES) {
      expect(purpose).toMatch(/^[a-z]+$/);
    }
  });

  it('does not accept `user` — avatars are written only by UsersService', () => {
    // A staff upload that could pick purpose=user would be able to overwrite
    // somebody's avatar folder, so this exclusion is a permission boundary,
    // not tidiness.
    expect(isImagePurpose('user')).toBe(false);
  });

  it('recognises every declared purpose and nothing else', () => {
    for (const purpose of IMAGE_PURPOSES) {
      expect(isImagePurpose(purpose)).toBe(true);
    }
    for (const value of ['', 'Movie', 'poster', null, undefined, 7]) {
      expect(isImagePurpose(value)).toBe(false);
    }
  });
});

describe('MEDIA_CLASSES', () => {
  it('has unique ids and unique prefixes', () => {
    const ids = MEDIA_CLASSES.map((mediaClass) => mediaClass.id);
    const prefixes = MEDIA_CLASSES.map((mediaClass) => mediaClass.prefix);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it('describes every row — an undocumented folder is how a tree rots', () => {
    for (const mediaClass of MEDIA_CLASSES) {
      expect(mediaClass.holds.length).toBeGreaterThan(40);
    }
  });

  it('never gives a public class a signable scope, or the reverse', () => {
    for (const mediaClass of MEDIA_CLASSES) {
      if (mediaClass.visibility === 'private') {
        expect(mediaClass.scopePattern).toBeNull();
      }
      if (mediaClass.scopePattern !== null) {
        expect(mediaClass.visibility).toBe('signed');
      }
    }
  });

  it('keeps images/ public and unsignable in every row', () => {
    for (const mediaClass of MEDIA_CLASSES) {
      if (!mediaClass.prefix.startsWith('images/')) continue;
      expect(mediaClass.visibility).toBe('public');
      expect(mediaClass.scopePattern).toBeNull();
    }
  });

  it('expires temp/ and nothing else', () => {
    const expiring = MEDIA_CLASSES.filter(
      (mediaClass) => mediaClass.retention.kind === 'expires',
    );
    expect(expiring.map((mediaClass) => mediaClass.prefix)).toEqual([
      'temp/<sessionId>/',
    ]);
    expect(expiring[0].retention).toEqual({ kind: 'expires', afterDays: 7 });
  });
});

describe('STREAM_SCOPE_PATTERNS', () => {
  const MOVIE_ID = 'f41b5f3d-cadf-40ab-b789-4192ee772a5e';

  it('is exactly the four signed classes, in registry order', () => {
    // Compared through RegExp rather than as strings: V8 escapes `/` in
    // .source, so the literal template would never match byte for byte.
    expect(STREAM_SCOPE_PATTERNS.map((pattern) => pattern.source)).toEqual(
      MEDIA_CLASSES.filter((mediaClass) => mediaClass.scopePattern).map(
        (mediaClass) =>
          new RegExp(`^(${mediaClass.scopePattern!.key})/(.+)$`).source,
      ),
    );
    expect(STREAM_SCOPE_PATTERNS).toHaveLength(4);
  });

  it('captures the scope prefix and the remainder separately', () => {
    const match = STREAM_SCOPE_PATTERNS[0].exec(
      `videos/${MOVIE_ID}/hls/720p/segment_000.ts`,
    );
    expect(match?.[1]).toBe(`videos/${MOVIE_ID}/hls`);
    expect(match?.[2]).toBe('720p/segment_000.ts');
  });

  it('requires a real remainder — the bare scope addresses no object', () => {
    for (const key of [`videos/${MOVIE_ID}/hls`, `videos/${MOVIE_ID}/hls/`]) {
      expect(
        STREAM_SCOPE_PATTERNS.some((pattern) => pattern.test(key)),
      ).toBe(false);
    }
  });
});

describe('NGINX_SCOPE_ALTERNATION', () => {
  it('is the exact string pasted into both signed nginx locations', () => {
    expect(NGINX_SCOPE_ALTERNATION).toBe(
      'videos/[0-9a-f-]{36}/hls|' +
        'audio/[0-9a-f-]{36}/hls|' +
        'subtitles/[0-9a-f-]{36}|' +
        'books/[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}/pages',
    );
  });

  it('matches the same scopes the TypeScript patterns do', () => {
    // The two sides are different spellings of one pattern (nginx uses the
    // loose [0-9a-f-]{36} form); if they ever disagree about which prefixes
    // are signable, a token mints for a key the cache will not serve.
    const alternation = new RegExp(`^(?:${NGINX_SCOPE_ALTERNATION})$`);
    const ids = [
      'f41b5f3d-cadf-40ab-b789-4192ee772a5e',
      '11111111-2222-4333-8444-555555555555',
      '66666666-7777-4888-9999-aaaaaaaaaaaa',
      'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
    ];
    for (const scope of [
      `videos/${ids[0]}/hls`,
      `audio/${ids[0]}/hls`,
      `subtitles/${ids[0]}`,
      `books/${ids[1]}/${ids[2]}/${ids[3]}/pages`,
    ]) {
      expect(alternation.test(scope)).toBe(true);
      expect(
        STREAM_SCOPE_PATTERNS.some((pattern) => pattern.test(`${scope}/x`)),
      ).toBe(true);
    }
    for (const scope of [
      `videos/${ids[0]}/subtitles`,
      `videos/${ids[0]}/original.mp4`,
      'images/movie/x.jpg',
      `documents/books/${ids[1]}`,
      'temp/abc',
    ]) {
      expect(alternation.test(scope)).toBe(false);
    }
  });
});

describe('OWN_KEY_PREFIXES', () => {
  it('is the top-level namespace of every class, deduplicated', () => {
    expect([...OWN_KEY_PREFIXES].sort()).toEqual([
      'audio/',
      'books/',
      'documents/',
      'images/',
      'subtitles/',
      'temp/',
      'videos/',
    ]);
  });

  it('covers every declared prefix', () => {
    for (const mediaClass of MEDIA_CLASSES) {
      expect(
        OWN_KEY_PREFIXES.some((prefix) => mediaClass.prefix.startsWith(prefix)),
      ).toBe(true);
    }
  });
});

describe('local scratch roots', () => {
  it('is one directory under STORAGE_PATH', () => {
    expect(LOCAL_SCRATCH_ROOT).toBe('temp');
  });

  it('lists the upload sessions plus every class that writes scratch', () => {
    expect([...LOCAL_SCRATCH_ROOTS]).toEqual([
      'uploads',
      'videos',
      'audio',
      'documents/books',
    ]);
  });
});
