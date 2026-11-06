import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * How long the database probe may take before the API calls itself
 * degraded. node-postgres waits up to 10 s for a free pooled connection
 * (DATABASE_POOL_CONNECTION_TIMEOUT_MS), longer than any poller waits for
 * an answer — the admin's network check gives up after 4 s, the compose
 * healthcheck after 5 s — so the probe is cut short here instead.
 */
export const HEALTH_DB_TIMEOUT_MS = 2_000;

type ProbeOutcome = 'ok' | 'failed' | 'timeout';

/**
 * One line for the log: the error's code (Prisma: `P2010`) and the LAST
 * non-empty line of its message — Prisma's message opens with a newline and
 * ends with the cause ("Can't reach database server at …") — never a stack.
 */
function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const line =
    message
      .split('\n')
      .map((part) => part.trim())
      .filter(Boolean)
      .pop() ?? (error instanceof Error ? error.name : 'unknown error');
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? `${code} ${line}` : line;
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * True when `SELECT 1` answers within HEALTH_DB_TIMEOUT_MS; false when the
   * query fails or takes longer (OPS-005: the old handler answered "ok" with
   * Postgres stopped). Never throws, so a probe can never crash the route;
   * an answer that arrives after the timeout has already lost the race is
   * dropped, not reported.
   */
  async databaseReachable(): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    const timeout = new Promise<ProbeOutcome>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), HEALTH_DB_TIMEOUT_MS);
    });
    // Settles with an outcome instead of rejecting, so a query that fails
    // after the timeout won can never surface as an unhandled rejection.
    const probe: Promise<ProbeOutcome> = this.prisma.$queryRaw`SELECT 1`.then(
      () => 'ok' as const,
      (error: unknown) => {
        if (!settled) {
          this.logger.warn(`Database probe failed: ${describe(error)}`);
        }
        return 'failed' as const;
      },
    );
    try {
      const outcome = await Promise.race([probe, timeout]);
      settled = true;
      if (outcome === 'timeout') {
        this.logger.warn(
          `Database probe took longer than ${HEALTH_DB_TIMEOUT_MS} ms`,
        );
      }
      return outcome === 'ok';
    } finally {
      clearTimeout(timer);
    }
  }
}
