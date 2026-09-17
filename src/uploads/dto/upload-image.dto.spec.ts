import { ArgumentMetadata, ValidationPipe } from '@nestjs/common';
import { UploadImageDto } from './upload-image.dto';
import {
  AVATAR_IMAGE_PURPOSE,
  IMAGE_PURPOSES,
} from '../../common/storage/media-taxonomy';

/**
 * Run through the REAL global pipe (see AppModule's APP_PIPE), because the
 * decision being protected here is a REQUEST-level one: POST /uploads/image
 * has no fallback purpose, so a caller that forgets the field must get a 400
 * that tells them what to send — never a silent landing in images/other/,
 * which nobody would notice until a cleanup path failed to find the image
 * years later.
 */
const pipe = new ValidationPipe({
  whitelist: true,
  transform: true,
  forbidNonWhitelisted: true,
  transformOptions: { enableImplicitConversion: true },
});

const asBody: ArgumentMetadata = {
  type: 'body',
  metatype: UploadImageDto,
  data: '',
};

/** The validation messages the pipe would put in the 400 response. */
const messagesFor = async (body: unknown): Promise<string[]> => {
  try {
    await pipe.transform(body, asBody);
  } catch (error) {
    const response = (
      error as { getResponse: () => { message: string[] } }
    ).getResponse();
    return response.message;
  }
  throw new Error('expected the pipe to reject this body');
};

describe('UploadImageDto', () => {
  it('accepts every purpose the media taxonomy declares — the route and the folders cannot drift', async () => {
    for (const purpose of IMAGE_PURPOSES) {
      await expect(pipe.transform({ purpose }, asBody)).resolves.toEqual({
        purpose,
      });
    }
  });

  it('rejects a missing purpose with a message that lists the valid values', async () => {
    const messages = await messagesFor({});

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('purpose is required');
    for (const purpose of IMAGE_PURPOSES) {
      expect(messages[0]).toContain(purpose);
    }
  });

  it('rejects an unknown purpose rather than quietly downgrading it', async () => {
    await expect(messagesFor({ purpose: 'poster' })).resolves.toEqual([
      expect.stringContaining('purpose is required'),
    ]);
  });

  it(`rejects "${AVATAR_IMAGE_PURPOSE}" — a user's own folder is written only by UsersService, never by a staff upload`, async () => {
    await expect(
      messagesFor({ purpose: AVATAR_IMAGE_PURPOSE }),
    ).resolves.toHaveLength(1);
  });

  it('rejects an extra field, so a stale client cannot smuggle anything past the route', async () => {
    await expect(
      messagesFor({ purpose: 'movie', key: 'images/movie/mine.jpg' }),
    ).resolves.toEqual([expect.stringContaining('key')]);
  });
});
