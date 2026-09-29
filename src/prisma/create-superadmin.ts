/**
 * One-time bootstrap: creates the FIRST Super Admin on a fresh database
 * (H-2). The migrations create the roles and permissions but no account,
 * and the seeds are for local demo data only — this is how production gets
 * its first staff login, with a password nobody else has seen.
 *
 * Inside the backend container (the image ships dist/, not the sources):
 *
 *   docker compose exec backend npm run create-superadmin -- --username <name>
 *
 * Locally: `npm run build` first, then the same `npm run create-superadmin`.
 *
 * The password is never an argument (it would land in shell history and in
 * `ps`) and has no default. In order, it is taken from:
 *   1. SUPERADMIN_PASSWORD — a ONE-TIME env var for that single command; do
 *      not leave it in .env or the compose file;
 *   2. otherwise, a hidden prompt (asked twice) when run in a terminal;
 *   3. otherwise, the first line of piped stdin
 *      (`... | docker compose exec -T backend npm run create-superadmin -- --username <name>`).
 * The username comes from --username (or SUPERADMIN_USERNAME), also with no
 * default.
 *
 * Refuses, changing nothing, when ANY Super Admin already exists (by the
 * enum or by the protected AppRole, whatever its status): after day one,
 * staff accounts are created from the admin's Staff page. Otherwise creates
 * the account on the SUPER_ADMIN AppRole, with its wallet, and writes a
 * system `staff.create` audit row — all in one transaction.
 */
import 'dotenv/config';
import * as bcrypt from 'bcrypt';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Role } from '../generated/prisma/client';
import { PASSWORD_SALT_ROUNDS } from '../auth/password.constants';
import { AuditService } from '../audit/audit.service';
import { userSnapshot } from '../audit/audit-snapshots';
import type { PrismaService } from './prisma.service';

type Env = Record<string, string | undefined>;

/** A refusal with a message meant for the operator; the script exits 1. */
export class SuperAdminBootstrapError extends Error {}

const USERNAME_PATTERN = /^[a-zA-Z0-9_.]{3,32}$/;

export function parseUsername(argv: readonly string[], env: Env): string {
  let username: string | undefined;
  argv.forEach((arg, index) => {
    if (arg === '--username') username = argv[index + 1];
    else if (arg.startsWith('--username=')) {
      username = arg.slice('--username='.length);
    }
  });
  username = (username ?? env.SUPERADMIN_USERNAME)?.trim();
  if (!username) {
    throw new SuperAdminBootstrapError(
      'Give the new account a username: --username <name> (or SUPERADMIN_USERNAME).',
    );
  }
  return username;
}

/** The same rules as creating staff (CreateStaffDto). */
export function validateUsername(username: string): void {
  if (!USERNAME_PATTERN.test(username)) {
    throw new SuperAdminBootstrapError(
      'The username must be 3-32 characters: letters, numbers, dots and underscores only.',
    );
  }
}

/** The same rules as creating staff (CreateStaffDto). Never echoes the value. */
export function validatePassword(password: string): void {
  if (password.length < 8) {
    throw new SuperAdminBootstrapError(
      'The password must be at least 8 characters.',
    );
  }
  if (password.length > 72) {
    throw new SuperAdminBootstrapError(
      'The password must be at most 72 characters.',
    );
  }
}

interface PasswordSources {
  env: Env;
  input: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: unknown };
  output: NodeJS.WritableStream;
}

export async function readPassword({
  env,
  input,
  output,
}: PasswordSources): Promise<string> {
  if (env.SUPERADMIN_PASSWORD) return env.SUPERADMIN_PASSWORD;

  if (input.isTTY && typeof input.setRawMode === 'function') {
    const first = await promptHidden('Password: ', input, output);
    const second = await promptHidden('Password again: ', input, output);
    if (first !== second) {
      throw new SuperAdminBootstrapError('The two passwords do not match.');
    }
    return first;
  }

  const piped = await readAll(input);
  const [firstLine = ''] = piped.split(/\r?\n/);
  if (!firstLine) {
    throw new SuperAdminBootstrapError(
      'No password given: set SUPERADMIN_PASSWORD for this one command, run it in a terminal to be asked, or pipe it on stdin.',
    );
  }
  return firstLine;
}

