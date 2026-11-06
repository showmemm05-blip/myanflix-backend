import {
  BankMatchStatus,
  BankRiskLevel,
  Prisma,
} from '../generated/prisma/client';
import {
  CLOCK_SKEW_MS,
  DEPOSIT_MATCH_WINDOW_MS,
  HARD_REASONS,
  NO_BANK_TRANSACTION_AFTER_MS,
  RISK_REASONS,
  RISK_REASON_WEIGHTS,
  SCREENSHOT_REASONS,
  VELOCITY_LIMIT,
  WITHDRAWAL_PAYOUT_WINDOW_MS,
  amountsEqual,
  codesEqual,
  counterpartyMatches,
  counterpartyReasons,
  depositTimingReasons,
  isNoBankTransaction,
  isPlainCode,
  isWithdrawalNoBankTransaction,
  last6,
  maxRiskLevel,
  normalizeReasons,
  reasonsEqual,
  referenceTwinReasons,
  replaceReasonClass,
  riskLevelForScore,
  riskScore,
  screenshotReasons,
  scoreVerification,
  velocityReasons,
  verificationView,
  withdrawalVerificationView,
  yangonTimeOfDay,
} from './risk-rules';

const D = (n: number | string) => new Prisma.Decimal(n);
const at = (iso: string) => new Date(iso);

describe('risk-rules — constants', () => {
  it('ties the no-bank cutoff to the deposit match window (one number, by construction)', () => {
    expect(NO_BANK_TRANSACTION_AFTER_MS).toBe(DEPOSIT_MATCH_WINDOW_MS);
    expect(DEPOSIT_MATCH_WINDOW_MS).toBe(24 * 3_600_000);
    expect(WITHDRAWAL_PAYOUT_WINDOW_MS).toBe(24 * 3_600_000);
    expect(CLOCK_SKEW_MS).toBe(5 * 60_000);
    expect(VELOCITY_LIMIT).toBe(3);
  });

  it('gives every reason a weight and classes exactly the five hard ones', () => {
    for (const reason of RISK_REASONS) {
      expect(RISK_REASON_WEIGHTS[reason]).toBeGreaterThan(0);
    }
    expect([...HARD_REASONS].sort()).toEqual([
      'AMOUNT_MISMATCH',
      'CODE_MISMATCH',
      'DUPLICATE_PAYOUT_CODE',
      'SHARED_REFERENCE_ACROSS_USERS',
      'SUBMITTED_BEFORE_TRANSFER',
    ]);
  });
});

describe('normalizeReasons / reasonsEqual / replaceReasonClass', () => {
  it('sorts, de-duplicates and drops unknown or read-time-only codes', () => {
    expect(
      normalizeReasons([
        'VELOCITY',
        'AMOUNT_MISMATCH',
        'VELOCITY',
        'NOT_A_REASON',
        'NO_BANK_TRANSACTION',
      ]),
    ).toEqual(['AMOUNT_MISMATCH', 'VELOCITY']);
  });

  it('is idempotent — the property the unchanged-row skip depends on', () => {
    const once = normalizeReasons(['VELOCITY', 'DUPLICATE_REFERENCE']);
    expect(normalizeReasons(once)).toEqual(once);
    expect(reasonsEqual(['DUPLICATE_REFERENCE', 'VELOCITY'], once)).toBe(true);
    expect(reasonsEqual(['VELOCITY'], once)).toBe(false);
  });

  it('swaps one class of reasons and keeps every other stored reason', () => {
    expect(
      replaceReasonClass(
        [
          'AMOUNT_MISMATCH',
          'DUPLICATE_REFERENCE',
          'SHARED_REFERENCE_ACROSS_USERS',
        ],
        ['DUPLICATE_REFERENCE', 'SHARED_REFERENCE_ACROSS_USERS'],
        ['DUPLICATE_REFERENCE'],
      ),
    ).toEqual(['AMOUNT_MISMATCH', 'DUPLICATE_REFERENCE']);
    expect(
      replaceReasonClass(['DUPLICATE_REFERENCE'], ['DUPLICATE_REFERENCE'], []),
    ).toEqual([]);
  });
});

