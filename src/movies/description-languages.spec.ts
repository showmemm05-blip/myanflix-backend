import { CodedHttpException } from '../common/errors/coded-http.exception';
import {
  DESCRIPTION_REQUIRED_CODE,
  DESCRIPTION_REQUIRED_MESSAGE,
  assertDescriptionInSomeLanguage,
  assertDescriptionKeptInSomeLanguage,
  blankToNull,
} from './description-languages';

const refusal = (run: () => void): CodedHttpException | null => {
  try {
    run();
    return null;
  } catch (error) {
    return error as CodedHttpException;
  }
};

describe('blankToNull', () => {
  it.each(['', ' ', '\n\t  '])('turns a blank text (%p) into null', (text) => {
    expect(blankToNull(text)).toBeNull();
  });

  it('returns any other text exactly as it came — nothing is trimmed', () => {
    expect(blankToNull(' မြန်မာ ')).toBe(' မြန်မာ ');
    expect(blankToNull('x')).toBe('x');
  });

  it('passes null and undefined through, so an absent field stays absent', () => {
    expect(blankToNull(null)).toBeNull();
    expect(blankToNull(undefined)).toBeUndefined();
  });
});

describe('assertDescriptionInSomeLanguage', () => {
  it.each([
    ['English only', 'A thief.', null],
    ['Burmese only', '', 'သူခိုးတစ်ယောက်'],
    ['Burmese only, English missing', undefined, 'သူခိုးတစ်ယောက်'],
    ['both', 'A thief.', 'သူခိုးတစ်ယောက်'],
  ])('accepts %s', (_what, description, descriptionMm) => {
    expect(
      refusal(() =>
        assertDescriptionInSomeLanguage(description, descriptionMm),
      ),
    ).toBeNull();
  });

  it.each([
    ['both empty', '', ''],
    ['both only spaces', '  ', '\n'],
    ['empty and null', '', null],
    ['nothing at all', undefined, undefined],
  ])('refuses %s with a coded 400', (_what, description, descriptionMm) => {
    const error = refusal(() =>
      assertDescriptionInSomeLanguage(description, descriptionMm),
    );

    expect(error).toBeInstanceOf(CodedHttpException);
    expect(error!.getStatus()).toBe(400);
    expect(error!.code).toBe(DESCRIPTION_REQUIRED_CODE);
    expect(error!.getResponse()).toEqual({
      message: DESCRIPTION_REQUIRED_MESSAGE,
      code: 'DESCRIPTION_REQUIRED',
    });
  });
});

describe('assertDescriptionKeptInSomeLanguage', () => {
  const both = { description: 'A thief.', descriptionMm: 'သူခိုးတစ်ယောက်' };
  const englishOnly = { description: 'A thief.', descriptionMm: null };
  const burmeseOnly = { description: '', descriptionMm: 'သူခိုးတစ်ယောက်' };
  const none = { description: '', descriptionMm: null };

  it('never refuses a change that touches neither description, even on a row that has none', () => {
    expect(
      refusal(() => assertDescriptionKeptInSomeLanguage({}, none)),
    ).toBeNull();
    expect(
      refusal(() => assertDescriptionKeptInSomeLanguage({}, {})),
    ).toBeNull();
  });

  it.each([
    ['blanking English while Burmese is stored', { description: '' }, both],
    ['blanking Burmese while English is stored', { descriptionMm: '' }, both],
    ['clearing Burmese with null', { descriptionMm: null }, englishOnly],
    [
      'swapping the only language in one save',
      { description: '', descriptionMm: 'သူခိုး' },
      englishOnly,
    ],
    ['giving a row its first description', { descriptionMm: 'သူခိုး' }, none],
  ])('accepts %s', (_what, change, stored) => {
    expect(
      refusal(() => assertDescriptionKeptInSomeLanguage(change, stored)),
    ).toBeNull();
  });

  it.each([
    [
      'blanking the only (English) description',
      { description: ' ' },
      englishOnly,
    ],
    [
      'blanking the only (Burmese) description',
      { descriptionMm: '' },
      burmeseOnly,
    ],
    [
      'clearing the only (Burmese) description with null',
      { descriptionMm: null },
      burmeseOnly,
    ],
    ['blanking both', { description: '', descriptionMm: '' }, both],
    [
      'sending a blank description to a row that has none',
      { description: '' },
      none,
    ],
  ])('refuses %s', (_what, change, stored) => {
    expect(
      refusal(() => assertDescriptionKeptInSomeLanguage(change, stored))?.code,
    ).toBe(DESCRIPTION_REQUIRED_CODE);
  });
});
