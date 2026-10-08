import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { MovieQueryDto } from './movie-query.dto';

const uuid = (n: number) =>
  `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;

/** The additive `ids` filter on GET /movies. */
describe('MovieQueryDto — ids', () => {
  const check = (query: Record<string, unknown>) =>
    validate(plainToInstance(MovieQueryDto, query));

  it('parses ids from CSV, trimming and dropping empties', async () => {
    const dto = plainToInstance(MovieQueryDto, {
      ids: ` ${uuid(1)}, ,${uuid(2)} `,
    });
    expect(dto.ids).toEqual([uuid(1), uuid(2)]);
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects a list holding a bad uuid', async () => {
    const errors = await check({ ids: `${uuid(1)},not-a-uuid` });
    expect(errors.map((e) => e.property)).toEqual(['ids']);
  });

  it('accepts 100 ids and rejects 101 (the page-size cap)', async () => {
    const list = (n: number) =>
      Array.from({ length: n }, (_, i) => uuid(i + 1)).join(',');
    expect(await check({ ids: list(100) })).toHaveLength(0);
    const errors = await check({ ids: list(101) });
    expect(errors.map((e) => e.property)).toEqual(['ids']);
  });
});
