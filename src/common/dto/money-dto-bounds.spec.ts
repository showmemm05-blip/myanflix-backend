import 'reflect-metadata';
import { plainToInstance, type ClassConstructor } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateDepositDto } from '../../deposits/dto/create-deposit.dto';
import { CreateManualDepositDto } from '../../deposits/dto/create-manual-deposit.dto';
import { CreateManualPaymentAccountTransactionDto } from '../../payment-accounts/dto/create-manual-payment-account-transaction.dto';
import { CreatePaymentAccountDto } from '../../payment-accounts/dto/create-payment-account.dto';
import { CreatePlanDto } from '../../subscriptions/dto/create-plan.dto';
import { UpdatePlanDto } from '../../subscriptions/dto/update-plan.dto';
import { CreateWalletAdjustmentDto } from '../../wallet/dto/create-wallet-adjustment.dto';
import { CreateWithdrawalDto } from '../../withdrawals/dto/create-withdrawal.dto';

/** The Decimal(12,2) ceiling every money column shares — the largest value Postgres stores. */
const CEILING = 9_999_999_999.99;

const UUID = '11111111-1111-4111-8111-111111111111';

/**
 * One valid body per money DTO. The amount-bearing field is overridden by
 * each case below; everything else is the smallest body that validates.
 */
const MONEY_DTOS: ReadonlyArray<
  [string, ClassConstructor<object>, string, Record<string, unknown>]
> = [
  [
    'CreateDepositDto',
    CreateDepositDto,
    'amount',
    { amount: 5000, paymentMethod: 'KBZ Pay', reference: '000123' },
  ],
  [
    'CreateManualDepositDto',
    CreateManualDepositDto,
    'amount',
    {
      userId: UUID,
      amount: 5000,
      paymentMethod: 'KBZ Pay',
      reference: '000123',
      destinationPaymentAccountId: UUID,
    },
  ],
  [
    'CreateWithdrawalDto',
    CreateWithdrawalDto,
    'amount',
    {
      amount: 5000,
      accountType: 'KBZPay',
      accountName: 'Mg Mg',
      accountNumber: '09000000000',
    },
  ],
  [
    'CreateWalletAdjustmentDto',
    CreateWalletAdjustmentDto,
    'amount',
    {
      direction: 'CREDIT',
      amount: 5000,
      reason: 'test',
      idempotencyKey: UUID,
    },
  ],
  [
    'CreateManualPaymentAccountTransactionDto',
    CreateManualPaymentAccountTransactionDto,
    'amount',
    { type: 'MANUAL_CREDIT', amount: 5000 },
  ],
  ['CreatePlanDto', CreatePlanDto, 'price', { name: 'Basic', price: 5000 }],
  ['UpdatePlanDto', UpdatePlanDto, 'price', { price: 5000 }],
];

async function failingFields(
  Dto: ClassConstructor<object>,
  body: Record<string, unknown>,
) {
  const errors = await validate(
    plainToInstance(Dto, body, { enableImplicitConversion: true }),
  );
  return errors.map((e) => e.property).sort();
}

/**
 * DB-007 / DB-020: every money input is a Decimal(12,2) at the database,
 * so anything at or above 10^10 used to pass validation and overflow in
 * Postgres — answered as a bare 500 by the global filter. Each DTO now
 * refuses it as a 400, and the ceiling itself is still accepted.
 */
describe('money DTOs — the Decimal(12,2) ceiling', () => {
  describe.each(MONEY_DTOS)('%s', (_name, Dto, field, valid) => {
    it('accepts the valid body and the ceiling itself', async () => {
      expect(await failingFields(Dto, valid)).toEqual([]);
      expect(await failingFields(Dto, { ...valid, [field]: CEILING })).toEqual(
        [],
      );
    });

    it('rejects 10^10, a plainly huge number and a "1e400" that coerces to Infinity', async () => {
      expect(
        await failingFields(Dto, { ...valid, [field]: 10_000_000_000 }),
      ).toEqual([field]);
      expect(await failingFields(Dto, { ...valid, [field]: 1e13 })).toEqual([
        field,
      ]);
      expect(await failingFields(Dto, { ...valid, [field]: '1e400' })).toEqual([
        field,
      ]);
    });

    it('rejects more than two decimal places', async () => {
      expect(await failingFields(Dto, { ...valid, [field]: 1000.005 })).toEqual(
        [field],
      );
    });
  });
});

/**
 * The plan price used to carry only @Min(0) (no @IsNumber): a non-number
 * that coerced to NaN or Infinity failed only at the database. 0 stays
 * allowed — a free plan is a legitimate thing to create.
 */
describe('plan price — a real number like every other money field', () => {
  it.each([
    ['CreatePlanDto', CreatePlanDto, { name: 'Free', price: 0 }],
    ['UpdatePlanDto', UpdatePlanDto, { price: 0 }],
  ] as const)('%s accepts a free plan (price 0)', async (_name, Dto, body) => {
    expect(await failingFields(Dto, body)).toEqual([]);
  });

  it.each([
    ['CreatePlanDto', CreatePlanDto, { name: 'Bad', price: 'abc' }],
    ['UpdatePlanDto', UpdatePlanDto, { price: 'abc' }],
    ['CreatePlanDto', CreatePlanDto, { name: 'Bad', price: -1 }],
    ['UpdatePlanDto', UpdatePlanDto, { price: 12.345 }],
  ] as const)('%s rejects %j', async (_name, Dto, body) => {
    expect(await failingFields(Dto, body)).toEqual(['price']);
  });

  it('UpdatePlanDto still treats an absent price as "leave it alone"', async () => {
    expect(await failingFields(UpdatePlanDto, { name: 'Renamed' })).toEqual([]);
  });
});

/**
 * SEC-028: the free-text fields that are stored and shown to people —
 * the depositor's payment method (admin queue) and OUR account's labels
 * (every customer's deposit picker) — are capped like their neighbours.
 */
describe('free-text money fields — length caps', () => {
  const deposit = {
    amount: 5000,
    paymentMethod: 'KBZ Pay',
    reference: '000123',
  };
  const account = {
    type: 'KBZPay',
    accountName: 'MyanFlix Co., Ltd.',
    accountNumber: '09000000000',
  };

  it('CreateDepositDto.paymentMethod: 60 characters pass, 61 fail (same cap as the manual deposit)', async () => {
    expect(
      await failingFields(CreateDepositDto, {
        ...deposit,
        paymentMethod: 'x'.repeat(60),
      }),
    ).toEqual([]);
    expect(
      await failingFields(CreateDepositDto, {
        ...deposit,
        paymentMethod: 'x'.repeat(61),
      }),
    ).toEqual(['paymentMethod']);
    expect(
      await failingFields(CreateDepositDto, {
        ...deposit,
        paymentMethod: 'x'.repeat(5000),
      }),
    ).toEqual(['paymentMethod']);
  });

  it.each([
    ['accountName', 120],
    ['accountNumber', 60],
    ['bankName', 120],
  ])(
    'CreatePaymentAccountDto.%s: %i characters pass, one more fails',
    async (field, cap) => {
      expect(
        await failingFields(CreatePaymentAccountDto, {
          ...account,
          [field]: 'x'.repeat(cap),
        }),
      ).toEqual([]);
      expect(
        await failingFields(CreatePaymentAccountDto, {
          ...account,
          [field]: 'x'.repeat(cap + 1),
        }),
      ).toEqual([field]);
    },
  );
});
