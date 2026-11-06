import { isCalendarDate } from '../lottery-time';

/**
 * The Thai month names as the lottery sites print them, in calendar
 * order. The Buddhist year (พ.ศ.) is the Gregorian year + 543.
 */
const THAI_MONTHS = [
  'มกราคม',
  'กุมภาพันธ์',
  'มีนาคม',
  'เมษายน',
  'พฤษภาคม',
  'มิถุนายน',
  'กรกฎาคม',
  'สิงหาคม',
  'กันยายน',
  'ตุลาคม',
  'พฤศจิกายน',
  'ธันวาคม',
] as const;

/** Thai abbreviations (with or without the trailing dot), the same order. */
const THAI_MONTHS_SHORT = [
  'ม.ค.',
  'ก.พ.',
  'มี.ค.',
  'เม.ย.',
  'พ.ค.',
  'มิ.ย.',
  'ก.ค.',
  'ส.ค.',
  'ก.ย.',
  'ต.ค.',
  'พ.ย.',
  'ธ.ค.',
] as const;

const ENGLISH_MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
] as const;

export const BUDDHIST_YEAR_OFFSET = 543;

/** A year the sources print: Buddhist (2568) when it is past 2400, else Gregorian (2025). */
export function toGregorianYear(year: number): number {
  return year > 2400 ? year - BUDDHIST_YEAR_OFFSET : year;
}

function monthNumber(word: string): number | null {
  const lower = word.toLowerCase();
  const full = THAI_MONTHS.findIndex((name) => lower === name);
  if (full >= 0) return full + 1;
  const short = THAI_MONTHS_SHORT.findIndex(
    (name) => lower === name || lower === name.replace(/\.$/, ''),
  );
  if (short >= 0) return short + 1;
  const english = ENGLISH_MONTHS.findIndex(
    (name) => lower === name || lower === name.slice(0, 3),
  );
  if (english >= 0) return english + 1;
  return null;
}

const pad = (n: number) => String(n).padStart(2, '0');

function build(year: number, month: number, day: number): string | null {
  const candidate = `${String(toGregorianYear(year)).padStart(4, '0')}-${pad(
    month,
  )}-${pad(day)}`;
  return isCalendarDate(candidate) ? candidate : null;
}

/**
 * Reads the date a results source prints into YYYY-MM-DD, tolerantly:
 * "16 สิงหาคม 2568" (the Thai lotto JSON shape), "16 ส.ค. 2568",
 * "16 August 2025", "2025-08-16", "16/08/2568", "20250816". A Buddhist
 * year becomes Gregorian. Anything else reads as null.
 */
export function parseThaiDate(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const value = text.trim().replace(/\s+/g, ' ');
  if (value === '') return null;

  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(value);
  if (match) {
    return build(Number(match[1]), Number(match[2]), Number(match[3]));
  }
  match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(value);
  if (match) {
    return build(Number(match[3]), Number(match[2]), Number(match[1]));
  }
  match = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (match) {
    return build(Number(match[1]), Number(match[2]), Number(match[3]));
  }
  match = /^(\d{1,2}) (\S+) (\d{4})$/.exec(value);
  if (match) {
    const month = monthNumber(match[2]);
    if (month === null) return null;
    return build(Number(match[3]), month, Number(match[1]));
  }
  return null;
}

/** The draw date as the per-date endpoints want it in a URL: YYYYMMDD. */
export function compactDate(thaiDrawDate: string): string {
  return thaiDrawDate.replace(/-/g, '');
}
