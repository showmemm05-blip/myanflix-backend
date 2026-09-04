import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { EXACTLY_ONE_MESSAGE, GoogleLoginDto } from './google-login.dto';

async function check(body: Record<string, unknown>) {
  const instance = plainToInstance(GoogleLoginDto, body, {
    enableImplicitConversion: true,
  });
  const errors = await validate(instance);
  const messages = errors.flatMap((e) => Object.values(e.constraints ?? {}));
  return { instance, messages };
}

describe('GoogleLoginDto — exactly one of credential | code', () => {
  it('accepts a credential alone (the original ID-token path)', async () => {
    const { messages, instance } = await check({ credential: 'id-token' });
    expect(messages).toEqual([]);
    expect(instance.credential).toBe('id-token');
    expect(instance.code).toBeUndefined();
  });

  it('accepts a code alone (the popup auth-code path)', async () => {
    const { messages, instance } = await check({ code: '4/0Abc' });
    expect(messages).toEqual([]);
    expect(instance.code).toBe('4/0Abc');
  });

  it('rejects an empty body with exactly the one message', async () => {
    const { messages } = await check({});
    expect(messages).toEqual([EXACTLY_ONE_MESSAGE]);
  });

  it('rejects both together with exactly the one message', async () => {
    const { messages } = await check({ credential: 'x', code: 'y' });
    expect(messages).toEqual([EXACTLY_ONE_MESSAGE]);
  });

  it('treats null as absent (credential: null + code counts as code alone)', async () => {
    const { messages } = await check({ credential: null, code: 'y' });
    expect(messages).toEqual([]);
  });

  it.each([
    ['empty credential', { credential: '' }],
    ['empty code', { code: '' }],
    ['credential over 4096', { credential: 'a'.repeat(4097) }],
    ['code over 4096', { code: 'a'.repeat(4097) }],
  ])('rejects %s', async (_label, body) => {
    const { messages } = await check(body);
    expect(messages).not.toEqual([]);
    expect(messages).not.toContain(EXACTLY_ONE_MESSAGE);
  });

  it('accepts exactly 4096 characters on either field', async () => {
    expect((await check({ credential: 'a'.repeat(4096) })).messages).toEqual(
      [],
    );
    expect((await check({ code: 'a'.repeat(4096) })).messages).toEqual([]);
  });
});
