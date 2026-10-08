import {
  trustedClientIp,
  trustedProxies,
  trustedProxyList,
} from './trusted-proxies';

/**
 * M-5: X-Forwarded-For is believed only when the connecting peer is a listed
 * proxy. Before this rule the first hop was believed from anyone, so a
 * client could choose which address the tracking rows, the audit log and
 * the live "active users" list recorded for it.
 */
describe('trustedClientIp', () => {
  const original = process.env.TRUSTED_PROXIES;
  afterEach(() => {
    if (original === undefined) delete process.env.TRUSTED_PROXIES;
    else process.env.TRUSTED_PROXIES = original;
  });

  it('ignores X-Forwarded-For from a peer that is not a trusted proxy (the default: no proxies)', () => {
    delete process.env.TRUSTED_PROXIES;
    expect(trustedClientIp('203.0.113.9', '198.51.100.4')).toBe('198.51.100.4');
    process.env.TRUSTED_PROXIES = '';
    expect(trustedClientIp('203.0.113.9', '198.51.100.4')).toBe('198.51.100.4');
  });

  it('believes the first forwarded hop only when the peer is listed', () => {
    process.env.TRUSTED_PROXIES = '172.18.0.5, 10.0.0.2';
    expect(
      trustedClientIp('203.0.113.7, 70.41.3.18', '::ffff:172.18.0.5'),
    ).toBe('203.0.113.7');
    expect(trustedClientIp('203.0.113.7', '10.0.0.2')).toBe('203.0.113.7');
    // Another peer with the same header: still its own address.
    expect(trustedClientIp('203.0.113.7', '192.0.2.44')).toBe('192.0.2.44');
  });

  it('falls back to the proxy itself when the trusted proxy sent no usable header', () => {
    process.env.TRUSTED_PROXIES = '172.18.0.5';
    expect(trustedClientIp(undefined, '172.18.0.5')).toBe('172.18.0.5');
    expect(trustedClientIp('', '172.18.0.5')).toBe('172.18.0.5');
  });

  it('normalises the peer (IPv4-mapped, loopback) like every stored IP', () => {
    delete process.env.TRUSTED_PROXIES;
    expect(trustedClientIp(undefined, '::ffff:192.168.1.5')).toBe(
      '192.168.1.5',
    );
    expect(trustedClientIp('203.0.113.9', '::1')).toBe('127.0.0.1');
    expect(trustedClientIp('203.0.113.9', undefined)).toBeNull();
  });

  it('exposes the list for Express (empty = trust nobody) and re-reads it when the env changes', () => {
    process.env.TRUSTED_PROXIES = '';
    expect(trustedProxyList()).toEqual([]);
    process.env.TRUSTED_PROXIES = ' ::ffff:10.0.0.9 ,, 10.0.0.10 ';
    expect(trustedProxyList()).toEqual(['10.0.0.9', '10.0.0.10']);
    expect(trustedProxies().has('10.0.0.9')).toBe(true);
  });
});