describe('scoring', () => {
  it('sums weights and buckets 0–29 LOW, 30–59 MEDIUM, ≥60 HIGH', () => {
    expect(riskScore(['VELOCITY'])).toBe(20);
    expect(riskLevelForScore(0)).toBe(BankRiskLevel.LOW);
    expect(riskLevelForScore(29)).toBe(BankRiskLevel.LOW);
    expect(riskLevelForScore(30)).toBe(BankRiskLevel.MEDIUM);
    expect(riskLevelForScore(59)).toBe(BankRiskLevel.MEDIUM);
    expect(riskLevelForScore(60)).toBe(BankRiskLevel.HIGH);
  });

  it('MATCHED needs bank values AND an empty reason list', () => {
    expect(scoreVerification([], true)).toEqual({
      matchStatus: BankMatchStatus.MATCHED,
      riskLevel: BankRiskLevel.LOW,
      riskReasons: [],
    });
  });

  it('is UNVERIFIED and unscored with no reasons and no bank values', () => {
    expect(scoreVerification([], false)).toEqual({
      matchStatus: BankMatchStatus.UNVERIFIED,
      riskLevel: null,
      riskReasons: [],
    });
  });

  it('any hard reason → SUSPICIOUS; only soft reasons → PENDING_REVIEW', () => {
    expect(scoreVerification(['AMOUNT_MISMATCH'], true)).toEqual({
      matchStatus: BankMatchStatus.SUSPICIOUS,
      riskLevel: BankRiskLevel.HIGH,
      riskReasons: ['AMOUNT_MISMATCH'],
    });
    expect(scoreVerification(['VELOCITY'], false)).toEqual({
      matchStatus: BankMatchStatus.PENDING_REVIEW,
      riskLevel: BankRiskLevel.LOW,
      riskReasons: ['VELOCITY'],
    });
    expect(
      scoreVerification(['DUPLICATE_REFERENCE', 'VELOCITY'], true),
    ).toEqual({
      matchStatus: BankMatchStatus.PENDING_REVIEW,
      riskLevel: BankRiskLevel.MEDIUM,
      riskReasons: ['DUPLICATE_REFERENCE', 'VELOCITY'],
    });
    expect(scoreVerification(['CODE_MISMATCH'], true).matchStatus).toBe(
      BankMatchStatus.SUSPICIOUS,
    );
    expect(scoreVerification(['CODE_MISMATCH'], true).riskLevel).toBe(
      BankRiskLevel.MEDIUM,
    );
  });

  it('maxRiskLevel treats null as "no opinion"', () => {
    expect(maxRiskLevel(null, null)).toBeNull();
    expect(maxRiskLevel(null, BankRiskLevel.LOW)).toBe(BankRiskLevel.LOW);
    expect(maxRiskLevel(BankRiskLevel.HIGH, BankRiskLevel.MEDIUM)).toBe(
      BankRiskLevel.HIGH,
    );
    expect(maxRiskLevel(BankRiskLevel.LOW, BankRiskLevel.MEDIUM)).toBe(
      BankRiskLevel.MEDIUM,
    );
  });
});

