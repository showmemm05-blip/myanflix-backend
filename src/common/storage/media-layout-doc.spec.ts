import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  IMAGE_PURPOSES,
  MEDIA_CLASSES,
  MediaClass,
  NGINX_SCOPE_ALTERNATION,
  UUID,
} from './media-taxonomy';

/**
 * docs/media-storage-layout.md is the page a human reads before touching a
 * key, so it has exactly one failure mode worth guarding: quietly drifting
 * from the registry it claims to describe. A prefix renamed in
 * media-taxonomy.ts and not here does not break a build — it just turns the
 * documentation into a confident lie, which is worse than having none.
 *
 * So the doc's factual content is checked both ways:
 *   - the `<!-- BEGIN GENERATED ... -->` blocks are rendered from the
 *     registry and compared byte for byte,
 *   - the hand-maintained layout table is parsed and every registry-derived
 *     cell is compared, in registry order, with no extra and no missing rows.
 *     Its Holds / Delete prefix / Written by columns cannot be generated —
 *     nothing in the registry knows which service writes a prefix — so those
 *     are only required to be non-empty. Adding a class therefore leaves this
 *     red until a person answers those two questions.
 *
 * Re-render the generated blocks with:
 *   UPDATE_MEDIA_LAYOUT_DOC=1 npx jest media-layout-doc
 *
 * As with nginx-scopes.spec.ts, the backend can be checked out without the
 * rest of the monorepo beside it, so an ABSENT doc skips with a clear message
 * — a missing file proves nothing about drift. A doc that is present but out
 * of sync always fails.
 */
const DOC_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'docs',
  'media-storage-layout.md',
);

const UPDATE = process.env.UPDATE_MEDIA_LAYOUT_DOC === '1';

/** `videos/[0-9a-f]{8}-…/hls` reads as `videos/<uuid>/hls` on the page. */
const readableScope = (keyPattern: string): string =>
  keyPattern.split(UUID).join('<uuid>');

const scopeCell = (mediaClass: MediaClass): string =>
  mediaClass.scopePattern
    ? `\`${readableScope(mediaClass.scopePattern.key)}\``
    : '—';

const retentionCell = (mediaClass: MediaClass): string =>
  mediaClass.retention.kind === 'permanent'
    ? 'permanent'
    : `expires after ${mediaClass.retention.afterDays} days`;

const scratchLine = (mediaClass: MediaClass): string =>
  mediaClass.localScratchRoot === null
    ? 'no local scratch'
    : `local scratch \`<STORAGE_PATH>/temp/${mediaClass.localScratchRoot}/\``;

/**
 * The registry's prose is written for a TypeScript comment, where `<uuid>`
 * reads fine. A markdown renderer treats that as an HTML tag and drops it, so
 * placeholders get a code span — but only outside spans that already have one
 * (the registry writes `subs/<id>.m3u8` as a single span, and a second pair of
 * backticks inside it would break it).
 */
const codeSpanPlaceholders = (prose: string): string =>
  prose
    .split(/(`[^`]*`)/)
    .map((chunk, index) =>
      index % 2 === 1
        ? chunk
        : chunk.replace(/(?:<[A-Za-z]+>)+/g, (match) => `\`${match}\``),
    )
    .join('');

/** One `### prefix` section per class, holds prose verbatim from the registry. */
const renderDetail = (): string =>
  MEDIA_CLASSES.map((mediaClass) =>
    [
      `### \`${mediaClass.prefix}\``,
      '',
      `*${mediaClass.status} · ${mediaClass.visibility} · ${retentionCell(mediaClass)} · ${
        mediaClass.archivable ? 'archivable' : 'not archivable'
      } · ${scratchLine(mediaClass)}*`,
      '',
      codeSpanPlaceholders(mediaClass.holds),
    ].join('\n'),
  ).join('\n\n');

const renderPurposes = (): string =>
  IMAGE_PURPOSES.map((purpose) => `\`${purpose}\``).join(' · ');

const renderScopes = (): string =>
  [
    'The signable scopes, in registry order:',
    '',
    ...MEDIA_CLASSES.filter(
      (mediaClass) => mediaClass.scopePattern !== null,
    ).map(
      (mediaClass) => `- \`${readableScope(mediaClass.scopePattern!.key)}\``,
    ),
    '',
    "And the exact alternation that goes inside nginx's `(?<scope>...)`, in",
    'both signed locations:',
    '',
    '```',
    NGINX_SCOPE_ALTERNATION,
    '```',
  ].join('\n');

