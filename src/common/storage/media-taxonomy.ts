/**
 * THE media layout. Every prefix this system writes — in the object store and
 * on local scratch disk — is declared here once and nowhere else.
 *
 * Three things used to be hand-maintained copies of the same fact, and the
 * expensive one was the signing scope: the `(?<scope>...)` alternation lives
 * in TWO nginx locations (playlists and everything-else) and a third time as
 * SCOPES in stream-signature.ts. Editing one and forgetting another does not
 * fail loudly — it breaks playlists but not segments, or the reverse, which
 * reads as flaky playback rather than a config bug. So both the TypeScript
 * regexes and the nginx alternation are GENERATED from MEDIA_CLASSES below,
 * and nginx-scopes.spec.ts fails when the checked-in template drifts from it.
 *
 * The rule the whole tree follows is SOURCE vs GENERATED:
 *
 *   source (uploaded, never served to a player, never signable)
 *     videos/<movieId>/original.<ext>
 *     audio/<audioId>/original.<ext>          (reserved)
 *     subtitles/<movieId>/<name>.<ext>        (signable — see below)
 *     documents/books/<b>/<e>/<c>/original.pdf
 *
 *   generated (produced by us, served through the cache under a signed scope)
 *     videos/<movieId>/hls/**
 *     audio/<audioId>/hls/**                  (reserved)
 *     books/<b>/<e>/<c>/pages/**
 *
 *   public by key (no token, no scope — this is what makes the catalogue
 *   browsable, and it is why nothing private may ever be given an
 *   `images/` purpose folder)
 *     images/<purpose>/<id><ext>
 *     images/user/<userId>/<stamp><ext>
 *
 * TWO DELIBERATE EXCEPTIONS, both explained on their rows below:
 *   1. videos/<movieId>/hls/subs/ holds GENERATED subtitle renditions under
 *      videos/, not under subtitles/, because master.m3u8 names them by
 *      RELATIVE URI and one token must cover them.
 *   2. Generated book pages stay under books/, not under images/, because
 *      images/ is public-by-key and book pages are paid content.
 *
 * Adding a folder means adding a row here. A row is real code that the
 * compiler, the scope generator and the retention logic all see, which is
 * what stops a "reserved" namespace from quietly rotting into prose.
 */

/** Strict lowercase 8-4-4-4-12 — the shape every id we mint actually has. */
export const UUID =
  '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/**
 * nginx's config parser trips on a bare `{36}`, so the alternation is quoted
 * in the template; it also has no need for the strict UUID shape, since the
 * backend only ever mints a token for a key that matched the strict form
 * above. `[0-9a-f-]{36}` is the cheap equivalent on that side.
 */
const NGINX_UUID = '[0-9a-f-]{36}';

/**
 * A signable scope: the PREFIX a token unlocks, not the object itself. Both
 * halves describe the same string — `key` matches an object key in the
 * backend, `nginx` is the arm pasted into the cache server's alternation.
 * They must stay two spellings of one pattern.
 */
export interface MediaScopePattern {
  readonly key: string;
  readonly nginx: string;
}

/** Permanent, or swept by the object store after N days. */
export type MediaRetention =
  | { readonly kind: 'permanent' }
  | { readonly kind: 'expires'; readonly afterDays: number };

export interface MediaClass {
  /** Stable identifier — used by tests and the generated layout doc. */
  readonly id: string;
  /** Key template, with <placeholders> for the id segments. */
  readonly prefix: string;
  /** `reserved` = the shape is decided and wired, nothing writes it yet. */
  readonly status: 'active' | 'reserved';
  /**
   * public  — served unsigned, absent from the cache's deny map.
   * signed  — served only through a /s/<expires>/<sig>/ token.
   * private — never served through the cache at all; backend-only S3 reads.
   */
  readonly visibility: 'public' | 'signed' | 'private';
  /** The scope this class is signed under, or null when it has none. */
  readonly scopePattern: MediaScopePattern | null;
  readonly retention: MediaRetention;
  /**
   * True for the big, cold bytes a future cold-tier job would move. Nothing
   * reads this yet; it exists so that job has a declared list rather than a
   * hand-written one.
   */
  readonly archivable: boolean;
  /**
   * Directory under <STORAGE_PATH>/temp/ where this class's transient local
   * files live while they are being produced, or null when it has none.
   */
  readonly localScratchRoot: string | null;
  readonly holds: string;
}

const PERMANENT: MediaRetention = { kind: 'permanent' };