describe('individual rules', () => {
  it('compares money at two decimals and codes case-insensitively', () => {
    expect(amountsEqual(D('50000'), D('50000.00'))).toBe(true);
    expect(amountsEqual(D('50000'), D('50000.01'))).toBe(false);
    expect(codesEqual('ab12CD', 'AB12cd')).toBe(true);
    expect(codesEqual('AB12CD', 'AB12CE')).toBe(false);
    expect(last6('KBZ-20260918-AB12CD'.replace(/-/g, ''))).toBe('AB12CD');
  });

  it('lets only letters and digits into a case-insensitive (ILIKE) code lookup', () => {
    expect(isPlainCode('ab12CD')).toBe(true);
    expect(isPlainCode('000123')).toBe(true);
    for (const pattern of ['AB12_D', 'AB%2CD', 'AB\\2CD', 'AB 2CD', '']) {
      expect(isPlainCode(pattern)).toBe(false);
    }
  });

  describe('depositTimingReasons', () => {
    const bank = at('2026-09-18T09:00:00.000Z');

    it('flags a submission that predates the bank transfer by more than the clock skew — the impossible-honestly case', () => {
      const createdAt = new Date(bank.getTime() - CLOCK_SKEW_MS - 1);
      expect(
        depositTimingReasons({ createdAt, declaredTransferAt: null }, bank),
      ).toEqual(['SUBMITTED_BEFORE_TRANSFER']);
    });

    it('tolerates a submission inside the clock-skew window before the bank time', () => {
      const createdAt = new Date(bank.getTime() - CLOCK_SKEW_MS + 1);
      expect(
        depositTimingReasons({ createdAt, declaredTransferAt: null }, bank),
      ).toEqual([]);
    });

    it('never lets a user-typed declaredTransferAt soften the before-transfer check', () => {
      const createdAt = new Date(bank.getTime() - 3_600_000);
      expect(
        depositTimingReasons(
          { createdAt, declaredTransferAt: new Date(bank.getTime() + 60_000) },
          bank,
        ),
      ).toContain('SUBMITTED_BEFORE_TRANSFER');
    });

    it('flags a submission more than the match window after the transfer', () => {
      const createdAt = new Date(bank.getTime() + DEPOSIT_MATCH_WINDOW_MS + 1);
      expect(
        depositTimingReasons({ createdAt, declaredTransferAt: null }, bank),
      ).toEqual(['TIME_GAP_TOO_LARGE']);
    });

    it('uses the declared transfer time for the gap when the user gave one', () => {
      // Submitted two days later but the user says they paid at the bank time:
      // the gap rule reads the declared time, so no gap; the before-transfer
      // rule still reads createdAt and does not fire either.
      const createdAt = new Date(bank.getTime() + 2 * DEPOSIT_MATCH_WINDOW_MS);
      expect(
        depositTimingReasons({ createdAt, declaredTransferAt: bank }, bank),
      ).toEqual([]);
    });
  });

  describe('referenceTwinReasons', () => {
    const me = { userId: 'u1', amount: D(5000) };

    it('is empty with no twins', () => {
      expect(referenceTwinReasons(me, [])).toEqual([]);
    });

    it('flags DUPLICATE_REFERENCE for any twin, whoever owns it', () => {
      expect(
        referenceTwinReasons(me, [{ userId: 'u1', amount: D(7000) }]),
      ).toEqual(['DUPLICATE_REFERENCE']);
    });

    it('adds SHARED_REFERENCE_ACROSS_USERS only for a different user with the SAME amount', () => {
      expect(
        referenceTwinReasons(me, [{ userId: 'u2', amount: D(5000) }]),
      ).toEqual(['DUPLICATE_REFERENCE', 'SHARED_REFERENCE_ACROSS_USERS']);
      expect(
        referenceTwinReasons(me, [{ userId: 'u2', amount: D(5001) }]),
      ).toEqual(['DUPLICATE_REFERENCE']);
    });
  });

  describe('counterpartyMatches / counterpartyReasons (M-16)', () => {
    it('ignores case, spaces, punctuation and honorifics — either side containing the other is a match', () => {
      expect(counterpartyMatches('U KO KO AUNG', 'Ko Ko Aung')).toBe(true);
      expect(counterpartyMatches('ko-ko aung.', 'KO KO AUNG')).toBe(true);
      expect(counterpartyMatches('Ko Ko', 'Ko Ko Aung')).toBe(true);
      expect(counterpartyMatches('MAUNG MAUNG', 'Ko Ko Aung')).toBe(false);
    });

    it('a missing or empty side is never a mismatch', () => {
      expect(counterpartyMatches(null, 'Ko Ko')).toBe(true);
      expect(counterpartyMatches('Ko Ko', null)).toBe(true);
      expect(counterpartyMatches('Ko Ko', undefined)).toBe(true);
      expect(counterpartyMatches('...', 'Ko Ko')).toBe(true);
      expect(counterpartyMatches('', '')).toBe(true);
    });

    it('is a SOFT reason: alone it scores PENDING_REVIEW / LOW, never SUSPICIOUS', () => {
      expect(counterpartyReasons('MAUNG MAUNG', 'Ko Ko')).toEqual([
        'COUNTERPARTY_MISMATCH',
      ]);
      expect(counterpartyReasons('U KO KO', 'Ko Ko')).toEqual([]);
      expect(HARD_REASONS.has('COUNTERPARTY_MISMATCH')).toBe(false);
      expect(scoreVerification(['COUNTERPARTY_MISMATCH'], true)).toEqual({
        matchStatus: BankMatchStatus.PENDING_REVIEW,
        riskLevel: BankRiskLevel.LOW,
        riskReasons: ['COUNTERPARTY_MISMATCH'],
      });
    });
  });

  it('velocity fires at VELOCITY_LIMIT rows in the window, counting the row itself', () => {
    expect(velocityReasons(VELOCITY_LIMIT - 1)).toEqual([]);
    expect(velocityReasons(VELOCITY_LIMIT)).toEqual(['VELOCITY']);
  });
});

