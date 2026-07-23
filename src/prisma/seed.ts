/**
 * Populates every table with realistic demo data for local development.
 *
 * Run with: npm run db:seed
 * (compiles through `nest build` first — the generated Prisma client uses
 * nodenext-style ".js" relative imports that only resolve once compiled,
 * so this must run against dist/, not directly via ts-node.)
 */
import 'dotenv/config';
import * as bcrypt from 'bcrypt';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  PrismaClient,
  Prisma,
  Role,
  UserStatus,
  MovieStatus,
  VideoStatus,
  TransactionType,
} from '../generated/prisma/client';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const PASSWORD_SALT_ROUNDS = 10;
const DEFAULT_PASSWORD = 'Password123!';

async function resetData() {
  await prisma.watchHistory.deleteMany();
  await prisma.transaction.deleteMany();
  await prisma.purchase.deleteMany();
  await prisma.uploadSession.deleteMany();
  await prisma.video.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.wallet.deleteMany();
  // Clearing the movie<->category join table happens automatically when movies are deleted.
  await prisma.movie.deleteMany();
  await prisma.category.deleteMany();
  await prisma.user.deleteMany();
}

async function seedCategories() {
  const names = [
    'Action',
    'Drama',
    'Comedy',
    'Sci-Fi',
    'Thriller',
    'Romance',
    'Horror',
    'Documentary',
    'Animation',
    'Crime',
  ];

  const categories = await Promise.all(
    names.map((name) =>
      prisma.category.create({
        data: { name, description: `${name} movies and series` },
      }),
    ),
  );

  return new Map(categories.map((c) => [c.name, c]));
}

async function seedUsers() {
  const passwordHash = await bcrypt.hash(
    DEFAULT_PASSWORD,
    PASSWORD_SALT_ROUNDS,
  );

  const staff = await Promise.all([
    prisma.user.create({
      data: {
        username: 'superadmin',
        email: 'superadmin@myanflix.com',
        password: passwordHash,
        role: Role.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
      },
    }),
    prisma.user.create({
      data: {
        username: 'admin.thiha',
        email: 'thiha.aung@myanflix.com',
        password: passwordHash,
        role: Role.ADMIN,
        status: UserStatus.ACTIVE,
      },
    }),
    prisma.user.create({
      data: {
        username: 'admin.sarah',
        email: 'sarah.johnson@myanflix.com',
        password: passwordHash,
        role: Role.ADMIN,
        status: UserStatus.ACTIVE,
      },
    }),
  ]);

  const regularUserSeed: {
    username: string;
    email: string;
    status?: UserStatus;
  }[] = [
    { username: 'john.smith', email: 'john.smith@gmail.com' },
    { username: 'sarah.williams', email: 'sarah.williams@outlook.com' },
    { username: 'michael.chen', email: 'michael.chen@yahoo.com' },
    { username: 'susu.hlaing', email: 'susu.hlaing@gmail.com' },
    {
      username: 'emily.davis',
      email: 'emily.davis@icloud.com',
      status: UserStatus.SUSPENDED,
    },
    { username: 'kaungmyat.soe', email: 'kaungmyat.soe@gmail.com' },
    { username: 'david.kim', email: 'david.kim@naver.com' },
    { username: 'zawlin.htut', email: 'zawlin.htut@gmail.com' },
    { username: 'amara.okafor', email: 'amara.okafor@gmail.com' },
    {
      username: 'rachel.green',
      email: 'rachel.green@gmail.com',
      status: UserStatus.BANNED,
    },
  ];

  const users = await Promise.all(
    regularUserSeed.map((u) =>
      prisma.user.create({
        data: {
          username: u.username,
          email: u.email,
          password: passwordHash,
          role: Role.USER,
          status: u.status ?? UserStatus.ACTIVE,
        },
      }),
    ),
  );

  // Every user gets a wallet, funded via a recorded deposit for staff.
  await Promise.all(
    [...staff, ...users].map((user) =>
      prisma.wallet.create({ data: { userId: user.id, balance: 0 } }),
    ),
  );

  return { staff, users };
}

