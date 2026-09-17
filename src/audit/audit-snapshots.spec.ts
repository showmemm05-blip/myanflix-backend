import {
  AccessType,
  BookType,
  ChapterStatus,
  CommentStatus,
  FeedbackStatus,
  MovieStatus,
  Prisma,
  Role,
  UserStatus,
} from '../generated/prisma/client';
import {
  bookChapterSnapshot,
  bookSectionSnapshot,
  bookSnapshot,
  commentSnapshot,
  depositSnapshot,
  feedbackSnapshot,
  levelSnapshot,
  movieSnapshot,
  paymentAccountSnapshot,
  roleSnapshot,
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
      categories: [{ id: 'c1', name: 'Action' }],
      actors: [{ id: 'a1', name: 'Someone' }],
    });
  });

  it('tolerates a partial row: missing fields become null, missing relations []', () => {
    expect(movieSnapshot({ title: 'Only title' })).toMatchObject({
      title: 'Only title',
      description: null,
      categories: [],
      actors: [],
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

  it('textPreview collapses whitespace and trims to the limit', () => {
    expect(textPreview('  a \n b  ')).toBe('a b');
    expect(textPreview('abcdef', 3)).toBe('abc…');
    expect(textPreview(null)).toBeNull();
  });
});
