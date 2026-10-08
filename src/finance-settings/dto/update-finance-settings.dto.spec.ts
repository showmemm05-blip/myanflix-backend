import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateFinanceSettingsDto } from './update-finance-settings.dto';

const VALID = {
  minDepositAmount: 1000,
  maxDepositAmount: 5_000_000,
  minWithdrawalAmount: 1000,
  maxWithdrawalAmount: 5_000_000,
};

async function failingFields(body: Record<string, unknown>) {
  const errors = await validate(
    plainToInstance(UpdateFinanceSettingsDto, body),
  );
  return errors.map((e) => e.property).sort();
}

/**
 * L-34: a maximum of 0 would refuse every deposit/withdrawal for everyone —
 * the admin form sends `Number(x) || 0` for a cleared field, so this is the
 * one garbage value a tired click can produce. Minimums may still be 0.
 */
describe('UpdateFinanceSettingsDto — maximums must be at least 1', () => {
  it('accepts the current defaults', async () => {
    expect(await failingFields(VALID)).toEqual([]);
  });

  it('rejects maxDepositAmount = 0 (would stop every deposit)', async () => {
    expect(await failingFields({ ...VALID, maxDepositAmount: 0 })).toEqual([
      'maxDepositAmount',
    ]);
  });

  it('rejects maxWithdrawalAmount = 0 (would stop every withdrawal)', async () => {
    expect(await failingFields({ ...VALID, maxWithdrawalAmount: 0 })).toEqual([
      'maxWithdrawalAmount',
    ]);
  });

  it('rejects all four cleared (the admin form sends 0 for an empty field)', async () => {
    expect(
      await failingFields({
        minDepositAmount: 0,
        maxDepositAmount: 0,
        minWithdrawalAmount: 0,
        maxWithdrawalAmount: 0,
      }),
    ).toEqual(['maxDepositAmount', 'maxWithdrawalAmount']);
  });

  it('still allows a minimum of 0 ("no floor") with a positive maximum', async () => {
    expect(
      await failingFields({
        ...VALID,
        minDepositAmount: 0,
        minWithdrawalAmount: 0,
      }),
    ).toEqual([]);
  });

  it('accepts a maximum of exactly 1 and coerces numeric strings', async () => {
    expect(
      await failingFields({
        minDepositAmount: '0',
        maxDepositAmount: '1',
        minWithdrawalAmount: '0',
        maxWithdrawalAmount: '1',
      }),
    ).toEqual([]);
  });

  it('still rejects negative minimums', async () => {
    expect(await failingFields({ ...VALID, minDepositAmount: -1 })).toEqual([
      'minDepositAmount',
    ]);
  });
});
