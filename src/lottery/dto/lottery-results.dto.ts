import { applyDecorators } from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  Max,
  ValidateNested,
} from 'class-validator';
import { isIP } from 'node:net';
import {
  PRIZE_BAHT_MAX,
  PRIZE_GROUP_KEYS,
  type PrizeGroupKey,
} from '../results/prize-groups';
import { trimmedOrNull } from './lottery-dream.dto';

/**
 * Field limits of the results DTOs. The Baht ceiling is the one
 * checkPrizeGroups applies to every sheet (the API's included): the
 * Decimal(12,2) ceiling of lottery_payouts.baht.
 */
export const LOTTERY_RESULTS_LIMITS = {
  bahtMax: PRIZE_BAHT_MAX,
  /** The biggest group (fifth prize) has 100 numbers. */
  numbersMax: 100,
  note: 500,
  resultsUrl: 1000,
} as const;

/** A number of a sheet: 2, 3 or 6 digits; the service checks the exact length per group. */
const SHEET_NUMBER_PATTERN = /^\d{2,6}$/;

/** The results status as the admin reads it. */
export const RESULT_STATUS_WIRE = [
  'pending',
  'fetched',
  'published',
  'failed',
] as const;

export type ResultStatusWire = (typeof RESULT_STATUS_WIRE)[number];

/** Who supplied the sheet, on the wire. */
export const RESULT_SOURCE_WIRE = ['api', 'manual'] as const;

export type ResultSourceWire = (typeof RESULT_SOURCE_WIRE)[number];

/** One group as typed into the "Enter by hand" dialog. */
export class EnterResultsGroupDto {
  @IsIn(PRIZE_GROUP_KEYS)
  key!: PrizeGroupKey;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(LOTTERY_RESULTS_LIMITS.bahtMax)
  baht!: number;

  @Transform(({ value }: { value: unknown }) =>
    Array.isArray(value)
      ? value.map((item: unknown) =>
          typeof item === 'string' ? item.trim() : item,
        )
      : value,
  )
  @IsArray()
  @ArrayMaxSize(LOTTERY_RESULTS_LIMITS.numbersMax)
  @IsString({ each: true })
  @Matches(SHEET_NUMBER_PATTERN, {
    each: true,
    message: 'each number must be 2, 3 or 6 digits',
  })
  numbers!: string[];
}

/**
 * PUT /lottery/admin/draws/:id/results — the whole sheet, all nine groups
 * (the service checks keys, counts and digit lengths per group and answers
 * 400 LOTTERY_RESULTS_INVALID with every problem). `note` is kept in the
 * audit row only.
 */
export class EnterResultsDto {
  @IsArray()
  @ArrayMinSize(PRIZE_GROUP_KEYS.length)
  @ArrayMaxSize(PRIZE_GROUP_KEYS.length)
  @ValidateNested({ each: true })
  @Type(() => EnterResultsGroupDto)
  groups!: EnterResultsGroupDto[];

  @Transform(({ value }: { value: unknown }) => trimmedOrNull(value))
  @IsOptional()
  @IsString()
  @MaxLength(LOTTERY_RESULTS_LIMITS.note)
  note?: string | null;
}

/** True for an absolute http(s) URL with a host. */
export function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') && url.host !== ''
    );
  } catch {
    return false;
  }
}

/** IPv4 ranges the results fetcher must never be pointed at: this host, the LAN, link-local, CGNAT. */
const PRIVATE_V4_BLOCKS: ReadonlyArray<[number, number]> = [
  [0x00000000, 8], // 0.0.0.0/8 — "this" network
  [0x0a000000, 8], // 10.0.0.0/8
  [0x7f000000, 8], // 127.0.0.0/8
  [0xa9fe0000, 16], // 169.254.0.0/16
  [0xac100000, 12], // 172.16.0.0/12
  [0xc0a80000, 16], // 192.168.0.0/16
  [0x64400000, 10], // 100.64.0.0/10
];

function v4ToInt(address: string): number {
  return address
    .split('.')
    .reduce((acc, octet) => ((acc << 8) | Number(octet)) >>> 0, 0);
}

function isPrivateV4Int(value: number): boolean {
  return PRIVATE_V4_BLOCKS.some(
    ([base, bits]) => value >>> (32 - bits) === base >>> (32 - bits),
  );
}

function isPrivateV4(address: string): boolean {
  return isPrivateV4Int(v4ToInt(address));
}

/**
 * An IPv6 literal as its eight 16-bit words ("::" expanded, a dotted
 * IPv4 tail folded into the last two), or null when it does not parse.
 */
function v6Words(address: string): number[] | null {
  let text = address.toLowerCase();
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const v4 = v4ToInt(dotted[1]);
    text =
      text.slice(0, -dotted[1].length) +
      `${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const words = [...head, ...Array<string>(missing).fill('0'), ...tail].map(
    (word) => parseInt(word, 16),
  );
  return words.length === 8 && words.every((word) => !Number.isNaN(word))
    ? words
    : null;
}

/** ::, ::1, fc00::/7, fe80::/10, and ::ffff:a.b.c.d (in either spelling) standing for a private IPv4. */
function isPrivateV6(address: string): boolean {
  const words = v6Words(address);
  if (!words) return true;
  const [w0, w1, w2, w3, w4, w5, w6, w7] = words;
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0) {
    if (w5 === 0 && w6 === 0 && (w7 === 0 || w7 === 1)) return true;
    if (w5 === 0xffff) return isPrivateV4Int(((w6 << 16) | w7) >>> 0);
  }
  return (w0 & 0xfe00) === 0xfc00 || (w0 & 0xffc0) === 0xfe80;
}

/**
 * True for a host the results fetcher may be pointed at: not this
 * machine, not the LAN, not a loopback or private IP literal — a staff
 * member with the settings permission must not be able to make the
 * backend read MinIO, Postgres-adjacent ports or itself.
 */
export function isPublicHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === '' || host === 'localhost') return false;
  if (host.endsWith('.localhost') || host.endsWith('.local')) return false;
  switch (isIP(host)) {
    case 4:
      return !isPrivateV4(host);
    case 6:
      return !isPrivateV6(host);
    default:
      return true;
  }
}

/** The one message the settings PATCH answers for a results URL on a private host. */
export const RESULTS_URL_PRIVATE_HOST_MESSAGE =
  'resultsUrl must point at a public host';

/**
 * The results source URL in the settings PATCH: absent = keep, null or ''
 * = no source (manual entry only), else an absolute http/https URL
 * (checked by the service, which answers 400 with a plain message).
 */
export function OptionalResultsUrl() {
  return applyDecorators(
    Transform(({ value }: { value: unknown }) => trimmedOrNull(value)),
    IsOptional(),
    IsString(),
    MaxLength(LOTTERY_RESULTS_LIMITS.resultsUrl),
    Matches(/^https?:\/\/\S+$/i, {
      message: 'resultsUrl must be an absolute http or https URL',
    }),
  );
}