describe('read-time NO_BANK_TRANSACTION derivation (never stored)', () => {
  const now = at('2026-09-18T12:00:00.000Z');
  const old = new Date(now.getTime() - NO_BANK_TRANSACTION_AFTER_MS - 1);
  const young = new Date(now.getTime() - NO_BANK_TRANSACTION_AFTER_MS + 1);

  it('is PENDING + never bank-checked + older than the window, and nothing else', () => {
    expect(
      isNoBankTransaction(
        { status: 'PENDING', bankCheckedAt: null, createdAt: old },
        now,
      ),
    ).toBe(true);
    expect(
      isNoBankTransaction(
        { status: 'PENDING', bankCheckedAt: null, createdAt: young },
        now,
      ),
    ).toBe(false);
    expect(
      isNoBankTransaction(
        { status: 'PENDING', bankCheckedAt: now, createdAt: old },
        now,
      ),
    ).toBe(false);
    expect(
      isNoBankTransaction(
        { status: 'APPROVED', bankCheckedAt: null, createdAt: old },
        now,
      ),
    ).toBe(false);
  });

  it('layers the derived reason, raises the level to at least MEDIUM and swaps the view status', () => {
    expect(
      verificationView(
        {
          status: 'PENDING',
          bankCheckedAt: null,
          createdAt: old,
          matchStatus: BankMatchStatus.PENDING_REVIEW,
          riskLevel: BankRiskLevel.LOW,
          riskReasons: ['VELOCITY'],
        },
        now,
      ),
    ).toEqual({
      matchStatus: 'NO_BANK_TRANSACTION',
      riskLevel: BankRiskLevel.MEDIUM,
      riskReasons: ['VELOCITY', 'NO_BANK_TRANSACTION'],
    });
  });

  it('leaves a HIGH level alone and returns the stored state untouched when it does not apply', () => {
    const stored = {
      status: 'PENDING',
      bankCheckedAt: null,
      createdAt: old,
      matchStatus: BankMatchStatus.SUSPICIOUS,
      riskLevel: BankRiskLevel.HIGH,
      riskReasons: ['SHARED_REFERENCE_ACROSS_USERS'],
    };
    expect(verificationView(stored, now).riskLevel).toBe(BankRiskLevel.HIGH);
    expect(verificationView({ ...stored, createdAt: young }, now)).toEqual({
      matchStatus: BankMatchStatus.SUSPICIOUS,
      riskLevel: BankRiskLevel.HIGH,
      riskReasons: ['SHARED_REFERENCE_ACROSS_USERS'],
    });
  });

  it('for withdrawals keys on the open payout set and approvedAt', () => {
    const base = {
      status: 'APPROVED',
      bankCheckedAt: null,
      transferTransactionCode: null,
      approvedAt: new Date(now.getTime() - WITHDRAWAL_PAYOUT_WINDOW_MS - 1),
    };
    expect(isWithdrawalNoBankTransaction(base, now)).toBe(true);
    expect(
      isWithdrawalNoBankTransaction(
        { ...base, transferTransactionCode: 'AB12CD' },
        now,
      ),
    ).toBe(false);
    expect(
      isWithdrawalNoBankTransaction({ ...base, approvedAt: null }, now),
    ).toBe(false);
    expect(
      withdrawalVerificationView(
        {
          ...base,
          matchStatus: BankMatchStatus.UNVERIFIED,
          riskLevel: null,
          riskReasons: [],
        },
        now,
      ),
    ).toEqual({
      matchStatus: 'NO_BANK_TRANSACTION',
      riskLevel: BankRiskLevel.MEDIUM,
      riskReasons: ['NO_BANK_TRANSACTION'],
    });
  });
});

