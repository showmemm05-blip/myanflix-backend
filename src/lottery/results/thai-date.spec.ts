import { compactDate, parseThaiDate, toGregorianYear } from './thai-date';

describe('parseThaiDate', () => {
  it('reads the Thai lotto JSON date: day, Thai month name, Buddhist year', () => {
    expect(parseThaiDate('16 สิงหาคม 2568')).toBe('2025-08-16');
    expect(parseThaiDate('1 มกราคม 2569')).toBe('2026-01-01');
    expect(parseThaiDate('16 ธันวาคม 2568')).toBe('2025-12-16');
    expect(parseThaiDate('  16   กุมภาพันธ์  2569 ')).toBe('2026-02-16');
  });

  it('reads every Thai month, full or abbreviated', () => {
    const full = [
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
    ];
    const short = [
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
    ];
    full.forEach((month, i) => {
      const mm = String(i + 1).padStart(2, '0');
      expect(parseThaiDate(`1 ${month} 2569`)).toBe(`2026-${mm}-01`);
      expect(parseThaiDate(`1 ${short[i]} 2569`)).toBe(`2026-${mm}-01`);
      expect(parseThaiDate(`1 ${short[i].replace(/\.$/, '')} 2569`)).toBe(
        `2026-${mm}-01`,
      );
    });
  });

  it('reads an English month, ISO, slashed and compact dates, Buddhist or Gregorian year', () => {
    expect(parseThaiDate('16 August 2025')).toBe('2025-08-16');
    expect(parseThaiDate('16 aug 2568')).toBe('2025-08-16');
    expect(parseThaiDate('2025-08-16')).toBe('2025-08-16');
    expect(parseThaiDate('2025-8-1')).toBe('2025-08-01');
    expect(parseThaiDate('2025-08-16T07:30:00Z')).toBe('2025-08-16');
    expect(parseThaiDate('2025-08-16 14:30')).toBe('2025-08-16');
    expect(parseThaiDate('16/08/2568')).toBe('2025-08-16');
    expect(parseThaiDate('16-08-2025')).toBe('2025-08-16');
    expect(parseThaiDate('20250816')).toBe('2025-08-16');
    expect(parseThaiDate('25680816')).toBe('2025-08-16');
  });

  it('reads nothing else', () => {
    expect(parseThaiDate(undefined)).toBeNull();
    expect(parseThaiDate(null)).toBeNull();
    expect(parseThaiDate(20250816)).toBeNull();
    expect(parseThaiDate('')).toBeNull();
    expect(parseThaiDate('yesterday')).toBeNull();
    expect(parseThaiDate('16 Smarch 2025')).toBeNull();
    expect(parseThaiDate('31 กุมภาพันธ์ 2568')).toBeNull();
    expect(parseThaiDate('2025-13-01')).toBeNull();
    expect(parseThaiDate('16 สิงหาคม')).toBeNull();
  });

  it('turns a Buddhist year into Gregorian and leaves a Gregorian one alone', () => {
    expect(toGregorianYear(2568)).toBe(2025);
    expect(toGregorianYear(2025)).toBe(2025);
    expect(toGregorianYear(2401)).toBe(1858);
    expect(toGregorianYear(2400)).toBe(2400);
  });

  it('compactDate writes a draw date as YYYYMMDD for a per-date URL', () => {
    expect(compactDate('2026-11-01')).toBe('20261101');
  });
});