/**
 * Order matters in exactly one way: the signed rows are read top-to-bottom
 * to build the alternation, so reordering them rewrites the generated string
 * and (correctly) fails the nginx sync test until the template is repasted.
 */
export const MEDIA_CLASSES: readonly MediaClass[] = [
  {
    id: 'image',
    prefix: 'images/<purpose>/',
    status: 'active',
    visibility: 'public',
    scopePattern: null,
    retention: PERMANENT,
    archivable: false,
    localScratchRoot: null,
    holds:
      'Every uploaded still image, foldered by purpose (see IMAGE_PURPOSES). ' +
      'Flat <uuid><ext> filename inside each purpose folder — images are ' +
      'uploaded BEFORE their owner row exists, so no owner id is available ' +
      'at write time. Public and unsigned by design: no signable scope, and ' +
      'images/ is deliberately absent from the cache server deny map so the ' +
      'catalogue stays browsable without a token.',
  },
  {
    id: 'imageUser',
    prefix: 'images/user/<userId>/',
    status: 'active',
    visibility: 'public',
    scopePattern: null,
    retention: PERMANENT,
    archivable: false,
    localScratchRoot: null,
    holds:
      'User profile pictures, one folder per user, filename is the epoch-ms ' +
      'version stamp so a replaced avatar can never collide with the cache ' +
      "server's 7d entry for the old one. The folder is what gives account " +
      'deletion a real prefix delete. `user` is deliberately NOT an accepted ' +
      'value on POST /uploads/image — the purpose is hard-coded server-side ' +
      "in UsersService — so no staff upload can land in a user's folder.",
  },
  {
    id: 'videoOriginal',
    prefix: 'videos/<movieId>/original.<ext>',
    status: 'active',
    visibility: 'private',
    scopePattern: null,
    retention: PERMANENT,
    archivable: true,
    localScratchRoot: 'videos',
    holds:
      'The archived pre-transcode master upload. MUST stay a direct child ' +
      'literally named original.* — the cache denies ' +
      'videos/<id>/original. unconditionally in BOTH legacy modes and ' +
      'scopeForKey refuses to sign it. Read only server-side over ' +
      'credentialed S3. A series episode is a Movie row, so an episode’s ' +
      'media lives here under its own episode id.',
  },
  {
    id: 'videoHls',
    prefix: 'videos/<movieId>/hls/',
    status: 'active',
    visibility: 'signed',
    scopePattern: {
      key: `videos/${UUID}/hls`,
      nginx: `videos/${NGINX_UUID}/hls`,
    },
    retention: PERMANENT,
    archivable: false,
    localScratchRoot: 'videos',
    holds:
      'The complete generated playback package and nothing else: ' +
      'master.m3u8, one flat folder per rendition (<tier>/index.m3u8 + ' +
      'segment_NNN.ts), and subs/. This directory IS the signed scope and IS ' +
      'the relative-URI root every player resolves segment names against.',
  },
  {
    id: 'videoHlsSubs',
    prefix: 'videos/<movieId>/hls/subs/',
    status: 'active',
    visibility: 'signed',
    scopePattern: null, // covered by videoHls — one token per title.
    holds:
      'Generated WebVTT subtitle renditions and their single-segment wrapper ' +
      'playlists (<subtitleId>.vtt and <subtitleId>.m3u8). DELIBERATE ' +
      'EXCEPTION 1 to the taxonomy: a subtitle file living under videos/. It ' +
      'is a hard technical requirement, not a taste call — master.m3u8 names ' +
      'these by RELATIVE URI (`subs/<id>.m3u8`), so they must resolve under ' +
      'the same scope prefix the master was signed with. Moving them to ' +
      'subtitles/ would need a second token the player has no way to fetch.',
    retention: PERMANENT,
    archivable: false,
    localScratchRoot: 'videos',
  },
  {
    id: 'audioOriginal',
    prefix: 'audio/<audioId>/original.<ext>',
    status: 'reserved',
    visibility: 'private',
    scopePattern: null,
    retention: PERMANENT,
    archivable: true,
    localScratchRoot: 'audio',
    holds:
      'RESERVED for a music track or audiobook chapter master. Same rules as ' +
      'a video original: direct child named original.*, denied unsigned, ' +
      'never signable, read only server-side.',
  },
  {
    id: 'audioHls',
    prefix: 'audio/<audioId>/hls/',
    status: 'reserved',
    visibility: 'signed',
    scopePattern: {
      key: `audio/${UUID}/hls`,
      nginx: `audio/${NGINX_UUID}/hls`,
    },
    retention: PERMANENT,
    archivable: false,
    localScratchRoot: 'audio',
    holds:
      'RESERVED generated audio HLS (master.m3u8, <bitrate>/index.m3u8 + ' +
      'segments). Deliberately the SAME internal shape as videos/<id>/hls so ' +
      'an audio feature inherits signing, caching, relative URIs and ' +
      'single-prefix delete with no new mechanism. Its scope arm and its ' +
      'deny arms ship now, while they cost nothing: with no objects present ' +
      'a token signs a prefix that storage 404s.',
  },
  {
    id: 'subtitleSource',
    prefix: 'subtitles/<movieId>/',
    status: 'active',
    visibility: 'signed',
    scopePattern: {
      key: `subtitles/${UUID}`,
      nginx: `subtitles/${NGINX_UUID}`,
    },
    retention: PERMANENT,
    archivable: false,
    localScratchRoot: null,
    holds:
      'ALL uploaded subtitle SOURCE files (.srt/.vtt/.ass), from both the ' +
      'single-file upload and the bulk/external bundle. Keyed by the OWNING ' +
      'MOVIE, not by the subtitle id, which is what collapses the two rival ' +
      'shapes this replaced into one namespace. Single upload writes ' +
      "<subtitleId><ext>; the bulk bundle keeps the operator's own filename. " +
      'Denied unsigned; signable only so the stream response’s existing ' +
      'subtitles[].url field can stay a working link.',
  },
  {
    id: 'bookDocument',
    prefix: 'documents/books/<bookId>/<editionId>/<chapterId>/original.pdf',
    status: 'active',
    visibility: 'private',
    scopePattern: null,
    retention: PERMANENT,
    archivable: true,
    localScratchRoot: 'documents/books',
    holds:
      'The uploaded chapter source PDF. It lives under documents/ rather ' +
      'than books/ so documents/ is uniformly "private source, never served, ' +
      'never signable" and books/ is uniformly "generated reader output". ' +
      'The three-id depth is preserved exactly, so a book, an edition and a ' +
      'chapter delete each stay ONE prefix delete on the document side too.',
  },
  {
    id: 'bookPages',
    prefix: 'books/<bookId>/<editionId>/<chapterId>/pages/',
    status: 'active',
    visibility: 'signed',
    scopePattern: {
      key: `books/${UUID}/${UUID}/${UUID}/pages`,
      nginx: `books/${NGINX_UUID}/${NGINX_UUID}/${NGINX_UUID}/pages`,
    },
    retention: PERMANENT,
    archivable: false,
    localScratchRoot: null,
    holds:
      'Generated reader page images (WebP), page number zero-padded to ' +
      'max(3, len(totalPages)). The depth, the three id levels and the ' +
      'literal "pages" segment are load-bearing: they are the signed scope ' +
      'and the one-token-per-chapter guarantee the reader relies on. ' +
      'DELIBERATE EXCEPTION 2 to the taxonomy: these are images and they do ' +
      'NOT move under images/, because images/ is public by key while a book ' +
      'page is paid content that must only ever be reachable with a token.',
  },
  {
    id: 'document',
    prefix: 'documents/<kind>/<ownerId>/',
    status: 'reserved',
    visibility: 'private',
    scopePattern: null,
    retention: PERMANENT,
    archivable: true,
    localScratchRoot: null,
    holds:
      'RESERVED for non-book documents (kind = legal, report, invoice, ...). ' +
      'The whole documents/ namespace is unconditionally denied at the cache ' +
      'and unsignable, so a new kind needs no cache, signing or bucket ' +
      'policy change at all. A document that must ever be public would need ' +
      'its own documents/public/ arm — deliberately an explicit exception ' +
      'rather than a loosening of the namespace.',
  },
  {
    id: 'bankScreenshot',
    prefix: 'documents/bank-screenshots/<kind>/<id>/',
    status: 'active',
    visibility: 'private',
    scopePattern: null,
    retention: PERMANENT,
    archivable: false,
    localScratchRoot: null,
    holds:
      'The phone-monitor screenshot of the bank notification that was matched ' +
      'to one deposit or withdrawal (<kind> = deposits | withdrawals, <id> = ' +
      'that row, filename = the bank event idempotency key + .png). It shows ' +
      'the business account BALANCE, so it lives under documents/ — denied ' +
      'unconditionally at the cache, unsignable, readable only server-side ' +
      'over credentialed S3 and streamed to staff who hold BANK_EVIDENCE. ' +
      'Permanent: it is the evidence behind a credit. One folder per row so ' +
      'an unlink or a row delete is one prefix delete.',
  },
  {
    id: 'temp',
    prefix: 'temp/<sessionId>/',
    status: 'reserved',
    visibility: 'private',
    scopePattern: null,
    retention: { kind: 'expires', afterDays: 7 },
    archivable: false,
    localScratchRoot: null,
    holds:
      'RESERVED object-store staging for an upload whose final key is not ' +
      'yet known. Nothing writes it today — multipart assembles straight at ' +
      'the final key. Denied unsigned, unsignable, and carrying a 7-day ' +
      'expiry so an abandoned staging object can never become permanent cost.',
  },
];

