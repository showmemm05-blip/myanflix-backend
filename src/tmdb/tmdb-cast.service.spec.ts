import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { MinioService } from '../common/storage/minio.service';
import { Prisma, Role } from '../generated/prisma/client';
import { ImageStoreService } from '../images/image-store.service';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionResolverService } from '../roles/permission-resolver.service';
import {
  TmdbCastService,
  planCast,
  type KnownActor,
} from './tmdb-cast.service';
import { TmdbImageFetcher } from './tmdb-image.fetcher';
import type { TmdbCastPerson } from './tmdb-mapping';

const STAFF = {
  id: 'staff-1',
  username: 'uploader',
  role: Role.CONTENT_UPLOADER,
  appRoleId: null,
} as unknown as AuthenticatedUser;

const person = (
  tmdbPersonId: number,
  name: string,
  profilePath: string | null = `/p${tmdbPersonId}.jpg`,
): TmdbCastPerson => ({ tmdbPersonId, name, profilePath });

const actor = (
  id: string,
  name: string,
  overrides: Partial<KnownActor> = {},
): KnownActor => ({
  id,
  name,
  tmdbPersonId: null,
  imageUrl: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  ...overrides,
});

/** What Prisma throws when a unique column (actors.name, actors.tmdbPersonId) is already taken. */
const uniqueViolation = (target: string) =>
  new Prisma.PrismaClientKnownRequestError(
    `Unique constraint failed on the fields: (\`${target}\`)`,
    { code: 'P2002', clientVersion: 'test', meta: { target: [target] } },
  );

const storedUrl = (name: string) =>
  `http://cache.local/movies/images/actor/${name}`;