describe('yangonTimeOfDay', () => {
  it('renders HH:MM:SS at UTC+6:30, the format the admin form stores', () => {
    expect(yangonTimeOfDay(at('2026-09-18T00:26:02.000Z'))).toBe('06:56:02');
    // Crosses midnight in Yangon.
    expect(yangonTimeOfDay(at('2026-09-18T17:35:00.000Z'))).toBe('00:05:00');
  });
});

describe('screenshotReasons (SEC-004)', () => {
  it('flags a bank event with no picture behind it, and nothing once the key is set', () => {
    expect(screenshotReasons(null)).toEqual(['NO_SCREENSHOT']);
    expect(screenshotReasons(undefined)).toEqual(['NO_SCREENSHOT']);
    expect(screenshotReasons('')).toEqual(['NO_SCREENSHOT']);
    expect(
      screenshotReasons('documents/bank-screenshots/transactions/tx-1/k.png'),
    ).toEqual([]);
  });

  it('is SOFT: on its own the row is PENDING_REVIEW / LOW with bank values — never MATCHED, never SUSPICIOUS', () => {
    expect(HARD_REASONS.has('NO_SCREENSHOT')).toBe(false);
    expect(RISK_REASON_WEIGHTS.NO_SCREENSHOT).toBeLessThan(30);
    expect(scoreVerification(['NO_SCREENSHOT'], true)).toEqual({
      matchStatus: BankMatchStatus.PENDING_REVIEW,
      riskLevel: BankRiskLevel.LOW,
      riskReasons: ['NO_SCREENSHOT'],
    });
  });

  it('is its own class: the upload swaps it out and keeps every other reason', () => {
    expect(SCREENSHOT_REASONS).toEqual(['NO_SCREENSHOT']);
    expect(
      replaceReasonClass(
        ['NO_SCREENSHOT', 'VELOCITY', 'COUNTERPARTY_MISMATCH'],
        SCREENSHOT_REASONS,
        [],
      ),
    ).toEqual(['COUNTERPARTY_MISMATCH', 'VELOCITY']);
    expect(
      replaceReasonClass(['NO_SCREENSHOT'], SCREENSHOT_REASONS, []),
    ).toEqual([]);
    // A clean row with its picture: back to the green badge.
    expect(scoreVerification([], true).matchStatus).toBe(
      BankMatchStatus.MATCHED,
    );
  });
});
