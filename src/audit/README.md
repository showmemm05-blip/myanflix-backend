# Staff audit log — `AuditService.record()` contract

`AuditService` is global: inject it anywhere (`private readonly audit: AuditService`)
without importing `AuditModule`. It has one write method.

```ts
await this.audit.record({
  action, // AuditAction key from audit-actions.ts (typed union — typos fail to compile)
  actor, // AuthenticatedUser from @CurrentUser(), or null for a system event
  target: { type, id?, label? }, // type = AuditTargetType; label = human name at the time
  before?, // snapshot BEFORE the write (update / delete)
  after?, // snapshot AFTER the write (create / update)
  metadata?, // free-form extras: reason, counts, related ids, trigger
  tx?, // Prisma.TransactionClient — pass it inside $transaction(async (tx) => …)
  force?, // record even if actor.role === USER (rare; moderator-vs-owner decided by you)
});
```

## What `record()` does for you

- **Drops end-user self-service.** If `actor.role === Role.USER` and `force` is not set,
  it returns without writing. You never need to check the role yourself.
- **Files the row under the right category** — looked up from the catalogue by `action`.
- **Snapshots the actor** (username, role, appRoleId from the JWT; displayName and
  appRole name from one cached DB lookup, 60 s per actor). `actor: null` stores
  `actorUsername: 'system'`, `actorDisplayName: 'System'`, `actorRole: null`.
- **Captures ip / userAgent / platform** from the current request; null / `UNKNOWN`
  outside a request (cron, transcode callback).
- **Computes `changes`** = `diffSnapshots(before, after)` — only when BOTH are given.
  create → `after` only, `changes` null. delete → `before` only, `changes` null.
  Relation lists (`[{ id, name }]`) compare as sets by id and are reported as name lists.
- **Skips no-op saves**: an action ending in `.update` whose diff is empty writes nothing.
  Status actions (`.publish`, `.status_change`, …) are always written.
- **Sanitises everything** (`before`, `after`, `changes`, `metadata`): keys matching
  `/password|secret|token|otp|hash|refresh/i` become `'[redacted]'`, Decimal → number,
  Date → ISO, BigInt → number, strings > 2000 chars → `{ _truncated, length, preview }`,
  nesting deeper than 4 levels → capped JSON string.
- **Never throws outside a transaction** — a failed write is logged at error level and
  swallowed, so the business action still succeeds. **Inside `tx` errors propagate**, so
  the whole transaction rolls back together with its audit row (finance/roles want this).

Always call `record()` AFTER the write succeeded when you are outside a transaction.

## Snapshots

Use the pickers in `audit-snapshots.ts` — they are the whitelist of what may be stored
per entity (`movieSnapshot`, `seriesSnapshot`, `bookChapterSnapshot`, `userSnapshot`,
`roleSnapshot`, `depositSnapshot`, … one per target type). They accept a partial Prisma
row plus whichever relations the snapshot wants (`categories`, `actors`, `appRole`, …),
so pass whatever select/include you already have. Never build a snapshot from the raw
request body.

## Example 1 — update with before/after

Outside a transaction (most content services):

```ts
async update(id: string, dto: UpdateMovieDto, actor: AuthenticatedUser) {
  const before = await this.prisma.movie.findUnique({
    where: { id },
    include: { categories: true, actors: true },
  });
  if (!before) throw new NotFoundException('Movie not found');

  const after = await this.prisma.movie.update({
    where: { id },
    data: toUpdateData(dto),
    include: { categories: true, actors: true },
  });

  // Status-derived action: → PUBLISHED = publish, PUBLISHED → other = unpublish,
  // other → other = status_change, otherwise plain update (skipped when the diff is empty).
  await this.audit.record({
    action: statusDerivedAuditAction('movie', before.status, after.status) // from src/movies/movies.service.ts,
    actor,
    target: { type: 'movie', id, label: after.title },
    before: movieSnapshot(before),
    after: movieSnapshot(after),
    metadata: after.seriesId ? { seriesId: after.seriesId } : null,
  });
  return after;
}
```

Inside a transaction (finance, roles) — pass `tx` so the row commits with the action:

```ts
return this.prisma.$transaction(async (tx) => {
  const before = await tx.deposit.findUnique({ where: { id }, include: { user: true } });
  // … validate, credit the wallet, create the Transaction …
  const after = await tx.deposit.update({ where: { id }, data: { status: 'APPROVED', … } });

  await this.audit.record({
    action: 'deposit.approve',
    actor,
    target: { type: 'deposit', id, label: `${after.reference} · @${before.user.username}` },
    before: depositSnapshot(before),
    after: depositSnapshot(after),
    tx, // errors propagate → the whole approval rolls back
  });
  return after;
});
```

## Example 2 — create, delete and bulk

```ts
// create: after only
const category = await this.prisma.category.create({ data: dto });
await this.audit.record({
  action: 'category.create',
  actor,
  target: { type: 'category', id: category.id, label: category.name },
  after: categorySnapshot(category),
});

// delete: before only + what cascaded
await this.audit.record({
  action: 'series.delete',
  actor,
  target: { type: 'series', id, label: series.title },
  before: seriesSnapshot(series),
  metadata: {
    deletedEpisodes: episodeIds.length,
    subtitles: subtitleCount,
    videos: videoCount,
  },
});

// bulk / reorder: ONE row, no before/after, metadata summarises request + result
await this.audit.record({
  action: 'book_chapter.reorder',
  actor,
  target: { type: 'book_chapter', id: null, label: edition.book.title },
  metadata: { editionId, before: oldOrderIds, after: newOrderIds },
});

// system event (no request): actor null
await this.audit.record({
  action: 'movie.publish',
  actor: null,
  target: { type: 'movie', id: movie.id, label: movie.title },
  before: { status: 'PROCESSING' },
  after: { status: 'PUBLISHED' },
  metadata: { trigger: 'transcode_complete', videoId },
});
```

## Unit specs

When a service gains an `actor` parameter and starts calling `record()`, add to its
TestingModule:

```ts
{ provide: AuditService, useValue: { record: jest.fn().mockResolvedValue(undefined) } }
```

## Read API

`GET /audit`, `GET /audit/catalogue`, `GET /audit/:id` — all behind `AUDIT.VIEW`, which
only the protected SUPER_ADMIN role holds. Holding it means seeing staff IPs and user
agents un-masked.
