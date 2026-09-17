import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateSubtitleDto } from './create-subtitle.dto';

const VIDEO_ID = '0b94b5e5-7224-4dfd-99a3-4112bb09501c';

/**
 * POST /subtitles is multipart, so multer hands every field over as a string
 * — the body here mirrors exactly that shape, through the same transform and
 * validation options the global pipe uses (src/app.module.ts).
 */
async function validateBody(body: Record<string, unknown>) {
  const instance = plainToInstance(
    CreateSubtitleDto,
    { videoId: VIDEO_ID, language: 'fr', label: 'FalseTest', ...body },
    { enableImplicitConversion: true },
  );
  const errors = await validate(instance, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { instance, errors };
}

describe('CreateSubtitleDto — isDefault from a multipart string (F-008)', () => {
  it("'false' is stored as false", async () => {
    const { instance, errors } = await validateBody({ isDefault: 'false' });
    expect(errors).toHaveLength(0);
    expect(instance.isDefault).toBe(false);
  });

  it("'0' is stored as false", async () => {
    const { instance, errors } = await validateBody({ isDefault: '0' });
    expect(errors).toHaveLength(0);
    expect(instance.isDefault).toBe(false);
  });

  it("'true' is stored as true", async () => {
    const { instance, errors } = await validateBody({ isDefault: 'true' });
    expect(errors).toHaveLength(0);
    expect(instance.isDefault).toBe(true);
  });

  it("'maybe' is refused on isDefault", async () => {
    const { errors } = await validateBody({ isDefault: 'maybe' });
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('isDefault');
  });

  it('omitted leaves isDefault undefined (the service falls back to false)', async () => {
    const { instance, errors } = await validateBody({});
    expect(errors).toHaveLength(0);
    expect(instance.isDefault).toBeUndefined();
  });

  it('an unknown extra field still fails the whitelist', async () => {
    const { errors } = await validateBody({ isDefault: 'true', extra: 'x' });
    expect(errors.map((e) => e.property)).toEqual(['extra']);
  });
});