const GENERATED_BLOCKS: ReadonlyArray<{ name: string; render: () => string }> =
  [
    { name: 'media-classes-detail', render: renderDetail },
    { name: 'image-purposes', render: renderPurposes },
    { name: 'stream-scopes', render: renderScopes },
  ];

const blockPattern = (name: string): RegExp =>
  new RegExp(
    `(<!-- BEGIN GENERATED ${name} -->\\n)([\\s\\S]*?)(<!-- END GENERATED ${name} -->)`,
  );

type TableRow = Record<string, string>;

/** Parses the one pipe table whose header row starts with the given column. */
const parseTable = (markdown: string, firstColumn: string): TableRow[] => {
  const lines = markdown.split('\n');
  const headerAt = lines.findIndex((line) =>
    line.startsWith(`| ${firstColumn} |`),
  );
  if (headerAt === -1) {
    return [];
  }
  const cells = (line: string): string[] =>
    line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
  const columns = cells(lines[headerAt]);
  const rows: TableRow[] = [];
  // headerAt + 1 is the |---|---| separator.
  for (let at = headerAt + 2; at < lines.length; at += 1) {
    if (!lines[at].startsWith('|')) {
      break;
    }
    const values = cells(lines[at]);
    rows.push(
      Object.fromEntries(columns.map((column, i) => [column, values[i] ?? ''])),
    );
  }
  return rows;
};

const docExists = existsSync(DOC_PATH);

describe('docs/media-storage-layout.md matches the media registry', () => {
  if (!docExists) {
    it.skip(`SKIPPED — ${DOC_PATH} is not present (docs/ lives outside the backend deploy unit; nothing to compare against)`, () => {
      // Intentionally empty: recorded as a skip so the reason shows up in the
      // run output instead of silently passing.
    });
    return;
  }

  let doc = readFileSync(DOC_PATH, 'utf8');

  if (UPDATE) {
    for (const block of GENERATED_BLOCKS) {
      doc = doc.replace(
        blockPattern(block.name),
        (_match, begin: string, _body: string, end: string) =>
          `${begin}\n${block.render()}\n\n${end}`,
      );
    }
    writeFileSync(DOC_PATH, doc, 'utf8');
  }

  describe.each(GENERATED_BLOCKS.map((block) => [block.name, block] as const))(
    'generated block %s',
    (name, block) => {
      it('is present and rendered from the registry', () => {
        const match = blockPattern(name).exec(doc);
        expect(match).not.toBeNull();
        // Compared trimmed so the blank lines that keep the markdown readable
        // around the markers are not part of the contract.
        expect(match![2].trim()).toBe(block.render().trim());
      });
    },
  );

  describe('the layout table', () => {
    const rows = parseTable(doc, 'Prefix');

    it('has exactly one row per registry class, in registry order', () => {
      expect(rows.map((row) => row.Prefix)).toEqual(
        MEDIA_CLASSES.map((mediaClass) => `\`${mediaClass.prefix}\``),
      );
    });

    it.each(MEDIA_CLASSES.map((mediaClass) => [mediaClass.prefix, mediaClass]))(
      '%s says what the registry says',
      (prefix, mediaClass) => {
        const row = rows.find(
          (candidate) => candidate.Prefix === `\`${prefix}\``,
        );
        expect(row).toBeDefined();
        expect({
          Status: row!.Status,
          Visibility: row!.Visibility,
          'Signed scope': row!['Signed scope'],
          Retention: row!.Retention,
        }).toEqual({
          Status: mediaClass.status,
          Visibility: mediaClass.visibility,
          'Signed scope': scopeCell(mediaClass),
          Retention: retentionCell(mediaClass),
        });
      },
    );

    it.each(MEDIA_CLASSES.map((mediaClass) => [mediaClass.prefix]))(
      '%s answers the two questions the registry cannot',
      (prefix) => {
        const row = rows.find(
          (candidate) => candidate.Prefix === `\`${prefix}\``,
        );
        expect(row).toBeDefined();
        // A new class lands here with empty cells; that is the prompt to say
        // which code writes it and what deletes it.
        expect(row!.Holds.length).toBeGreaterThan(0);
        expect(row!['Delete prefix'].length).toBeGreaterThan(0);
        expect(row!['Written by'].length).toBeGreaterThan(0);
      },
    );
  });

  describe('the image-purpose table', () => {
    const rows = parseTable(doc, 'Purpose');

    it('has exactly one row per purpose, in registry order', () => {
      expect(rows.map((row) => row.Purpose)).toEqual(
        IMAGE_PURPOSES.map((purpose) => `\`${purpose}\``),
      );
    });
  });
});
