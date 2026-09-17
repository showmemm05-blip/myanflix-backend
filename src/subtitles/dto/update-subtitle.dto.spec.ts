import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateSubtitleDto } from './update-subtitle.dto';

/** PATCH /subtitles/:id is JSON, run through the global pipe's options. */
async function validateBody(body: Record<string, unknown>) {
  const instance = plainToInstance(UpdateSubtitleDto, body, {
    enableImplicitConversion: true,
  });
  const errors = await validate(instance, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { instance, errors };
}

describe('UpdateSubtitleDto — isDefault (F-008)', () => {
  it("the string 'false' is read as false", async () => {
    const { instance, errors } = await validateBody({ isDefault: 'false' });
    expect(errors).toHaveLength(0);
    expect(instance.isDefault).toBe(false);
  });

  it('a real false passes through', async () => {
    const { instance, errors } = await validateBody({ isDefault: false });
    expect(errors).toHaveLength(0);
    expect(instance.isDefault).toBe(false);
  });

  it("'no' is refused", async () => {
    const { errors } = await validateBody({ isDefault: 'no' });
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('isDefault');
  });

  it('{} leaves isDefault undefined so the column is left untouched', async () => {
    const { instance, errors } = await validateBody({});
    expect(errors).toHaveLength(0);
    expect(instance.isDefault).toBeUndefined();
  });
});
