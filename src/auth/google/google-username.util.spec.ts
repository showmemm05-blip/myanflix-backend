import { deriveUsernameBase } from './google-username.util';

const USERNAME_RULE = /^[a-zA-Z0-9_.]+$/;

describe('deriveUsernameBase', () => {
  it.each([
    ['John.Doe@gmail.com', 'john.doe'],
    ['a.b+tag@x.com', 'a.b_tag'],
    ['j@x.com', 'user_j'],
    ['___@x.com', 'user'],
    ['မောင်မောင်@gmail.com', 'user'],
    ['first..last@x.com', 'first_last'],
    ['abcdefghijklmnopqrstuvwxyz0123@x.com', 'abcdefghijklmnopqrstuvwx'],
  ])('%s → %s', (email, expected) => {
    const base = deriveUsernameBase(email);
    expect(base).toBe(expected);
    // Must be a legal username by RegisterDto's rule, with room for a suffix.
    expect(base).toMatch(USERNAME_RULE);
    expect(base.length).toBeGreaterThanOrEqual(3);
    expect(base.length).toBeLessThanOrEqual(24);
  });
});
