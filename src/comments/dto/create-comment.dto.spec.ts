import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateCommentDto } from './create-comment.dto';

const MOVIE_ID = '11111111-1111-4111-8111-111111111111';

async function validateBody(body: unknown) {
  const instance = plainToInstance(
    CreateCommentDto,
    { movieId: MOVIE_ID, body },
    { enableImplicitConversion: true },
  );
  const errors = await validate(instance);
  return { instance, errors: errors.filter((e) => e.property === 'body') };
}

describe('CreateCommentDto — body validation', () => {
  it('trims before validating, so a whitespace-only body is rejected as empty', async () => {
    const { errors } = await validateBody('   \n\t  ');
    expect(errors).not.toHaveLength(0);
  });

  it('stores the trimmed body, not what was typed around it', async () => {
    const { instance, errors } = await validateBody('  loved it  ');
    expect(errors).toHaveLength(0);
    expect(instance.body).toBe('loved it');
  });

  it('accepts a single character', async () => {
    const { errors } = await validateBody('!');
    expect(errors).toHaveLength(0);
  });

  it('accepts exactly 1000 characters', async () => {
    const { errors } = await validateBody('a'.repeat(1000));
    expect(errors).toHaveLength(0);
  });

  it('rejects 1001 characters', async () => {
    const { errors } = await validateBody('a'.repeat(1001));
    expect(errors).not.toHaveLength(0);
  });

  it('rejects a missing body', async () => {
    const { errors } = await validateBody(undefined);
    expect(errors).not.toHaveLength(0);
  });
});

describe('CreateCommentDto — target ids', () => {
  it('accepts a movie-only comment', async () => {
    const instance = plainToInstance(CreateCommentDto, {
      movieId: MOVIE_ID,
      body: 'Great',
    });
    expect(await validate(instance)).toHaveLength(0);
  });

  it('rejects a non-UUID movieId', async () => {
    const instance = plainToInstance(CreateCommentDto, {
      movieId: 'not-a-uuid',
      body: 'Great',
    });
    expect(await validate(instance)).not.toHaveLength(0);
  });

  /**
   * The "exactly one target" rule is a cross-field rule, so it is the
   * service's — this documents that the DTO deliberately lets both through.
   */
  it('leaves the exactly-one-of rule to the service', async () => {
    const instance = plainToInstance(CreateCommentDto, {
      movieId: MOVIE_ID,
      seriesId: '22222222-2222-4222-8222-222222222222',
      body: 'Great',
    });
    expect(await validate(instance)).toHaveLength(0);
  });
});
