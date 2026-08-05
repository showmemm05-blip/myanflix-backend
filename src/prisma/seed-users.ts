/**
 * Seeds just user accounts (+ their wallets) for testing login — safe to run
 * against a database that already has real data, since it upserts by email
 * instead of wiping the database first like seed.ts does.
 *
 * Run with: npm run db:seed:users
 * (compiles through `nest build` first, same reason as seed.ts — the
 * generated Prisma client's nodenext ".js" imports only resolve once built.)
 */
import 'dotenv/config';
import * as bcrypt from 'bcrypt';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Role, UserStatus } from '../generated/prisma/client';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const PASSWORD_SALT_ROUNDS = 10;
const DEFAULT_PASSWORD = 'Password123!';

interface UserSeed {
  username: string;
  email: string;
  role: Role;
  status: UserStatus;
}

const USER_SEEDS: UserSeed[] = [
  {
    username: 'superadmin',
    email: 'superadmin@myanflix.com',
    role: Role.SUPER_ADMIN,
    status: UserStatus.ACTIVE,
  },
  {
    username: 'admin.thiha',
    email: 'thiha.aung@myanflix.com',
    role: Role.ADMIN,
    status: UserStatus.ACTIVE,
  },
  {
    username: 'admin.sarah',
    email: 'sarah.johnson@myanflix.com',
    role: Role.ADMIN,
    status: UserStatus.ACTIVE,
  },
  {
    username: 'uploader.maung',
    email: 'uploader@myanflix.com',
    role: Role.CONTENT_UPLOADER,
    status: UserStatus.ACTIVE,
  },
  {
    username: 'john.smith',
    email: 'john.smith@gmail.com',
    role: Role.USER,
    status: UserStatus.ACTIVE,
  },
  {
    username: 'sarah.williams',
    email: 'sarah.williams@outlook.com',
    role: Role.USER,
    status: UserStatus.ACTIVE,
  },
  {
    username: 'michael.chen',
    email: 'michael.chen@yahoo.com',
    role: Role.USER,
    status: UserStatus.ACTIVE,
  },
  {
    username: 'susu.hlaing',
    email: 'susu.hlaing@gmail.com',
    role: Role.USER,
    status: UserStatus.ACTIVE,
  },
  {
    username: 'emily.davis',
    email: 'emily.davis@icloud.com',
    role: Role.USER,
    status: UserStatus.SUSPENDED,
  },
  {
    username: 'kaungmyat.soe',
    email: 'kaungmyat.soe@gmail.com',
    role: Role.USER,
    status: UserStatus.ACTIVE,
  },
  {
    username: 'david.kim',
    email: 'david.kim@naver.com',
    role: Role.USER,
    status: UserStatus.ACTIVE,
  },
  {
    username: 'zawlin.htut',
    email: 'zawlin.htut@gmail.com',
    role: Role.USER,
    status: UserStatus.ACTIVE,
  },
  {
    username: 'amara.okafor',
    email: 'amara.okafor@gmail.com',
    role: Role.USER,
    status: UserStatus.ACTIVE,
  },
  {
    username: 'rachel.green',
    email: 'rachel.green@gmail.com',
    role: Role.USER,
    status: UserStatus.BANNED,
  },
];

async function main() {
  console.log('Seeding users (non-destructive upsert by email)...');

  const passwordHash = await bcrypt.hash(
    DEFAULT_PASSWORD,
    PASSWORD_SALT_ROUNDS,
  );

  for (const seed of USER_SEEDS) {
    const user = await prisma.user.upsert({
      where: { email: seed.email },
      create: {
        username: seed.username,
        email: seed.email,
        password: passwordHash,
        role: seed.role,
        status: seed.status,
      },
      update: {
        username: seed.username,
        password: passwordHash,
        role: seed.role,
        status: seed.status,
      },
    });

    await prisma.wallet.upsert({
      where: { userId: user.id },
      create: { userId: user.id, balance: 0 },
      update: {},
    });
  }

  console.log(`Seed complete: ${USER_SEEDS.length} users upserted.`);
  console.log(`Default password for every seeded account: ${DEFAULT_PASSWORD}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
