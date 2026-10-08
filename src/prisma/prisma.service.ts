import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

/**
 * node-postgres' own default pool size. Kept as the default so an unset
 * DATABASE_POOL_MAX behaves exactly as before the setting existed.
 */
export const DEFAULT_DATABASE_POOL_MAX = 10;

/** An idle connection is closed after this long (node-postgres' default is 10 s). */
export const DATABASE_POOL_IDLE_TIMEOUT_MS = 30_000;

/**
 * How long a query may wait for a free pooled connection before it fails.
 * node-postgres waits forever by default, so a pool exhausted by slow
 * queries used to hang every other request instead of failing visibly.
 */
export const DATABASE_POOL_CONNECTION_TIMEOUT_MS = 10_000;

/**
 * The pool size to use: DATABASE_POOL_MAX when it is a whole number of at
 * least 1 (env.validation.ts already refuses anything outside 1-50 at boot),
 * otherwise the default.
 */
export function resolvePoolMax(raw: unknown): number {
  const value = typeof raw === 'string' ? Number(raw) : raw;
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
    ? value
    : DEFAULT_DATABASE_POOL_MAX;
}

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor(configService: ConfigService) {
    super({
      adapter: new PrismaPg({
        connectionString: configService.get<string>('DATABASE_URL'),
        max: resolvePoolMax(configService.get<unknown>('DATABASE_POOL_MAX')),
        idleTimeoutMillis: DATABASE_POOL_IDLE_TIMEOUT_MS,
        connectionTimeoutMillis: DATABASE_POOL_CONNECTION_TIMEOUT_MS,
      }),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Connected to the database');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
