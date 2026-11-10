/**
 * The outbound-HTTP pieces the TMDB client and the TMDB image fetcher
 * share — the house pattern of lottery/results/thai-lotto-json.source.ts:
 * an injectable fetch (the specs hand in a fake; nothing in a test ever
 * reaches TMDB), a deadline on the whole call, redirects refused, and a
 * body that is read as a stream and dropped the moment it passes its cap.
 */

/** The part of a fetch Response this module reads (the specs hand in a plain object). */
export interface TmdbFetchResponse {
  status: number;
  headers: { get(name: string): string | null };
  /** The body as a stream when the runtime offers one (Node's fetch does); read under the size cap. */
  body?: {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>;
      cancel(): Promise<void>;
    };
  } | null;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type TmdbFetch = (
  input: string,
  init: {
    signal: AbortSignal;
    headers: Record<string, string>;
    /** Never followed: an answer must not be able to bounce the server to another host. */
    redirect: 'error';
  },
) => Promise<TmdbFetchResponse>;

/**
 * The body as bytes, or null when it is past `max`: refused on the
 * Content-Length when one is sent, else read as a stream and dropped the
 * moment the cap is passed, so no answer can make the server hold more
 * than `max` bytes of it. A response without a stream (the specs' fakes)
 * is read whole and measured.
 */
export async function readBodyCapped(
  response: TmdbFetchResponse,
  max: number,
): Promise<Buffer | null> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    await discardBody(response);
    return null;
  }
  const stream = response.body;
  if (!stream || typeof stream.getReader !== 'function') {
    const whole = Buffer.from(await response.arrayBuffer());
    return whole.length > max ? null : whole;
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Lets go of a body nobody will read (an error answer), so its connection is not held open. */
export async function discardBody(response: TmdbFetchResponse): Promise<void> {
  try {
    await response.body?.getReader().cancel();
  } catch {
    // Already read, locked or closed — nothing left to let go of.
  }
}

/**
 * True when a fetch ended because its deadline passed (what
 * AbortSignal.timeout() makes fetch, or the read of its body, reject with)
 * — as opposed to a host that could not be reached at all.
 */
export function isFetchTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  );
}

/**
 * What went wrong with a fetch, for a log line: the error's class and the
 * system code behind it (`TimeoutError`, `TypeError ENOTFOUND`) and never
 * its message. Node puts the request URL into some fetch messages, and a
 * TMDB URL can carry the API key and the film name staff searched for.
 */
export function describeFetchError(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown error';
  if (isFetchTimeout(error)) return 'timed out';
  const cause = (error as { cause?: unknown }).cause;
  const code =
    typeof cause === 'object' && cause !== null
      ? (cause as { code?: unknown }).code
      : undefined;
  return typeof code === 'string' && /^[A-Z0-9_]+$/.test(code)
    ? `${error.name} ${code}`
    : error.name;
}
