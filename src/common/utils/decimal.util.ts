import type { Prisma } from '../../generated/prisma/client';

/** Prisma returns money columns as Decimal instances; API responses want plain numbers. */
export function decimalToNumber(value: Prisma.Decimal | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === 'number' ? value : value.toNumber();
}