/**
 * The purposes POST /uploads/image accepts, and therefore the folders under
 * images/. A missing or unknown purpose is a 400 that lists these values —
 * there is no catch-all fallback, because a mis-foldered image is invisible
 * to every cleanup path that works by prefix.
 *
 * `user` is absent on purpose: avatars are written only by UsersService,
 * which hard-codes AVATAR_IMAGE_PURPOSE, so no staff upload can ever land in
 * a user's folder.
 */
export const IMAGE_PURPOSES = [
  'actor',
  'movie',
  'series',
  'book',
  'bookauthor',
  'category',
  'payment',
  'music',
  'other',
] as const;

export type ImagePurpose = (typeof IMAGE_PURPOSES)[number];

/** The one purpose folder staff cannot upload into — see IMAGE_PURPOSES. */
export const AVATAR_IMAGE_PURPOSE = 'user';

/** True for a value that names a real purpose folder. */
export function isImagePurpose(value: unknown): value is ImagePurpose {
  return IMAGE_PURPOSES.includes(value as ImagePurpose);
}

const SIGNED_CLASSES = MEDIA_CLASSES.filter(
  (
    mediaClass,
  ): mediaClass is MediaClass & { scopePattern: MediaScopePattern } =>
    mediaClass.scopePattern !== null,
);

