-- CreateTable
CREATE TABLE "actors" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "imageUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "actors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_ActorToMovie" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_ActorToMovie_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "actors_name_key" ON "actors"("name");

-- CreateIndex
CREATE INDEX "_ActorToMovie_B_index" ON "_ActorToMovie"("B");

-- AddForeignKey
ALTER TABLE "_ActorToMovie" ADD CONSTRAINT "_ActorToMovie_A_fkey" FOREIGN KEY ("A") REFERENCES "actors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ActorToMovie" ADD CONSTRAINT "_ActorToMovie_B_fkey" FOREIGN KEY ("B") REFERENCES "movies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Grant the new ACTORS permissions to the already-seeded system roles, the
-- same way add_tracking and add_books granted theirs — the seed arrays in
-- src/roles/system-roles.seed.ts only describe a fresh database; existing
-- app_role_permissions rows are data and must be migrated here.
-- SUPER_ADMIN needs no rows: the resolver short-circuits it to everything.
-- CONTENT_UPLOADER gets everything but DELETE, mirroring its movie grants.
INSERT INTO "app_role_permissions" ("id", "roleId", "permission", "createdAt")
SELECT gen_random_uuid(), r."id", seed.permission, now()
FROM "app_roles" r
JOIN (
  VALUES
  ('ADMIN', 'ACTORS.VIEW'),
  ('ADMIN', 'ACTORS.CREATE'),
  ('ADMIN', 'ACTORS.EDIT'),
  ('ADMIN', 'ACTORS.DELETE'),
  ('CONTENT_UPLOADER', 'ACTORS.VIEW'),
  ('CONTENT_UPLOADER', 'ACTORS.CREATE'),
  ('CONTENT_UPLOADER', 'ACTORS.EDIT')
) AS seed(role_key, permission) ON seed.role_key = r."key"
ON CONFLICT ("roleId", "permission") DO NOTHING;
