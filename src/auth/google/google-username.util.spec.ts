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
    // M-20: `user_<digits>` is the name a phone sign-up needs — never granted.
    ['user_959123456789@outlook.com', 'g_959123456789'],
    ['USER_959123456789@attacker.example', 'g_959123456789'],
    ['1@x.com', 'g_1'],
    // Letters or a dot after `user_` are not the phone shape: left alone.
    ['user_959123456789a@x.com', 'user_959123456789a'],
    ['user.959123456789@x.com', 'user.959123456789'],
  ])('%s → %s', (email, expected) => {
    const base = deriveUsernameBase(email);
    expect(base).toBe(expected);
    // Must be a legal username by RegisterDto's rule, with room for a suffix.
    expect(base).toMatch(USERNAME_RULE);
    expect(base.length).toBeGreaterThanOrEqual(3);
    expect(base.length).toBeLessThanOrEqual(24);
  });

  it("M-20: no e-mail can produce a phone account's synthesized name (user_<digits>)", () => {
    const attempts = [
      'user_959123456789@outlook.com',
      'user__959123456789@x.com',
      'user_.959123456789@x.com',
      '_user_959123456789_@x.com',
      'user-959123456789@x.com',
      'user+959123456789@x.com',
      'USER_959123456789@x.com',
      'user_9591234567890123456789@x.com',
      '959@x.com',
      '7@x.com',
    ];
    for (const email of attempts) {
      expect(deriveUsernameBase(email)).not.toMatch(/^user_\d+$/);
    }
  });
});