interface MovieSeed {
  title: string;
  description: string;
  genre: string;
  language: string;
  releaseYear: number;
  duration: number;
  price: number;
  isPremium: boolean;
  status: MovieStatus;
  rating: number;
  categories: string[];
}

const MOVIE_SEEDS: MovieSeed[] = [
  {
    title: 'Avatar: The Way of Water',
    description:
      'Jake Sully lives with his newfound family on Pandora, but must fight to protect it once a familiar threat returns.',
    genre: 'Sci-Fi',
    language: 'English',
    releaseYear: 2022,
    duration: 192,
    price: 15000,
    isPremium: true,
    status: MovieStatus.PUBLISHED,
    rating: 4.7,
    categories: ['Sci-Fi', 'Action'],
  },
  {
    title: 'Avengers: Endgame',
    description:
      'The remaining Avengers assemble once more to reverse the damage caused by Thanos.',
    genre: 'Action',
    language: 'English',
    releaseYear: 2019,
    duration: 181,
    price: 12000,
    isPremium: true,
    status: MovieStatus.PUBLISHED,
    rating: 4.9,
    categories: ['Action', 'Sci-Fi'],
  },
  {
    title: 'Inception',
    description:
      'A thief who steals corporate secrets through dream-sharing technology is given the task of planting an idea.',
    genre: 'Sci-Fi',
    language: 'English',
    releaseYear: 2010,
    duration: 148,
    price: 9000,
    isPremium: true,
    status: MovieStatus.PUBLISHED,
    rating: 4.8,
    categories: ['Sci-Fi', 'Thriller'],
  },
  {
    title: 'The Dark Knight',
    description:
      'When the Joker wreaks havoc on Gotham, Batman must accept one of the greatest tests.',
    genre: 'Action',
    language: 'English',
    releaseYear: 2008,
    duration: 152,
    price: 7500,
    isPremium: true,
    status: MovieStatus.PUBLISHED,
    rating: 4.9,
    categories: ['Action', 'Crime', 'Drama'],
  },
  {
    title: 'Interstellar',
    description:
      'A team of explorers travel through a wormhole in space to ensure humanity survival.',
    genre: 'Sci-Fi',
    language: 'English',
    releaseYear: 2014,
    duration: 169,
    price: 10000,
    isPremium: true,
    status: MovieStatus.PUBLISHED,
    rating: 4.8,
    categories: ['Sci-Fi', 'Drama'],
  },
  {
    title: 'Parasite',
    description:
      'Greed and class discrimination threaten the relationship between two families.',
    genre: 'Drama',
    language: 'Korean',
    releaseYear: 2019,
    duration: 132,
    price: 7500,
    isPremium: true,
    status: MovieStatus.PUBLISHED,
    rating: 4.9,
    categories: ['Drama', 'Thriller'],
  },
  {
    title: 'Spider-Man: Across the Spider-Verse',
    description:
      'Miles Morales catapults across the multiverse to meet a team of Spider-People.',
    genre: 'Animation',
    language: 'English',
    releaseYear: 2023,
    duration: 140,
    price: 0,
    isPremium: false,
    status: MovieStatus.PUBLISHED,
    rating: 4.9,
    categories: ['Animation', 'Action'],
  },
  {
    title: 'La La Land',
    description: 'A jazz pianist falls for an aspiring actress in Los Angeles.',
    genre: 'Romance',
    language: 'English',
    releaseYear: 2016,
    duration: 128,
    price: 0,
    isPremium: false,
    status: MovieStatus.PUBLISHED,
    rating: 4.6,
    categories: ['Romance', 'Comedy'],
  },
  {
    title: 'Joker',
    description:
      'A mentally troubled comedian embarks on a downward spiral that leads to the birth of an icon.',
    genre: 'Crime',
    language: 'English',
    releaseYear: 2019,
    duration: 122,
    price: 7500,
    isPremium: true,
    status: MovieStatus.PUBLISHED,
    rating: 4.7,
    categories: ['Crime', 'Drama', 'Thriller'],
  },
  {
    title: 'Frozen II',
    description:
      'Anna, Elsa and friends travel to an ancient forest to fulfil the promise of the past.',
    genre: 'Animation',
    language: 'English',
    releaseYear: 2019,
    duration: 103,
    price: 6000,
    isPremium: true,
    status: MovieStatus.PUBLISHED,
    rating: 4.5,
    categories: ['Animation'],
  },
  {
    title: 'Oppenheimer',
    description:
      "The story of J. Robert Oppenheimer's role in the development of the atomic bomb during World War II.",
    genre: 'Drama',
    language: 'English',
    releaseYear: 2023,
    duration: 180,
    price: 13500,
    isPremium: true,
    status: MovieStatus.PUBLISHED,
    rating: 4.8,
    categories: ['Drama', 'Documentary'],
  },
  {
    title: 'The Last Chess Game',
    description:
      'A retired grandmaster is pulled back for one final match that could change his family fate.',
    genre: 'Drama',
    language: 'English',
    releaseYear: 2021,
    duration: 114,
    price: 4500,
    isPremium: true,
    status: MovieStatus.PUBLISHED,
    rating: 4.1,
    categories: ['Drama'],
  },
  {
    title: 'Monsoon Diaries',
    description:
      'A coming-of-age drama set across a rainy season in Yangon, following three friends.',
    genre: 'Drama',
    language: 'Burmese',
    releaseYear: 2026,
    duration: 109,
    price: 5000,
    isPremium: true,
    status: MovieStatus.DRAFT,
    rating: 0,
    categories: ['Drama', 'Romance'],
  },
  {
    title: 'Twilight of the Wolves',
    description:
      'A noir thriller following a detective unraveling a conspiracy in a rain-soaked coastal city.',
    genre: 'Thriller',
    language: 'English',
    releaseYear: 2026,
    duration: 118,
    price: 8000,
    isPremium: true,
    status: MovieStatus.PROCESSING,
    rating: 0,
    categories: ['Thriller', 'Crime'],
  },
];