describe('planCast — who each person of a TMDB cast is among our actors', () => {
  it('1. an actor already carrying the TMDB person id is used, whatever their name', () => {
    const leo = actor('a-1', 'Leo D.', { tmdbPersonId: 6193 });

    expect(planCast([person(6193, 'Leonardo DiCaprio')], [leo], true)).toEqual([
      {
        person: person(6193, 'Leonardo DiCaprio'),
        action: 'reuse',
        actor: leo,
        link: false,
      },
    ]);
  });

  it.each([
    ['Chloë Grace Moretz', 'Chloe Grace Moretz'],
    ['Lee Byung-hun', 'Lee Byung Hun'],
    ['TOM HANKS', 'Tom Hanks'],
  ])(
    '2. %p is the actor we have as %p: used, and to be given the person id',
    (tmdbName, ourName) => {
      const [entry] = planCast(
        [person(77, tmdbName)],
        [actor('a-1', ourName)],
        true,
      );

      expect(entry.action).toBe('reuse');
      expect(entry.link).toBe(true);
      expect(entry.actor?.id).toBe('a-1');
    },
  );

  it('2. a Burmese name is not the actor we have under another name with the same consonants', () => {
    // Kyaw Kyaw is ours; TMDB lists Ko Ko. Only the vowel signs differ.
    const kyawKyaw = actor('a-1', 'ကျော်ကျော်');

    const [other, same] = planCast(
      [person(77, 'ကိုကို'), person(78, 'ကျော် ကျော်')],
      [kyawKyaw],
      true,
    );

    // Another person: created, never given Kyaw Kyaw's row or person id.
    expect(other).toEqual({
      person: person(77, 'ကိုကို'),
      action: 'create',
      actor: null,
      link: false,
    });
    // The same name, spaced differently, is still him.
    expect(same).toEqual(
      expect.objectContaining({ action: 'reuse', link: true }),
    );
    expect(same.actor?.id).toBe('a-1');
  });

  it('2. a Burmese name typed with its marks in another order is the actor we have', () => {
    // Ko Ko typed by hand with u before i in each syllable; TMDB lists the
    // same name with i before u. The two look alike on screen.
    const syllable = (...marks: number[]) =>
      String.fromCharCode(0x1000, ...marks);
    const ours = syllable(0x102f, 0x102d).repeat(2);
    const theirs = syllable(0x102d, 0x102f).repeat(2);
    expect(ours).not.toBe(theirs);

    const [entry] = planCast([person(77, theirs)], [actor('a-1', ours)], true);

    // Reused and given the person id: never a second, look-alike actor.
    expect(entry).toEqual(
      expect.objectContaining({ action: 'reuse', link: true }),
    );
    expect(entry.actor?.id).toBe('a-1');
  });

  it('2. among several actors of that name, the oldest one without a person id is taken', () => {
    const [entry] = planCast(
      [person(77, 'Lee Byung-hun')],
      [
        actor('a-new', 'Lee Byung Hun', {
          createdAt: new Date('2026-06-01T00:00:00Z'),
        }),
        actor('a-linked', 'Lee Byunghun', {
          tmdbPersonId: 999,
          createdAt: new Date('2020-01-01T00:00:00Z'),
        }),
        actor('a-old', 'Lee Byung-hun', {
          createdAt: new Date('2024-01-01T00:00:00Z'),
        }),
      ],
      true,
    );

    expect(entry).toEqual(
      expect.objectContaining({ action: 'reuse', link: true }),
    );
    expect(entry.actor?.id).toBe('a-old');
  });

  it('2. the same name already belonging to ANOTHER TMDB person is a namesake: skipped', () => {
    expect(
      planCast(
        [person(77, 'Michael Jordan')],
        [actor('a-1', 'Michael Jordan', { tmdbPersonId: 12 })],
        true,
      ),
    ).toEqual([
      {
        person: person(77, 'Michael Jordan'),
        action: 'skip_same_name',
        actor: null,
        link: false,
      },
    ]);
  });

  it('3. someone we do not have is created — when the staff member may create actors', () => {
    const [may] = planCast([person(77, 'New Face')], [], true);
    const [mayNot] = planCast([person(77, 'New Face')], [], false);

    expect(may).toEqual(
      expect.objectContaining({ action: 'create', actor: null }),
    );
    expect(mayNot).toEqual(
      expect.objectContaining({ action: 'skip_no_permission', actor: null }),
    );
  });

  it('without ACTORS.CREATE existing actors are still reused', () => {
    const plan = planCast(
      [person(1, 'Known By Id'), person(2, 'Known By Name'), person(3, 'New')],
      [
        actor('a-1', 'Somebody', { tmdbPersonId: 1 }),
        actor('a-2', 'known by name'),
      ],
      false,
    );

    expect(plan.map((entry) => entry.action)).toEqual([
      'reuse',
      'reuse',
      'skip_no_permission',
    ]);
  });

  it('a decision made for one person counts for the next of the same cast', () => {
    // Two different TMDB people with one name: the first takes our actor,
    // the second is then a namesake.
    const taken = planCast(
      [person(1, 'Chris Evans'), person(2, 'Chris Evans')],
      [actor('a-1', 'Chris Evans')],
      true,
    );
    expect(taken.map((entry) => entry.action)).toEqual([
      'reuse',
      'skip_same_name',
    ]);

    // Nobody of that name yet: the first is created, the second is a
    // namesake of the one about to exist.
    const created = planCast(
      [person(1, 'Chris Evans'), person(2, 'Chris Evans')],
      [],
      true,
    );
    expect(created.map((entry) => entry.action)).toEqual([
      'create',
      'skip_same_name',
    ]);
  });

  it('the same person listed twice is one creation, never a row with no id', () => {
    const plan = planCast([person(1, 'Twice'), person(1, 'Twice')], [], true);

    expect(plan.map((entry) => entry.action)).toEqual(['create', 'create']);
    expect(plan.every((entry) => entry.actor === null)).toBe(true);
  });

  it('a name with no letter or digit in it is never matched by name', () => {
    const [entry] = planCast([person(5, '???')], [actor('a-1', '!!!')], true);

    expect(entry.action).toBe('create');
  });

  it('does not change the actors it was given', () => {
    const ours = [actor('a-1', 'Tom Hanks')];

    planCast([person(31, 'Tom Hanks')], ours, true);

    expect(ours[0].tmdbPersonId).toBeNull();
  });
});

