import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A setting reaches the Docker container only through the backend service's
 * `environment:` block in docker-compose.yml: the image carries no .env
 * (.dockerignore) and compose forwards nothing on its own. Twice a key was
 * added to the code and to .env.example but not to that block —
 * OTP_CODE_PEPPER (2026-10-06 round) and the eight tunables of OPS-001 — so a
 * value typed into backend/.env silently did nothing in Docker. This spec
 * turns the next omission into a red build.
 *
 * .env.example is the one list of keys. A paragraph that starts with
 * `# --- Only ...` documents keys read by compose itself, the seed scripts,
 * the e2e setup or the backup script — never by the running app — and those
 * are the only keys excused from the compose block. Every other key, a
 * documented-but-commented one included (`# OTP_DEV_CODE=123456`), must be
 * forwarded as `KEY: ${KEY...}` so the value comes from .env.
 */
const BACKEND_DIR = join(__dirname, '..', '..');
const ENV_EXAMPLE_PATH = join(BACKEND_DIR, '.env.example');
const COMPOSE_PATH = join(BACKEND_DIR, 'docker-compose.yml');
const VALIDATION_PATH = join(__dirname, 'env.validation.ts');

/** A key line: `KEY=value`, or a documented-but-off `# KEY=value`. */
const KEY_LINE = /^#?\s?([A-Z][A-Z0-9_]*)=/;
/** Opens a paragraph of keys the app itself never reads. */
const NOT_AN_APP_KEY_HEADER = /^# --- Only /;
/** A `KEY: value` line six spaces deep — the compose environment block. */
const COMPOSE_ENV_LINE = /^ {6}([A-Z][A-Z0-9_]*):\s*(.*)$/;
/** A validated field of the EnvironmentVariables class. */
const VALIDATED_FIELD = /^ {2}([A-Z][A-Z0-9_]*)[?!]?:/gm;

/**
 * Compose computes these itself (the database address from POSTGRES_*, the
 * production mode, the container's port and scratch path); every other key
 * must reference its own `${KEY...}` so .env decides the value.
 */
const COMPOSE_COMPUTED_KEYS: ReadonlySet<string> = new Set([
  'DATABASE_URL',
  'NODE_ENV',
  'PORT',
  'STORAGE_PATH',
]);

interface EnvExampleKeys {
  /** Read by the running app: must be forwarded by compose. */
  app: string[];
  /** Compose-only / scripts-only: documented, never forwarded. */
  other: string[];
}

function envExampleKeys(text: string): EnvExampleKeys {
  const app: string[] = [];
  const other: string[] = [];
  for (const paragraph of text.split(/\n\s*\n/)) {
    const lines = paragraph.split('\n');
    const bucket = NOT_AN_APP_KEY_HEADER.test(lines[0].trim()) ? other : app;
    for (const line of lines) {
      const match = KEY_LINE.exec(line);
      if (match) bucket.push(match[1]);
    }
  }
  return { app, other };
}

interface ComposeEnvEntry {
  key: string;
  value: string;
}

/** The backend service's `environment:` entries, in file order. */
function backendEnvironment(compose: string): ComposeEnvEntry[] {
  const lines = compose.split('\n');
  const service = lines.indexOf('  backend:');
  if (service === -1) throw new Error('no `backend:` service in compose');
  const start = lines.indexOf('    environment:', service);
  if (start === -1) throw new Error('backend service has no environment:');

  const entries: ComposeEnvEntry[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    // Anything shallower than the block's six spaces is the next mapping.
    if (!line.startsWith('      ')) break;
    const match = COMPOSE_ENV_LINE.exec(line);
    if (match) entries.push({ key: match[1], value: match[2] });
  }
  return entries;
}

describe('docker-compose.yml backend environment block', () => {
  const example = envExampleKeys(readFileSync(ENV_EXAMPLE_PATH, 'utf8'));
  const compose = backendEnvironment(readFileSync(COMPOSE_PATH, 'utf8'));
  const composeKeys = new Set(compose.map((entry) => entry.key));

  it('parses both files the way this spec expects', () => {
    // Guards the two hand-rolled parsers against a reformatted file: a
    // parser that silently found nothing would make every check below pass.
    expect(example.app.length).toBeGreaterThan(30);
    expect(example.other).toEqual(
      expect.arrayContaining([
        'POSTGRES_PASSWORD',
        'SEED_PASSWORD',
        'E2E_DATABASE_URL',
        'BACKUP_OFFSITE_DEST',
      ]),
    );
    expect(example.app).not.toEqual(
      expect.arrayContaining(['POSTGRES_PASSWORD']),
    );
    expect(compose.length).toBeGreaterThan(30);
    expect(composeKeys).toContain('DATABASE_URL');
  });

  it('forwards every app key .env.example documents', () => {
    const missing = example.app.filter((key) => !composeKeys.has(key));
    expect(missing).toEqual([]);
  });

  it('forwards only keys .env.example documents', () => {
    const documented = new Set([...example.app, ...example.other]);
    const undocumented = compose
      .filter((entry) => !documented.has(entry.key))
      .map((entry) => entry.key);
    expect(undocumented).toEqual([]);
  });

  it('takes every forwarded value from .env instead of hard-coding it', () => {
    const hardCoded = compose
      .filter(
        (entry) =>
          !COMPOSE_COMPUTED_KEYS.has(entry.key) &&
          !entry.value.includes(`\${${entry.key}`),
      )
      .map((entry) => entry.key);
    expect(hardCoded).toEqual([]);
  });

  it('documents every setting env.validation.ts validates', () => {
    const validated = [
      ...readFileSync(VALIDATION_PATH, 'utf8').matchAll(VALIDATED_FIELD),
    ].map((match) => match[1]);
    expect(validated.length).toBeGreaterThan(20);
    const undocumented = validated.filter((key) => !example.app.includes(key));
    expect(undocumented).toEqual([]);
  });
});