async function seedMovies(categoriesByName: Map<string, { id: string }>) {
  const movies = await Promise.all(
    MOVIE_SEEDS.map((seed) =>
      prisma.movie.create({
        data: {
          title: seed.title,
          description: seed.description,
          genre: seed.genre,
          language: seed.language,
          releaseYear: seed.releaseYear,
          duration: seed.duration,
          price: seed.price,
          isPremium: seed.isPremium,
          status: seed.status,
          rating: seed.rating,
          posterUrl: `https://picsum.photos/seed/${encodeURIComponent(seed.title)}/400/600`,
          coverUrl: `https://picsum.photos/seed/${encodeURIComponent(seed.title)}-cover/1280/720`,
          categories: {
            connect: seed.categories
              .map((name) => categoriesByName.get(name))
              .filter((c): c is { id: string } => Boolean(c))
              .map((c) => ({ id: c.id })),
          },
        },
      }),
    ),
  );

  // Published/processing titles get a video record; DRAFT has none yet.
  await Promise.all(
    movies
      .filter((m) => m.status !== MovieStatus.DRAFT)
      .map((movie) => {
        const ready = movie.status === MovieStatus.PUBLISHED;
        return prisma.video.create({
          data: {
            movieId: movie.id,
            originalFilename: `${movie.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.mp4`,
            originalPath: `/storage/videos/${movie.id}/original.mp4`,
            status: ready ? VideoStatus.READY : VideoStatus.PROCESSING,
            duration: ready ? movie.duration * 60 : null,
            resolution: ready ? '1920x1080' : null,
            hlsMasterPath: ready
              ? `/storage/videos/${movie.id}/hls/master.m3u8`
              : null,
            renditions: ready
              ? [
                  {
                    resolution: '1080p',
                    playlistPath: `videos/${movie.id}/hls/1080p/index.m3u8`,
                  },
                  {
                    resolution: '720p',
                    playlistPath: `videos/${movie.id}/hls/720p/index.m3u8`,
                  },
                  {
                    resolution: '480p',
                    playlistPath: `videos/${movie.id}/hls/480p/index.m3u8`,
                  },
                ]
              : undefined,
          },
        });
      }),
  );

  return movies;
}

