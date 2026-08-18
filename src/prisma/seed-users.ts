/**
 * Seeds just user accounts (+ their wallets) for testing login — safe to run
 * against a database that already has real data, since it upserts by username
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
  role: Role;
  status: UserStatus;
}

const USER_SEEDS: UserSeed[] = [
  {
    username: 'superadmin',
    role: Role.SUPER_ADMIN,
    status: UserStatus.ACTIVE,
  },
  {
    username: 'admin.thiha',
    role: Role.ADMIN,
    status: UserStatus.ACTIVE,
  },
  {
    username: 'admin.sarah',
    role: Role.ADMIN,
    status: UserStatus.ACTIVE,
  },
  {
    username: 'uploader.maung',
    role: Role.CONTENT_UPLOADER,
    status: UserStatus.ACTIVE,
  },
  {
    username: 'john.smith',
    role: Role.USER,
    status: UserStatus.ACTIVE,
  },
  {
    username: 'sarah.williams',
    role: Role.USER,
    status: UserStatus.ACTIVE,
  },
  {
    username: 'michael.chen',
    role: Role.USER,
    status: UserStatus.ACTIVE,
  },
  {
    username: 'susu.hlaing',
    role: Role.USER,
    status: UserStatus.ACTIVE,
  },
  {
    username: 'emily.davis',
    role: Role.USER,
    status: UserStatus.SUSPENDED,
  },
  {
    username: 'kaungmyat.soe',
    role: Role.USER,
    status: UserStatus.ACTIVE,
  },
  {
    username: 'david.kim',
    role: Role.USER,
    status: UserStatus.ACTIVE,
  },
  {
    username: 'zawlin.htut',
    role: Role.USER,
    status: UserStatus.ACTIVE,
  },
  {
    username: 'amara.okafor',
    role: Role.USER,
    status: UserStatus.ACTIVE,
  },
  {
    username: 'rachel.green',
    role: Role.USER,
    status: UserStatus.BANNED,
  },
];

async function main() {
  console.log('Seeding users (non-destructive upsert by username)...');

  const passwordHash = await bcrypt.hash(
    DEFAULT_PASSWORD,
    PASSWORD_SALT_ROUNDS,
  );

  for (const seed of USER_SEEDS) {
    const user = await prisma.user.upsert({
      where: { username: seed.username },
      create: {
        username: seed.username,
        password: passwordHash,
        role: seed.role,
        status: seed.status,
      },
      update: {
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