describe('TmdbCastService', () => {
  let service: TmdbCastService;
  let prisma: {
    actor: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      create: jest.Mock;
      updateMany: jest.Mock;
    };
  };
  let resolver: { can: jest.Mock };
  let images: { fetch: jest.Mock };
  let imageStore: { save: jest.Mock };
  let minioService: { keyFromPublicUrl: jest.Mock; deleteObject: jest.Mock };
  let audit: { record: jest.Mock };

  /** The catalogue's actors for this test. */
  const haveActors = (...actors: KnownActor[]) =>
    prisma.actor.findMany.mockResolvedValue(actors);

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    let created = 0;
    prisma = {
      actor: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(
          async ({ data }: { data: { name: string; tmdbPersonId: number } }) =>
            actor(`new-${++created}`, data.name, data),
        ),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    resolver = { can: jest.fn().mockResolvedValue(true) };
    images = {
      fetch: jest.fn().mockResolvedValue({
        ok: true,
        buffer: Buffer.from('jpeg-bytes'),
        size: 'h632',
      }),
    };
    let saved = 0;
    imageStore = {
      save: jest.fn(async () => storedUrl(`tmdb-photo-${++saved}.jpg`)),
    };
    minioService = {
      keyFromPublicUrl: jest.fn((url: string) =>
        url.includes('/movies/') ? url.split('/movies/')[1] : null,
      ),
      deleteObject: jest.fn().mockResolvedValue(undefined),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TmdbCastService,
        { provide: PrismaService, useValue: prisma },
        { provide: PermissionResolverService, useValue: resolver },
        { provide: TmdbImageFetcher, useValue: images },
        { provide: ImageStoreService, useValue: imageStore },
        { provide: MinioService, useValue: minioService },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();
    service = module.get(TmdbCastService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** The audit rows of one action, as { target id, metadata, before, after }. */
  const auditRows = (action: string) =>
    audit.record.mock.calls
      .map(([row]) => row as Record<string, any>)
      .filter((row) => row.action === action);

  it('reads every actor once per fill, with just the columns the rules need', async () => {
    await service.attach(
      [person(1, 'One'), person(2, 'Two'), person(3, 'Three')],
      STAFF,
    );

    expect(prisma.actor.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.actor.findMany).toHaveBeenCalledWith({
      select: {
        id: true,
        name: true,
        tmdbPersonId: true,
        imageUrl: true,
        createdAt: true,
      },
    });
    expect(resolver.can).toHaveBeenCalledWith(STAFF, 'ACTORS.CREATE');
  });

  it('an empty cast asks nothing and attaches nothing', async () => {
    await expect(service.attach([], STAFF)).resolves.toEqual({
      actorIds: [],
      reused: 0,
      created: 0,
      skipped: [],
    });
    await expect(service.plan([], STAFF)).resolves.toEqual([]);
    expect(prisma.actor.findMany).not.toHaveBeenCalled();
  });

  describe('match by person id', () => {
    it('uses the actor as it is: no write, and nothing for the audit log to keep', async () => {
      const leo = actor('a-leo', 'Leonardo DiCaprio', {
        tmdbPersonId: 6193,
        imageUrl: storedUrl('leo.jpg'),
      });
      haveActors(leo);

      const outcome = await service.attach(
        [person(6193, 'Leonardo Wilhelm DiCaprio')],
        STAFF,
      );

      expect(outcome).toEqual({
        actorIds: ['a-leo'],
        reused: 1,
        created: 0,
        skipped: [],
      });
      expect(prisma.actor.create).not.toHaveBeenCalled();
      expect(prisma.actor.updateMany).not.toHaveBeenCalled();
      expect(images.fetch).not.toHaveBeenCalled();
      // An update whose before and after are equal — AuditService drops it.
      expect(auditRows('actor.create')).toEqual([]);
      for (const row of auditRows('actor.update')) {
        expect(row.before).toEqual(row.after);
      }
    });

    it('never changes the name we have', async () => {
      haveActors(actor('a-leo', 'Leo', { tmdbPersonId: 6193 }));

      await service.attach([person(6193, 'Leonardo DiCaprio', null)], STAFF);

      expect(prisma.actor.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('match by name key', () => {
    it('gives the actor the TMDB person id — guarded on it still being empty — and audits it', async () => {
      haveActors(
        actor('a-chloe', 'Chloe Grace Moretz', {
          imageUrl: storedUrl('chloe.jpg'),
        }),
      );

      const outcome = await service.attach(
        [person(56734, 'Chloë Grace Moretz')],
        STAFF,
      );

      expect(outcome).toEqual({
        actorIds: ['a-chloe'],
        reused: 1,
        created: 0,
        skipped: [],
      });
      expect(prisma.actor.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.actor.updateMany).toHaveBeenCalledWith({
        where: { id: 'a-chloe', tmdbPersonId: null },
        data: { tmdbPersonId: 56734 },
      });
      expect(prisma.actor.create).not.toHaveBeenCalled();
      expect(auditRows('actor.update')).toEqual([
        {
          action: 'actor.update',
          actor: STAFF,
          target: { type: 'actor', id: 'a-chloe', label: 'Chloe Grace Moretz' },
          before: {
            name: 'Chloe Grace Moretz',
            imageUrl: storedUrl('chloe.jpg'),
            tmdbPersonId: null,
          },
          after: {
            name: 'Chloe Grace Moretz',
            imageUrl: storedUrl('chloe.jpg'),
            tmdbPersonId: 56734,
          },
          metadata: { via: 'tmdb', tmdbPersonId: 56734 },
        },
      ]);
    });

    it('someone else linked this person a moment ago: the row that now carries them is used', async () => {
      haveActors(actor('a-1', 'Tom Hanks'));
      prisma.actor.updateMany.mockRejectedValueOnce(
        uniqueViolation('tmdbPersonId'),
      );
      prisma.actor.findUnique.mockResolvedValueOnce(
        actor('a-other', 'Tom Hanks Jr', {
          tmdbPersonId: 31,
          imageUrl: storedUrl('x.jpg'),
        }),
      );

      const outcome = await service.attach([person(31, 'Tom Hanks')], STAFF);

      expect(outcome.actorIds).toEqual(['a-other']);
      expect(outcome.reused).toBe(1);
      expect(prisma.actor.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tmdbPersonId: 31 } }),
      );
    });

    it('the actor was given another person id meanwhile and nobody carries this one: skipped', async () => {
      haveActors(actor('a-1', 'Tom Hanks'));
      prisma.actor.updateMany.mockResolvedValueOnce({ count: 0 });

      const outcome = await service.attach([person(31, 'Tom Hanks')], STAFF);

      expect(outcome).toEqual({
        actorIds: [],
        reused: 0,
        created: 0,
        skipped: [{ name: 'Tom Hanks', reason: 'same_name' }],
      });
    });
  });

  describe('create', () => {
    it('creates the actor with the cleaned name and the person id, and audits it as actor.create', async () => {
      const outcome = await service.attach(
        [person(2037, 'Cillian Murphy', null)],
        STAFF,
      );

      expect(prisma.actor.create).toHaveBeenCalledWith({
        data: { name: 'Cillian Murphy', tmdbPersonId: 2037 },
        select: expect.objectContaining({ id: true, tmdbPersonId: true }),
      });
      expect(outcome).toEqual({
        actorIds: ['new-1'],
        reused: 0,
        created: 1,
        skipped: [],
      });
      expect(auditRows('actor.create')).toEqual([
        {
          action: 'actor.create',
          actor: STAFF,
          target: { type: 'actor', id: 'new-1', label: 'Cillian Murphy' },
          after: {
            name: 'Cillian Murphy',
            imageUrl: null,
            tmdbPersonId: 2037,
          },
          metadata: { via: 'tmdb', tmdbPersonId: 2037 },
        },
      ]);
    });

    it('a race on the PERSON id: someone just created them — that row is read and used', async () => {
      prisma.actor.create.mockRejectedValueOnce(
        uniqueViolation('tmdbPersonId'),
      );
      prisma.actor.findUnique.mockImplementation(
        async ({ where }: { where: Record<string, unknown> }) =>
          where.tmdbPersonId === 2037
            ? actor('a-raced', 'Cillian Murphy', {
                tmdbPersonId: 2037,
                imageUrl: storedUrl('cm.jpg'),
              })
            : null,
      );

      const outcome = await service.attach(
        [person(2037, 'Cillian Murphy')],
        STAFF,
      );

      expect(outcome).toEqual({
        actorIds: ['a-raced'],
        reused: 1,
        created: 0,
        skipped: [],
      });
      expect(prisma.actor.create).toHaveBeenCalledTimes(1);
      expect(auditRows('actor.create')).toEqual([]);
    });

    it('a race on the NAME: someone just typed that actor — that row is used and given the person id', async () => {
      prisma.actor.create.mockRejectedValueOnce(uniqueViolation('name'));
      prisma.actor.findUnique.mockImplementation(
        async ({ where }: { where: Record<string, unknown> }) =>
          where.name === 'Cillian Murphy'
            ? actor('a-typed', 'Cillian Murphy')
            : null,
      );

      const outcome = await service.attach(
        [person(2037, 'Cillian Murphy', null)],
        STAFF,
      );

      expect(outcome).toEqual({
        actorIds: ['a-typed'],
        reused: 1,
        created: 0,
        skipped: [],
      });
      expect(prisma.actor.updateMany).toHaveBeenCalledWith({
        where: { id: 'a-typed', tmdbPersonId: null },
        data: { tmdbPersonId: 2037 },
      });
      expect(auditRows('actor.update')).toHaveLength(1);
    });

    it('a race on the name with a row that belongs to another TMDB person: a namesake, skipped', async () => {
      prisma.actor.create.mockRejectedValueOnce(uniqueViolation('name'));
      prisma.actor.findUnique.mockImplementation(
        async ({ where }: { where: Record<string, unknown> }) =>
          where.name === 'Cillian Murphy'
            ? actor('a-other', 'Cillian Murphy', { tmdbPersonId: 1 })
            : null,
      );

      const outcome = await service.attach(
        [person(2037, 'Cillian Murphy')],
        STAFF,
      );

      expect(outcome).toEqual({
        actorIds: [],
        reused: 0,
        created: 0,
        skipped: [{ name: 'Cillian Murphy', reason: 'same_name' }],
      });
      expect(prisma.actor.updateMany).not.toHaveBeenCalled();
    });

    it('any other database error is not swallowed', async () => {
      prisma.actor.create.mockRejectedValueOnce(new Error('connection lost'));

      await expect(
        service.attach([person(2037, 'Cillian Murphy')], STAFF),
      ).rejects.toThrow('connection lost');
    });
  });

  it('the same name with another person id is skipped and reported, never created', async () => {
    haveActors(actor('a-1', 'Michael Jordan', { tmdbPersonId: 12 }));

    const outcome = await service.attach([person(77, 'Michael Jordan')], STAFF);

    expect(outcome).toEqual({
      actorIds: [],
      reused: 0,
      created: 0,
      skipped: [{ name: 'Michael Jordan', reason: 'same_name' }],
    });
    expect(prisma.actor.create).not.toHaveBeenCalled();
    expect(prisma.actor.updateMany).not.toHaveBeenCalled();
  });

  it('without ACTORS.CREATE: existing actors are attached, missing ones reported, nothing created', async () => {
    resolver.can.mockResolvedValue(false);
    haveActors(
      actor('a-id', 'By Id', { tmdbPersonId: 1, imageUrl: storedUrl('1.jpg') }),
      actor('a-name', 'By Name', { imageUrl: storedUrl('2.jpg') }),
    );

    const outcome = await service.attach(
      [person(1, 'By Id'), person(3, 'Missing One'), person(2, 'by name')],
      STAFF,
    );

    expect(outcome).toEqual({
      actorIds: ['a-id', 'a-name'],
      reused: 2,
      created: 0,
      skipped: [{ name: 'Missing One', reason: 'no_permission' }],
    });
    expect(prisma.actor.create).not.toHaveBeenCalled();
  });

  it('returns the actors in TMDB billing order, each once', async () => {
    haveActors(
      actor('a-2', 'Second', { tmdbPersonId: 2, imageUrl: storedUrl('2.jpg') }),
      actor('a-1', 'First', { tmdbPersonId: 1, imageUrl: storedUrl('1.jpg') }),
    );

    const outcome = await service.attach(
      [person(1, 'First'), person(9, 'Brand New', null), person(2, 'Second')],
      STAFF,
    );

    expect(outcome.actorIds).toEqual(['a-1', 'new-1', 'a-2']);
  });

  describe('photos', () => {
    it('a new actor gets the TMDB photo, stored through the image store as a TMDB picture', async () => {
      await service.attach([person(2037, 'Cillian Murphy', '/cm.jpg')], STAFF);

      expect(images.fetch).toHaveBeenCalledWith(
        'profile',
        '/cm.jpg',
        10 * 1024 * 1024,
      );
      expect(imageStore.save).toHaveBeenCalledWith(
        'actor',
        'cm.jpg',
        Buffer.from('jpeg-bytes'),
        STAFF,
        { source: 'tmdb', sourceRef: '/cm.jpg' },
      );
      // Only while the actor still has none.
      expect(prisma.actor.updateMany).toHaveBeenCalledWith({
        where: { id: 'new-1', OR: [{ imageUrl: null }, { imageUrl: '' }] },
        data: { imageUrl: storedUrl('tmdb-photo-1.jpg') },
      });
      expect(auditRows('actor.create')[0].after).toEqual({
        name: 'Cillian Murphy',
        imageUrl: storedUrl('tmdb-photo-1.jpg'),
        tmdbPersonId: 2037,
      });
    });

    it('an existing actor with no photo gets one, audited as an update', async () => {
      haveActors(actor('a-1', 'Tom Hanks', { tmdbPersonId: 31 }));

      await service.attach([person(31, 'Tom Hanks', '/th.jpg')], STAFF);

      expect(imageStore.save).toHaveBeenCalledTimes(1);
      expect(auditRows('actor.update')).toEqual([
        expect.objectContaining({
          before: { name: 'Tom Hanks', imageUrl: null, tmdbPersonId: 31 },
          after: {
            name: 'Tom Hanks',
            imageUrl: storedUrl('tmdb-photo-1.jpg'),
            tmdbPersonId: 31,
          },
          metadata: { via: 'tmdb', tmdbPersonId: 31 },
        }),
      ]);
    });

    it('an existing photo is never replaced — nothing is even downloaded', async () => {
      haveActors(
        actor('a-1', 'Tom Hanks', {
          tmdbPersonId: 31,
          imageUrl: storedUrl('staff-upload.jpg'),
        }),
      );

      await service.attach([person(31, 'Tom Hanks', '/th.jpg')], STAFF);

      expect(images.fetch).not.toHaveBeenCalled();
      expect(imageStore.save).not.toHaveBeenCalled();
      expect(prisma.actor.updateMany).not.toHaveBeenCalled();
    });

    it('no photo on TMDB: none is fetched, the actor is created all the same', async () => {
      const outcome = await service.attach(
        [person(2037, 'Cillian Murphy', null)],
        STAFF,
      );

      expect(images.fetch).not.toHaveBeenCalled();
      expect(outcome.created).toBe(1);
    });

    it.each([
      [
        'cannot be fetched',
        () =>
          images.fetch.mockResolvedValue({ ok: false, reason: 'not_found' }),
      ],
      [
        'is not an image',
        () => imageStore.save.mockRejectedValue(new Error('unsupported type')),
      ],
      [
        'download throws',
        () => images.fetch.mockRejectedValue(new Error('boom')),
      ],
    ])(
      'a photo that %s is simply not there — the actor is attached',
      async (_label, arrange) => {
        arrange();

        const outcome = await service.attach(
          [person(2037, 'Cillian Murphy', '/cm.jpg')],
          STAFF,
        );

        expect(outcome).toEqual({
          actorIds: ['new-1'],
          reused: 0,
          created: 1,
          skipped: [],
        });
        expect(auditRows('actor.create')[0].after.imageUrl).toBeNull();
      },
    );

    it('staff added a photo while ours was being fetched: theirs stays and ours is deleted again', async () => {
      haveActors(actor('a-1', 'Tom Hanks', { tmdbPersonId: 31 }));
      prisma.actor.updateMany.mockResolvedValue({ count: 0 });

      await service.attach([person(31, 'Tom Hanks', '/th.jpg')], STAFF);

      expect(minioService.deleteObject).toHaveBeenCalledWith(
        'images/actor/tmdb-photo-1.jpg',
      );
      // Nothing changed on the row, so the update row carries no difference.
      for (const row of auditRows('actor.update')) {
        expect(row.before).toEqual(row.after);
      }
    });

    it('a stored photo that cannot be deleted again does not fail the fill', async () => {
      haveActors(actor('a-1', 'Tom Hanks', { tmdbPersonId: 31 }));
      prisma.actor.updateMany.mockResolvedValue({ count: 0 });
      minioService.deleteObject.mockRejectedValue(new Error('storage down'));

      await expect(
        service.attach([person(31, 'Tom Hanks', '/th.jpg')], STAFF),
      ).resolves.toEqual(expect.objectContaining({ actorIds: ['a-1'] }));
    });

    it('fetches the photos of a whole cast, a few at a time', async () => {
      let inFlight = 0;
      let most = 0;
      images.fetch.mockImplementation(async () => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        await new Promise((resolve) => setImmediate(resolve));
        inFlight -= 1;
        return { ok: true, buffer: Buffer.from('x'), size: 'h632' };
      });
      const cast = Array.from({ length: 10 }, (_, index) =>
        person(index + 1, `Actor ${index + 1}`),
      );

      const outcome = await service.attach(cast, STAFF);

      expect(outcome.created).toBe(10);
      expect(imageStore.save).toHaveBeenCalledTimes(10);
      expect(most).toBeLessThanOrEqual(4);
      expect(most).toBeGreaterThan(1);
    });
  });

  describe('plan — the review', () => {
    it('says what would happen to each person and writes nothing', async () => {
      haveActors(
        actor('a-id', 'By Id', { tmdbPersonId: 1 }),
        actor('a-name', 'By Name'),
        actor('a-namesake', 'Name Sake', { tmdbPersonId: 500 }),
      );

      const plan = await service.plan(
        [
          person(1, 'By Id'),
          person(2, 'By Name'),
          person(3, 'Name Sake'),
          person(4, 'Brand New'),
        ],
        STAFF,
      );

      expect(
        plan.map((entry) => [entry.action, entry.actor?.id ?? null]),
      ).toEqual([
        ['reuse', 'a-id'],
        ['reuse', 'a-name'],
        ['skip_same_name', null],
        ['create', null],
      ]);
      expect(prisma.actor.create).not.toHaveBeenCalled();
      expect(prisma.actor.updateMany).not.toHaveBeenCalled();
      expect(images.fetch).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('marks people it may not create', async () => {
      resolver.can.mockResolvedValue(false);

      const plan = await service.plan([person(4, 'Brand New')], STAFF);

      expect(plan[0].action).toBe('skip_no_permission');
    });
  });
});
