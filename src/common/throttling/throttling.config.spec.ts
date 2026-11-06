import type { ExecutionContext } from '@nestjs/common';
import { accountTracker, credentialTargetTracker } from './throttling.config';

const context = {} as ExecutionContext;

function track(req: Record<string, unknown>) {
  return credentialTargetTracker(
    { socket: { remoteAddress: '203.0.113.7' }, headers: {}, ...req },
    context,
  );
}

describe('credentialTargetTracker', () => {
  it('keys on the normalised phone, then the username (the @Public auth routes, unchanged)', () => {
    expect(track({ body: { phone: '09777000777' } })).toBe(
      'phone:+959777000777',
    );
    expect(track({ body: { username: 'Ko_Ko' } })).toBe('user:ko_ko');
  });

  it('on a signed-in route with no phone/username in the body, keys on the account', () => {
    expect(track({ body: { code: '582904' }, user: { id: 'user-1' } })).toBe(
      'account:user-1',
    );
    expect(track({ user: { id: 'user-1' } })).toBe('account:user-1');
  });

  it('a phone in the body still wins over the signed-in account', () => {
    expect(
      track({ body: { phone: '09777000777' }, user: { id: 'user-1' } }),
    ).toBe('phone:+959777000777');
  });

  it('falls back to the client IP with neither', () => {
    expect(track({ body: {} })).toBe('ip:203.0.113.7');
    expect(track({ body: {}, user: { id: '' } })).toBe('ip:203.0.113.7');
  });
});

describe('accountTracker', () => {
  const trackAccount = (req: Record<string, unknown>) =>
    accountTracker(
      { socket: { remoteAddress: '203.0.113.7' }, headers: {}, ...req },
      context,
    );

  it('keys on the signed-in account and never on the body (a GET can carry one too)', () => {
    expect(trackAccount({ user: { id: 'user-1' } })).toBe('account:user-1');
    expect(
      trackAccount({
        body: { phone: '09777000777', username: 'Ko_Ko' },
        user: { id: 'user-1' },
      }),
    ).toBe('account:user-1');
  });

  it('falls back to the client IP without an account, whatever the body says', () => {
    expect(trackAccount({ body: { username: 'Ko_Ko' } })).toBe(
      'ip:203.0.113.7',
    );
    expect(trackAccount({ body: {}, user: { id: '' } })).toBe('ip:203.0.113.7');
  });
});