function readAll(input: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    input.setEncoding('utf8');
    input.on('data', (chunk: string) => {
      text += chunk;
    });
    input.on('end', () => resolve(text));
    input.on('error', reject);
  });
}

/** A terminal prompt that does not echo what is typed. */
function promptHidden(
  question: string,
  input: PasswordSources['input'],
  output: NodeJS.WritableStream,
): Promise<string> {
  const tty = input as NodeJS.ReadStream;
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error?: Error) => {
      tty.setRawMode(false);
      tty.pause();
      tty.removeListener('data', onData);
      output.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n' || char === '\u0004') {
          finish();
          return;
        }
        if (char === '\u0003') {
          finish(new SuperAdminBootstrapError('Cancelled.'));
          return;
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    };
    output.write(question);
    tty.setRawMode(true);
    tty.setEncoding('utf8');
    tty.resume();
    tty.on('data', onData);
  });
}

export async function createSuperAdmin(
  prisma: PrismaClient,
  input: { username: string; password: string },
): Promise<{ id: string; username: string }> {
  validateUsername(input.username);
  validatePassword(input.password);
  const passwordHash = await bcrypt.hash(input.password, PASSWORD_SALT_ROUNDS);
  // The one write path the audit log has; a script has no request, so the
  // row is a system row (actor null, no IP).
  const audit = new AuditService(prisma as unknown as PrismaService);

  return prisma.$transaction(async (tx) => {
    const existing = await tx.user.count({
      where: {
        OR: [{ role: Role.SUPER_ADMIN }, { appRole: { isProtected: true } }],
      },
    });
    if (existing > 0) {
      throw new SuperAdminBootstrapError(
        'A Super Admin already exists, so nothing was changed. Create further staff accounts from the admin Staff page.',
      );
    }

    if (await tx.user.findUnique({ where: { username: input.username } })) {
      throw new SuperAdminBootstrapError(
        `The username "${input.username}" is already taken.`,
      );
    }

    const appRole = await tx.appRole.findUnique({
      where: { key: Role.SUPER_ADMIN },
      select: { id: true, name: true },
    });
    if (!appRole) {
      throw new SuperAdminBootstrapError(
        'The SUPER_ADMIN role is missing: run the database migrations first (npx prisma migrate deploy).',
      );
    }

    const user = await tx.user.create({
      data: {
        username: input.username,
        password: passwordHash,
        role: Role.SUPER_ADMIN,
        appRoleId: appRole.id,
      },
    });
    await tx.wallet.create({ data: { userId: user.id, balance: 0 } });

    await audit.record({
      action: 'staff.create',
      actor: null,
      target: { type: 'staff', id: user.id, label: `@${user.username}` },
      after: userSnapshot({ ...user, appRole: { name: appRole.name } }),
      metadata: { trigger: 'create-superadmin' },
      tx,
    });

    return { id: user.id, username: user.username };
  });
}

async function main(): Promise<void> {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  try {
    const username = parseUsername(process.argv.slice(2), process.env);
    validateUsername(username);
    const password = await readPassword({
      env: process.env,
      input: process.stdin,
      output: process.stdout,
    });
    const created = await createSuperAdmin(prisma, { username, password });
    console.log(
      `Super Admin @${created.username} created. Sign in to the admin with it.`,
    );
    if (process.env.SUPERADMIN_PASSWORD) {
      console.log(
        'SUPERADMIN_PASSWORD was read from the environment: make sure it is not stored anywhere (.env, compose file, shell history).',
      );
    }
  } catch (error) {
    console.error(
      error instanceof SuperAdminBootstrapError
        ? error.message
        : `create-superadmin failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) void main();
