import {
  isSixDigitCode,
  isTooEasyWithdrawalCode,
  normalizeCodeInput,
} from './withdrawal-code.rules';

describe('withdrawal code rules', () => {
  describe('isSixDigitCode', () => {
    it.each(['582904', '000000', '999999'])('accepts %p', (code) => {
      expect(isSixDigitCode(code)).toBe(true);
    });

    it.each([
      '',
      '58290',
      '5829041',
      '58290a',
      ' 582904',
      '582 904',
      '٥٨٢٩٠٤', // Arabic-Indic digits: never turned into a code
      '၅၈၂၉၀၄', // Myanmar digits are normalised by the DTO, not accepted raw
      undefined,
      null,
      582904,
    ])('refuses %p', (code) => {
      expect(isSixDigitCode(code)).toBe(false);
    });
  });

  describe('normalizeCodeInput', () => {
    it('strips the space a pasted SMS code ("482 913") keeps, and any other whitespace', () => {
      expect(normalizeCodeInput('482 913')).toBe('482913');
      expect(normalizeCodeInput(' 48\t29 13\n')).toBe('482913');
    });

    it('turns Myanmar digits (a Burmese keyboard on the website) into 0-9', () => {
      expect(normalizeCodeInput('၄၈၂၉၁၃')).toBe('482913');
      expect(normalizeCodeInput('၀၁၂၃၄၅၆၇၈၉')).toBe('0123456789');
    });

    it('passes non-strings through for the validator to refuse', () => {
      expect(normalizeCodeInput(482913)).toBe(482913);
      expect(normalizeCodeInput(null)).toBeNull();
      expect(normalizeCodeInput(undefined)).toBeUndefined();
    });
  });

  describe('isTooEasyWithdrawalCode', () => {
    it.each(['000000', '111111', '123456', '654321', '121212', '123123'])(
      "refuses the design's own examples: %p",
      (code) => {
        expect(isTooEasyWithdrawalCode(code)).toBe(true);
      },
    );

    it.each(Array.from({ length: 10 }, (_, digit) => String(digit).repeat(6)))(
      'refuses one digit six times: %p',
      (code) => {
        expect(isTooEasyWithdrawalCode(code)).toBe(true);
      },
    );

    it.each([
      '012345',
      '123456',
      '234567',
      '345678',
      '456789',
      '567890',
      '098765',
      '987654',
      '876543',
      '765432',
      '654321',
      '543210',
    ])(
      'refuses the straight run %p (up or down, wrapping through 0)',
      (code) => {
        expect(isTooEasyWithdrawalCode(code)).toBe(true);
      },
    );

    it.each(['121212', '909090', '474747', '010101'])(
      'refuses a pair three times: %p',
      (code) => {
        expect(isTooEasyWithdrawalCode(code)).toBe(true);
      },
    );

    it.each(['123123', '507507', '990990', '001001'])(
      'refuses a three-digit group twice: %p',
      (code) => {
        expect(isTooEasyWithdrawalCode(code)).toBe(true);
      },
    );

    it.each([
      '582904',
      '371940',
      '112233',
      '135790',
      '123457',
      // The design's run check wraps only through 0 at the ends ("567890",
      // "098765"); the server matches the clients exactly, so this passes.
      '678901',
      '122333',
    ])('allows %p', (code) => {
      expect(isTooEasyWithdrawalCode(code)).toBe(false);
    });

    it('judges only a 6-digit code (anything else is a format error first)', () => {
      expect(isTooEasyWithdrawalCode('1234')).toBe(false);
      expect(isTooEasyWithdrawalCode('')).toBe(false);
    });
  });
});
