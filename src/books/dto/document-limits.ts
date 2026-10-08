import {
  registerDecorator,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';

/**
 * Ceilings on one written chapter / section document (M-8). The reader
 * apps lay a whole chapter out at once on the main thread, and the chapter
 * detail response carries every section's document — so each document is
 * bounded on three axes, all well below the 20 MB JSON body limit that
 * exists for the upload routes:
 *   - bytes: the serialised JSON. 2 MB is roughly 300,000 words of plain
 *     paragraphs — a very long chapter is a tenth of that.
 *   - nodes: every object and array in the JSON (a paragraph is ~3). A
 *     render cost bound, since every node becomes a DOM / RN element.
 *   - depth: JSON nesting. ProseMirror documents are shallow (a list inside
 *     a list inside a blockquote is a handful of levels).
 */
export const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
export const MAX_DOCUMENT_NODES = 50_000;
export const MAX_DOCUMENT_DEPTH = 64;

/** How many sections one chapter may hold — see BooksService.createSection. */
export const MAX_SECTIONS_PER_CHAPTER = 500;

export interface DocumentMeasure {
  bytes: number;
  nodes: number;
  depth: number;
}

/**
 * Walks the document once, counting containers and tracking depth, and
 * serialises it for the byte count. Stops early as soon as a ceiling is
 * passed so a hostile document costs at most the ceiling's worth of work.
 * `null` means "within every limit".
 */
export function documentLimitViolation(value: unknown): string | null {
  let nodes = 0;
  let maxDepth = 0;
  const stack: Array<{ node: unknown; depth: number }> = [
    { node: value, depth: 1 },
  ];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (node === null || typeof node !== 'object') continue;
    nodes++;
    if (nodes > MAX_DOCUMENT_NODES) {
      return `the document has more than ${MAX_DOCUMENT_NODES} nodes`;
    }
    if (depth > maxDepth) maxDepth = depth;
    if (maxDepth > MAX_DOCUMENT_DEPTH) {
      return `the document is nested deeper than ${MAX_DOCUMENT_DEPTH} levels`;
    }
    const children = Array.isArray(node)
      ? node
      : Object.values(node as Record<string, unknown>);
    for (const child of children) {
      if (child !== null && typeof child === 'object') {
        stack.push({ node: child, depth: depth + 1 });
      }
    }
  }
  const bytes = Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
  if (bytes > MAX_DOCUMENT_BYTES) {
    return `the document is ${bytes} bytes serialised — the limit is ${MAX_DOCUMENT_BYTES}`;
  }
  return null;
}

/** For the spec and the admin: the three measurements of a document. */
export function measureDocument(value: unknown): DocumentMeasure {
  let nodes = 0;
  let depth = 0;
  const walk = (node: unknown, level: number) => {
    if (node === null || typeof node !== 'object') return;
    nodes++;
    if (level > depth) depth = level;
    const children = Array.isArray(node)
      ? node
      : Object.values(node as Record<string, unknown>);
    for (const child of children) walk(child, level + 1);
  };
  walk(value, 1);
  return {
    bytes: Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8'),
    nodes,
    depth,
  };
}

/**
 * class-validator decorator: the property, when present, must be a
 * document within MAX_DOCUMENT_BYTES / NODES / DEPTH. Pairs with
 * @IsObject() — a non-object is that decorator's failure, not this one's.
 */
export function IsBoundedDocument(options?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      name: 'isBoundedDocument',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown) {
          if (value === null || typeof value !== 'object') return true;
          return documentLimitViolation(value) === null;
        },
        defaultMessage(args: ValidationArguments) {
          const reason = documentLimitViolation(args.value) ?? 'too large';
          return `${args.property} is too large: ${reason}`;
        },
      },
    });
  };
}