async function seedCommerceAndHistory(
  users: { id: string }[],
  movies: {
    id: string;
    price: Prisma.Decimal;
    isPremium: boolean;
    status: MovieStatus;
    duration: number;
  }[],
) {
  const premiumPublished = movies.filter(
    (m) => m.isPremium && m.status === MovieStatus.PUBLISHED,
  );
  const freePublished = movies.filter(
    (m) => !m.isPremium && m.status === MovieStatus.PUBLISHED,
  );

  for (const [index, user] of users.entries()) {
    // Each user buys a handful of premium titles, deterministically varied per user.
    const purchaseCount = 2 + (index % 4);
    const purchasedMovies = premiumPublished
      .slice(index % premiumPublished.length)
      .concat(premiumPublished.slice(0, index % premiumPublished.length))
      .slice(0, purchaseCount);

    const totalSpent = purchasedMovies.reduce(
      (sum, m) => sum + m.price.toNumber(),
      0,
    );
    const leftoverBalance = 5000 + (index % 5) * 3000;
    const depositAmount = totalSpent + leftoverBalance;

    await prisma.wallet.update({
      where: { userId: user.id },
      data: { balance: leftoverBalance },
    });

    await prisma.transaction.create({
      data: {
        userId: user.id,
        type: TransactionType.DEPOSIT,
        amount: depositAmount,
        status: 'COMPLETED',
        createdAt: daysAgo(30),
      },
    });

    for (const [pIndex, movie] of purchasedMovies.entries()) {
      const purchasedAt = daysAgo(20 - pIndex * 3);
      await prisma.purchase.create({
        data: {
          userId: user.id,
          movieId: movie.id,
          amount: movie.price,
          createdAt: purchasedAt,
        },
      });
      await prisma.transaction.create({
        data: {
          userId: user.id,
          movieId: movie.id,
          type: TransactionType.PURCHASE,
          amount: movie.price,
          status: 'COMPLETED',
          createdAt: purchasedAt,
        },
      });

      await prisma.watchHistory.create({
        data: {
          userId: user.id,
          movieId: movie.id,
          progress: pIndex === 0 ? 100 : 30 + pIndex * 15,
          lastPosition: Math.round(
            (movie.duration * 60 * (pIndex === 0 ? 1 : 0.4)) / (pIndex + 1),
          ),
        },
      });
    }

    // Everyone can freely sample the non-premium catalog too.
    const freeSample = freePublished[index % freePublished.length];
    if (freeSample) {
      await prisma.watchHistory.upsert({
        where: { userId_movieId: { userId: user.id, movieId: freeSample.id } },
        create: {
          userId: user.id,
          movieId: freeSample.id,
          progress: 65,
          lastPosition: 1200,
        },
        update: {},
      });
    }
  }
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

async function main() {
  console.log('Seeding MyanFlix database...');

  await resetData();
  const categoriesByName = await seedCategories();
  const { staff, users } = await seedUsers();
  const movies = await seedMovies(categoriesByName);
  await seedCommerceAndHistory(users, movies);

  console.log('Seed complete:');
  console.log(`  categories: ${categoriesByName.size}`);
  console.log(
    `  users: ${staff.length + users.length} (${staff.length} staff, ${users.length} regular)`,
  );
  console.log(`  movies: ${movies.length}`);
  console.log(
    `  default password for every seeded account: ${DEFAULT_PASSWORD}`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
