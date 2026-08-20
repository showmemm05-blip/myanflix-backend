import {
  maskIpAddress,
  maskPhoneNumber,
  presentIp,
  presentPhone,
  PII_FULL_MASK,
} from './pii.util';

describe('maskPhoneNumber', () => {
  it('reveals the first two and last three characters', () => {
    expect(maskPhoneNumber('09250495369')).toBe('09*****369');
  });

  it('masks an E.164 number without reformatting it', () => {
    expect(maskPhoneNumber('+95950495369')).toBe('+9*****369');
  });

  it('hides the length — two numbers of different lengths mask alike', () => {
    expect(maskPhoneNumber('0912345678')).toBe('09*****678');
    expect(maskPhoneNumber('091234567890123')).toBe('09*****123');
  });

  it('never leaves more than five characters readable', () => {
    const masked = maskPhoneNumber('09250495369')!;
    const revealed = masked.replace(/\*/g, '');
    expect(revealed).toHaveLength(5);
  });

  it('fully masks a value too short to reveal anything from', () => {
    expect(maskPhoneNumber('12345')).toBe(PII_FULL_MASK);
    expect(maskPhoneNumber('1')).toBe(PII_FULL_MASK);
  });

  it('treats null, undefined and whitespace as no phone at all', () => {
    expect(maskPhoneNumber(null)).toBeNull();
    expect(maskPhoneNumber(undefined)).toBeNull();
    expect(maskPhoneNumber('   ')).toBeNull();
  });
});

describe('maskIpAddress', () => {
  it('blanks the host octet of an IPv4 address, keeping the network', () => {
    expect(maskIpAddress('203.0.113.7')).toBe('203.0.113.***');
    expect(maskIpAddress('192.168.1.254')).toBe('192.168.1.***');
  });

  it('blanks the last group of an IPv6 address', () => {
    expect(maskIpAddress('2001:db8::1')).toBe('2001:db8::***');
  });

  it('masks a loopback address without exposing it', () => {
    expect(maskIpAddress('127.0.0.1')).toBe('127.0.0.***');
    expect(maskIpAddress('::1')).toBe('::***');
  });

  it('falls back to a full mask for anything it cannot parse', () => {
    expect(maskIpAddress('unknown')).toBe(PII_FULL_MASK);
  });

  it('treats null, undefined and whitespace as no address at all', () => {
    expect(maskIpAddress(null)).toBeNull();
    expect(maskIpAddress(undefined)).toBeNull();
    expect(maskIpAddress('  ')).toBeNull();
  });
});

describe('presentPhone / presentIp', () => {
  it('returns the real value only when the caller may see PII', () => {
    expect(presentPhone('+95950495369', true)).toBe('+95950495369');
    expect(presentIp('203.0.113.7', true)).toBe('203.0.113.7');
  });

  it('masks when the caller may not', () => {
    expect(presentPhone('+95950495369', false)).toBe('+9*****369');
    expect(presentIp('203.0.113.7', false)).toBe('203.0.113.***');
  });

  it('keeps null as null either way — an absent value is not masked into one', () => {
    expect(presentPhone(null, true)).toBeNull();
    expect(presentPhone(null, false)).toBeNull();
    expect(presentIp(null, true)).toBeNull();
    expect(presentIp(null, false)).toBeNull();
  });
});