/**
 * The signable scopes, in registry order, each capturing the scope prefix and
 * the path remainder. The remainder is `(.+)` rather than `(.*)`: a token for
 * the bare scope addresses no object, and scopeForKey checks the remainder
 * for `.` / `..` hops separately.
 */
export const STREAM_SCOPE_PATTERNS: readonly RegExp[] = SIGNED_CLASSES.map(
  (mediaClass) => new RegExp(`^(${mediaClass.scopePattern.key})/(.+)$`),
);

/**
 * The exact string that goes inside `(?<scope>...)` in BOTH signed locations
 * of cacheserver/nginx/templates/default.conf.template. Print it with
 * `npx ts-node scripts/print-stream-scopes.ts`; nginx-scopes.spec.ts asserts
 * the template contains it exactly twice.
 */
export const NGINX_SCOPE_ALTERNATION = SIGNED_CLASSES.map(
  (mediaClass) => mediaClass.scopePattern.nginx,
).join('|');

/**
 * The top-level namespaces this system owns. A URL only counts as "ours" if
 * its key starts with one of them — see MinioService.ownImageKey, which uses
 * this to avoid claiming a third-party URL that merely happens to begin with
 * the bucket name.
 */
export const OWN_KEY_PREFIXES: readonly string[] = [
  ...new Set(
    MEDIA_CLASSES.map((mediaClass) => `${mediaClass.prefix.split('/')[0]}/`),
  ),
];

/** The single local directory every transient file lives under. */
export const LOCAL_SCRATCH_ROOT = 'temp';

/**
 * In-flight chunked uploads — the one scratch root with no object class of
 * its own, because a chunk never becomes an object under its own key: the
 * chunks are merged and the merged file is uploaded at the final key.
 */
export const UPLOAD_SCRATCH_ROOT = 'uploads';

/**
 * Every directory that may exist directly under <STORAGE_PATH>/temp/. The
 * cleanup sweep walks exactly this list, which is why it is derived rather
 * than written out: a new class with local scratch is swept the day it is
 * added.
 */
export const LOCAL_SCRATCH_ROOTS: readonly string[] = [
  ...new Set([
    UPLOAD_SCRATCH_ROOT,
    ...MEDIA_CLASSES.map((mediaClass) => mediaClass.localScratchRoot).filter(
      (root): root is string => root !== null,
    ),
  ]),
];
