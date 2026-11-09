import {
  AccessType,
  BookType,
  ChapterStatus,
  CommentStatus,
  FeedbackStatus,
  HomePromoArtPreset,
  HomePromoCtaTarget,
  HomePromoKind,
  LotteryClaimRejectReason,
  LotteryClaimStatus,
  LotteryDrawStatus,
  LotteryDreamBook,
  MovieStatus,
  Prisma,
  Role,
  SeriesStatus,
  UserStatus,
} from '../generated/prisma/client';
import {
  actorSnapshot,
  bookChapterSnapshot,
  bookSectionSnapshot,
  bookSnapshot,
  commentSnapshot,
  depositSnapshot,
  feedbackSnapshot,
  homePromoSnapshot,
  homeSettingsSnapshot,
  levelSnapshot,
  lotteryClaimSnapshot,
  lotteryDrawSnapshot,
  lotteryDreamSnapshot,
  lotteryResultSnapshot,
  lotterySettingsSnapshot,
  movieSnapshot,
  paymentAccountSnapshot,
  roleSnapshot,
  seriesSnapshot,
  textPreview,
  userSnapshot,
} from './audit-snapshots';

describe('audit snapshot pickers', () => {
  it('movieSnapshot whitelists the catalog fields and relation names', () => {
    expect(
      movieSnapshot({
        id: 'm1',
        title: 'Alpha',
        description: 'd',
        genre: 'Action',
        language: 'en',
        releaseYear: 2020,
        duration: 90,
        rating: 4.5,
        director: null,
        country: 'MM',
        ageRating: null,
        accessType: AccessType.FREE,
        status: MovieStatus.DRAFT,
        seriesId: null,
        seasonNumber: null,
        episodeNumber: null,
        posterUrl: 'p',
        coverUrl: null,
        thumbnailUrl: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        categories: [{ id: 'c1', name: 'Action', description: null }],
        actors: [{ id: 'a1', name: 'Someone', imageUrl: null }],
      }),
    ).toEqual({
      title: 'Alpha',
      description: 'd',
      descriptionMm: null,
      genre: 'Action',
      language: 'en',
      releaseYear: 2020,
      duration: 90,
      rating: 4.5,
      director: null,
      country: 'MM',
      ageRating: null,
      accessType: 'FREE',
      status: 'DRAFT',
      seriesId: null,
      seasonNumber: null,
      episodeNumber: null,
      posterUrl: 'p',
      coverUrl: null,
      thumbnailUrl: null,
      tmdbId: null,
      categories: [{ id: 'c1', name: 'Action' }],
      actors: [{ id: 'a1', name: 'Someone' }],
    });
  });

  it('movieSnapshot carries the Burmese description and the TMDB link, and none of the other TMDB bookkeeping', () => {
    const snapshot = movieSnapshot({
      title: 'Inception',
      description: 'A thief who steals secrets.',
      descriptionMm: 'အိပ်မက်ထဲက သူခိုး',
      sourceName: 'Inception.2010.1080p.BluRay.x264-YIFY',
      tmdbId: 27205,
      tmdbStatus: 'MATCHED',
      tmdbError: null,
      tmdbFetchedAt: new Date('2026-11-06T00:00:00.000Z'),
      tmdbAuto: { v: 1, title: 'Inception', releaseYear: 2010 },
    });

    // Without descriptionMm a Burmese-only edit would diff as nothing and
    // leave no audit row at all.
    expect(snapshot).toMatchObject({
      descriptionMm: 'အိပ်မက်ထဲက သူခိုး',
      tmdbId: 27205,
    });
    for (const key of [
      'sourceName',
      'tmdbStatus',
      'tmdbError',
      'tmdbFetchedAt',
      'tmdbAuto',
    ]) {
      expect(snapshot).not.toHaveProperty(key);
    }
  });

  it('tolerates a partial row: missing fields become null, missing relations []', () => {
    expect(movieSnapshot({ title: 'Only title' })).toMatchObject({
      title: 'Only title',
      description: null,
      categories: [],
      actors: [],
    });
  });

  it('seriesSnapshot carries the show-level cast as name refs, like movieSnapshot', () => {
    expect(
      seriesSnapshot({
        title: 'A Show',
        status: SeriesStatus.DRAFT,
        categories: [{ id: 'c1', name: 'Action', description: null }],
        actors: [{ id: 'a1', name: 'Jackie Chan', imageUrl: 'x' }],
      }),
    ).toMatchObject({
      title: 'A Show',
      status: 'DRAFT',
      categories: [{ id: 'c1', name: 'Action' }],
      actors: [{ id: 'a1', name: 'Jackie Chan' }],
    });
    // A row loaded without the relation diffs as an empty cast, not a crash.
    expect(seriesSnapshot({ title: 'Bare' })).toMatchObject({ actors: [] });
  });

  it('seriesSnapshot carries the admin-set rating, like movieSnapshot', () => {
    expect(seriesSnapshot({ title: 'Rated', rating: 7.5 })).toMatchObject({
      rating: 7.5,
    });
    expect(seriesSnapshot({ title: 'Bare' })).toMatchObject({ rating: null });
  });

  it('seriesSnapshot carries the Burmese description and the TMDB link, and none of the other TMDB bookkeeping', () => {
    const snapshot = seriesSnapshot({
      title: 'Stranger Things',
      descriptionMm: 'ထူးဆန်းသော အရာများ',
      tmdbId: 66732,
      tmdbFetchedAt: new Date('2026-11-06T00:00:00.000Z'),
      tmdbAuto: { v: 1, title: 'Stranger Things' },
    });

    expect(snapshot).toMatchObject({
      descriptionMm: 'ထူးဆန်းသော အရာများ',
      tmdbId: 66732,
    });
    expect(snapshot).not.toHaveProperty('tmdbFetchedAt');
    expect(snapshot).not.toHaveProperty('tmdbAuto');
    expect(seriesSnapshot({ title: 'Bare' })).toMatchObject({
      descriptionMm: null,
      tmdbId: null,
    });
  });

  it('actorSnapshot carries the TMDB person an actor is tied to', () => {
    expect(
      actorSnapshot({
        id: 'a1',
        name: 'Leonardo DiCaprio',
        imageUrl: 'p',
        tmdbPersonId: 6193,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).toEqual({
      name: 'Leonardo DiCaprio',
      imageUrl: 'p',
      tmdbPersonId: 6193,
    });
    // An actor typed by hand has none; the key is still there so a later
    // link shows up as a change.
    expect(actorSnapshot({ name: 'By Hand', imageUrl: null })).toEqual({
      name: 'By Hand',
      imageUrl: null,
      tmdbPersonId: null,
    });
  });

  it('bookSnapshot / bookChapterSnapshot never carry the TipTap document', () => {
    expect(
      bookSnapshot({
        title: 'B',
        author: 'A',
        authorId: 'au1',
        description: 'x',
        coverUrl: null,
        type: BookType.EDITOR,
        categories: [{ id: 'bc1', name: 'Manga', description: null }],
      }),
    ).toEqual({
      title: 'B',
      author: 'A',
      authorId: 'au1',
      description: 'x',
      coverUrl: null,
      type: 'EDITOR',
      categories: [{ id: 'bc1', name: 'Manga' }],
    });

    const chapter = bookChapterSnapshot({
      editionId: 'e1',
      partId: null,
      title: 'Ch 1',
      imageUrl: null,
      order: 1,
      status: ChapterStatus.READY,
      content: { type: 'doc', content: [{ type: 'paragraph' }] },
      pdfKey: null,
      pdfFileSize: BigInt(1024),
      pageCount: 0,
      processedPages: 0,
      processingError: null,
    });
    expect(chapter.content).toEqual({
      length: JSON.stringify({
        type: 'doc',
        content: [{ type: 'paragraph' }],
      }).length,
    });
    expect(chapter.pdfFileSize).toBe(1024);
    expect(JSON.stringify(chapter)).not.toContain('paragraph');

    expect(
      bookSectionSnapshot({ title: 'S', content: null }).content,
    ).toBeNull();
  });

  it('userSnapshot never includes password or googleId', () => {
    const snapshot = userSnapshot({
      id: 'u1',
      username: 'boss',
      password: 'hashed',
      googleId: 'g-123',
      phone: null,
      email: 'boss@example.com',
      displayName: 'Boss',
      role: Role.ADMIN,
      appRoleId: 'r1',
      status: UserStatus.ACTIVE,
      appRole: { name: 'Admin' },
    });
    expect(snapshot).toEqual({
      username: 'boss',
      displayName: 'Boss',
      phone: null,
      email: 'boss@example.com',
      role: 'ADMIN',
      appRoleId: 'r1',
      appRoleName: 'Admin',
      status: 'ACTIVE',
    });
    expect(snapshot).not.toHaveProperty('password');
    expect(snapshot).not.toHaveProperty('googleId');
  });

  it('roleSnapshot sorts permissions and accepts rows or strings', () => {
    expect(
      roleSnapshot({
        key: 'X',
        name: 'X',
        description: null,
        permissions: [
          { permission: 'MOVIES.VIEW' },
          { permission: 'ACTORS.VIEW' },
        ],
      }).permissions,
    ).toEqual(['ACTORS.VIEW', 'MOVIES.VIEW']);
    expect(roleSnapshot({ permissions: ['B.X', 'A.Y'] }).permissions).toEqual([
      'A.Y',
      'B.X',
    ]);
  });

  it('money fields become numbers, null stays null', () => {
    expect(
      depositSnapshot({
        amount: new Prisma.Decimal('5000.00'),
        walletBalanceBefore: null,
        walletBalanceAfter: new Prisma.Decimal('7000'),
      }),
    ).toMatchObject({
      amount: 5000,
      walletBalanceBefore: null,
      walletBalanceAfter: 7000,
    });
    expect(
      paymentAccountSnapshot({ balance: new Prisma.Decimal('1.25') }).balance,
    ).toBe(1.25);
    expect(
      levelSnapshot({ threshold: new Prisma.Decimal('100') }).threshold,
    ).toBe(100);
  });

  it('commentSnapshot keeps a 200-char preview of the body only', () => {
    const body = 'word '.repeat(100);
    const snapshot = commentSnapshot({
      status: CommentStatus.VISIBLE,
      body,
      userId: 'u1',
      movieId: 'm1',
      seriesId: null,
      bookId: null,
      parentId: null,
    });
    expect((snapshot.body as string).length).toBe(201);
    expect(snapshot.body).toMatch(/…$/);
    expect(snapshot).not.toHaveProperty('ipAddress');
  });

  it('feedbackSnapshot reports status, adminNote and who handled it', () => {
    expect(
      feedbackSnapshot({
        status: FeedbackStatus.RESOLVED,
        adminNote: 'done',
        handledByUserId: 'staff-1',
        handledAt: null,
        handledBy: { id: 'staff-1', username: 'boss' },
      }),
    ).toMatchObject({
      status: 'RESOLVED',
      adminNote: 'done',
      handledBy: { id: 'staff-1', name: 'boss' },
    });
    expect(
      feedbackSnapshot({ status: FeedbackStatus.NEW, handledByUserId: null })
        .handledBy,
    ).toBeNull();
  });

  it('homePromoSnapshot keeps the editable fields and drops bookkeeping', () => {
    const snapshot = homePromoSnapshot({
      id: 'p1',
      kind: HomePromoKind.HERO,
      titleEn: 'Go Premium',
      titleMm: 'Premium ယူပါ',
      ctaTarget: HomePromoCtaTarget.SUBSCRIBE,
      artPreset: HomePromoArtPreset.PREMIUM,
      isActive: true,
      sortOrder: 2,
      createdById: 'staff-1',
      createdAt: new Date('2026-10-08T00:00:00Z'),
    });
    expect(snapshot).toMatchObject({
      kind: 'HERO',
      titleEn: 'Go Premium',
      titleMm: 'Premium ယူပါ',
      ctaTarget: 'SUBSCRIBE',
      artPreset: 'PREMIUM',
      isActive: true,
      sortOrder: 2,
      url: null,
      targetId: null,
    });
    expect(snapshot).not.toHaveProperty('id');
    expect(snapshot).not.toHaveProperty('createdById');
    expect(snapshot).not.toHaveProperty('createdAt');
  });

  it('homeSettingsSnapshot reports the five settings only', () => {
    expect(
      homeSettingsSnapshot({
        id: 's1',
        webUrl: 'https://myanflix.example',
        gamesTeaserEnabled: false,
        updatedByUserId: 'staff-1',
      }),
    ).toEqual({
      webUrl: 'https://myanflix.example',
      appStoreUrl: null,
      playStoreUrl: null,
      gamesTeaserEnabled: false,
      gamesTeaserDateText: null,
    });
  });

  it('lotteryDreamSnapshot keeps the address and the editable fields only', () => {
    expect(
      lotteryDreamSnapshot({
        id: 'd1',
        book: LotteryDreamBook.DREAM_1000,
        number: '027',
        nameEn: 'Snake',
        isActive: true,
        createdAt: new Date('2026-10-19T00:00:00Z'),
      }),
    ).toEqual({
      book: 'DREAM_1000',
      number: '027',
      nameEn: 'Snake',
      nameMy: null,
      pictureUrl: null,
      isActive: true,
    });
  });

  it('lotteryDrawSnapshot keeps the setup and the life stamps, never the counters', () => {
    expect(
      lotteryDrawSnapshot({
        id: 'draw-1',
        drawNo: 24,
        thaiDrawDate: new Date('2026-11-01T00:00:00Z'),
        drawAt: new Date('2026-11-01T07:30:00Z'),
        salesCloseAt: new Date('2026-11-01T06:30:00Z'),
        status: LotteryDrawStatus.OPEN,
        ticketPrice: new Prisma.Decimal(1000),
        maxPerNumber: 20,
        exchangeRate: null,
        nextTicketSeq: 469,
        createdByUserId: 'admin-1',
        openedAt: new Date('2026-10-20T00:00:00Z'),
      }),
    ).toEqual({
      drawNo: 24,
      thaiDrawDate: new Date('2026-11-01T00:00:00Z'),
      drawAt: new Date('2026-11-01T07:30:00Z'),
      salesCloseAt: new Date('2026-11-01T06:30:00Z'),
      status: 'OPEN',
      ticketPrice: 1000,
      maxPerNumber: 20,
      exchangeRate: null,
      pictureUrl: null,
      frameUrl: null,
      openedAt: new Date('2026-10-20T00:00:00Z'),
      closedAt: null,
      publishedAt: null,
      winnersCount: null,
      prizesPaidKs: null,
    });
    // Publish figures come out as numbers (phase 3).
    expect(
      lotteryDrawSnapshot({
        winnersCount: 12,
        prizesPaidKs: new Prisma.Decimal('1234000.5'),
      }),
    ).toEqual(
      expect.objectContaining({ winnersCount: 12, prizesPaidKs: 1234000.5 }),
    );
  });

  it('lotteryResultSnapshot keeps the status, the source and the sheet as key / baht / numbers, never the raw answer', () => {
    expect(
      lotteryResultSnapshot({
        id: 'result-1',
        drawId: 'draw-1',
        status: 'FETCHED',
        source: 'API',
        sourceDate: '2026-11-01',
        fetchedAt: new Date('2026-11-01T07:40:00Z'),
        attempts: 3,
        lastError: null,
        raw: { status: 'success', response: { date: 'x' } },
        groups: [
          {
            key: 'first',
            name: 'First prize',
            baht: 6000000,
            count: 1,
            digits: 6,
            numbers: ['123456'],
          },
          { key: 'back2', baht: 2000, numbers: ['56', 7] },
          'junk',
          { noKey: true },
        ],
      }),
    ).toEqual({
      status: 'FETCHED',
      source: 'API',
      sourceDate: '2026-11-01',
      fetchedAt: new Date('2026-11-01T07:40:00Z'),
      attempts: 3,
      lastError: null,
      groups: [
        { key: 'first', baht: 6000000, numbers: ['123456'] },
        { key: 'back2', baht: 2000, numbers: ['56'] },
      ],
    });
    // A row never touched: every field null, the sheet null rather than [].
    expect(lotteryResultSnapshot({})).toEqual({
      status: null,
      source: null,
      sourceDate: null,
      fetchedAt: null,
      attempts: null,
      lastError: null,
      groups: null,
    });
  });

  it('lotterySettingsSnapshot keeps the four values as numbers and the ticket frame', () => {
    expect(
      lotterySettingsSnapshot({
        id: 'settings-1',
        ticketPrice: new Prisma.Decimal(1000),
        maxPerNumber: 20,
        exchangeRate: new Prisma.Decimal('75.5'),
        salesCloseMinutesBefore: 60,
        frameUrl: 'http://s3/movies/images/lottery_frame/f.png',
        updatedByUserId: 'admin-1',
      }),
    ).toEqual({
      ticketPrice: 1000,
      maxPerNumber: 20,
      exchangeRate: 75.5,
      salesCloseMinutesBefore: 60,
      frameUrl: 'http://s3/movies/images/lottery_frame/f.png',
      resultsUrl: null,
      claimDeadlineDays: null,
    });
  });

  it('lotteryClaimSnapshot keeps the status, the figures as numbers, the times and the rejection — never the customer', () => {
    expect(
      lotteryClaimSnapshot({
        id: 'claim-1',
        drawId: 'draw-1',
        userId: 'user-1',
        status: LotteryClaimStatus.REJECTED,
        ticketsCount: 3,
        baht: new Prisma.Decimal('6000.00'),
        ks: new Prisma.Decimal('450000.00'),
        rate: new Prisma.Decimal('75.0000'),
        requestedAt: new Date('2026-10-24T03:42:00Z'),
        decidedAt: new Date('2026-10-24T09:10:00Z'),
        decidedByUserId: 'admin-1',
        rejectReason: LotteryClaimRejectReason.OTHER,
        rejectNote: 'Ticket photo does not match',
        transactionId: null,
        paidAtPublish: false,
      }),
    ).toEqual({
      status: 'REJECTED',
      ticketsCount: 3,
      baht: 6000,
      ks: 450000,
      rate: 75,
      requestedAt: new Date('2026-10-24T03:42:00Z'),
      decidedAt: new Date('2026-10-24T09:10:00Z'),
      decidedByUserId: 'admin-1',
      rejectReason: 'OTHER',
      rejectNote: 'Ticket photo does not match',
      transactionId: null,
      paidAtPublish: false,
    });
  });

  it('textPreview collapses whitespace and trims to the limit', () => {
    expect(textPreview('  a \n b  ')).toBe('a b');
    expect(textPreview('abcdef', 3)).toBe('abc…');
    expect(textPreview(null)).toBeNull();
  });
});
