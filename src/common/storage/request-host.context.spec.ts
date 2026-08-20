import { ClientPlatform } from '../../generated/prisma/client';
import {
  normalizeIp,
  requestClientContext,
  requestHostContext,
  resolveClientIp,
  resolveClientPlatform,
} from './request-host.context';

/**
 * The per-request context middleware in main.ts is the single place IP and
 * platform enter the system, so everything it decides is pulled out into the
 * pure functions covered here — the middleware itself is then three
 * assignments with nothing left to get wrong.
 */
describe('normalizeIp', () => {
  it('collapses an IPv4-mapped IPv6 address to plain IPv4', () => {
    // Node hands this back for an IPv4 client on a dual-stack socket.
    expect(normalizeIp('::ffff:192.168.1.5')).toBe('192.168.1.5');
    expect(normalizeIp('::FFFF:10.0.0.42')).toBe('10.0.0.42');
  });

  it('spells IPv6 loopback the same way IPv4 loopback is spelled', () => {
    // Otherwise one machine is two different values, and "is this IP shared
    // between users" answers wrong purely on socket family.
    expect(normalizeIp('::1')).toBe('127.0.0.1');
  });

  it('leaves a real IPv4 or IPv6 address alone', () => {
    expect(normalizeIp('203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeIp('2001:db8::1')).toBe('2001:db8::1');
  });

  it('treats missing, empty and whitespace-only input as unknown', () => {
    expect(normalizeIp(null)).toBeNull();
    expect(normalizeIp(undefined)).toBeNull();
    expect(normalizeIp('')).toBeNull();
    expect(normalizeIp('   ')).toBeNull();
  });

  it('trims surrounding whitespace, which x-forwarded-for entries carry', () => {
    expect(normalizeIp(' 203.0.113.7 ')).toBe('203.0.113.7');
  });
});

describe('resolveClientIp', () => {
  it('takes the FIRST hop of x-forwarded-for — the original client', () => {
    // Each proxy appends itself, so the last entry is the nearest proxy.
    expect(
      resolveClientIp('203.0.113.7, 70.41.3.18, 150.172.238.178', '10.0.0.1'),
    ).toBe('203.0.113.7');
  });

  it('normalises the forwarded value too', () => {
    expect(resolveClientIp('::ffff:203.0.113.7', '10.0.0.1')).toBe(
      '203.0.113.7',
    );
  });

  it('handles a repeated header arriving as an array', () => {
    expect(resolveClientIp(['203.0.113.7', '198.51.100.4'], '10.0.0.1')).toBe(
      '203.0.113.7',
    );
  });

  it('falls back to the socket peer when there is no proxy header', () => {
    expect(resolveClientIp(undefined, '::ffff:192.168.1.5')).toBe(
      '192.168.1.5',
    );
  });

  it('falls back to the socket peer when the header is present but empty', () => {
    expect(resolveClientIp('', '192.168.1.5')).toBe('192.168.1.5');
    expect(resolveClientIp('  ,  ', '192.168.1.5')).toBe('192.168.1.5');
  });

  it('is null when neither source knows — never a fabricated address', () => {
    expect(resolveClientIp(undefined, undefined)).toBeNull();
  });
});

describe('resolveClientPlatform', () => {
  const CHROME =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
  const IOS_SAFARI =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

  it('trusts the header both first-party clients send', () => {
    expect(resolveClientPlatform('WEB', CHROME)).toBe(ClientPlatform.WEB);
    expect(resolveClientPlatform('MOBILE', CHROME)).toBe(ClientPlatform.MOBILE);
  });

  it('accepts the header in any casing, with padding, or repeated', () => {
    expect(resolveClientPlatform(' mobile ', null)).toBe(ClientPlatform.MOBILE);
    expect(resolveClientPlatform(['web'], null)).toBe(ClientPlatform.WEB);
  });

  it('ignores an unrecognised header value and falls through to the sniff', () => {
    expect(resolveClientPlatform('tv', CHROME)).toBe(ClientPlatform.WEB);
    expect(resolveClientPlatform('desktop', null)).toBe(ClientPlatform.UNKNOWN);
  });

  it('sniffs native-app clients as MOBILE', () => {
    for (const ua of [
      'MyanFlix/1.0.0 (Expo; iOS 17.5)',
      'okhttp/4.12.0',
      'CFNetwork/1494.0.7 Darwin/23.4.0',
      'Dalvik/2.1.0 (Linux; U; Android 14)',
    ]) {
      expect(resolveClientPlatform(undefined, ua)).toBe(ClientPlatform.MOBILE);
    }
  });

  it('sniffs a PHONE BROWSER as WEB, not MOBILE', () => {
    // The whole point of the ordering: someone on iOS Safari is using the
    // website, so "iPhone" in the UA must never win over "browser-shaped".
    expect(resolveClientPlatform(undefined, IOS_SAFARI)).toBe(
      ClientPlatform.WEB,
    );
    expect(resolveClientPlatform(undefined, CHROME)).toBe(ClientPlatform.WEB);
  });

  it('is UNKNOWN for anything it cannot recognise, which is not an error', () => {
    expect(resolveClientPlatform(undefined, undefined)).toBe(
      ClientPlatform.UNKNOWN,
    );
    expect(resolveClientPlatform(undefined, '')).toBe(ClientPlatform.UNKNOWN);
    expect(resolveClientPlatform(undefined, 'curl/8.4.0')).toBe(
      ClientPlatform.UNKNOWN,
    );
  });
});

describe('requestClientContext', () => {
  it('reads back what the middleware stored', () => {
    const context = requestHostContext.run(
      {
        hostname: '192.168.100.27',
        ip: '203.0.113.7',
        userAgent: 'okhttp/4.12.0',
        platform: ClientPlatform.MOBILE,
      },
      () => requestClientContext(),
    );

    expect(context).toEqual({
      ip: '203.0.113.7',
      userAgent: 'okhttp/4.12.0',
      platform: ClientPlatform.MOBILE,
    });
  });

  it('is total outside any request — a cron gets UNKNOWN, not a throw', () => {
    expect(requestClientContext()).toEqual({
      ip: null,
      userAgent: null,
      platform: ClientPlatform.UNKNOWN,
    });
  });

  it('defaults every tracking field when only a hostname was stored', () => {
    // Widening the store must not break the hostname-only callers that
    // predate tracking (MinioService's own tests enter the context this way).
    const context = requestHostContext.run({ hostname: 'localhost' }, () =>
      requestClientContext(),
    );

    expect(context).toEqual({
      ip: null,
      userAgent: null,
      platform: ClientPlatform.UNKNOWN,
    });
  });
});
