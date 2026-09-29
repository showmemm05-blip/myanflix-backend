-- CreateTable
CREATE TABLE "_ActorToSeries" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_ActorToSeries_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "_ActorToSeries_B_index" ON "_ActorToSeries"("B");

-- AddForeignKey
ALTER TABLE "_ActorToSeries" ADD CONSTRAINT "_ActorToSeries_A_fkey" FOREIGN KEY ("A") REFERENCES "actors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ActorToSeries" ADD CONSTRAINT "_ActorToSeries_B_fkey" FOREIGN KEY ("B") REFERENCES "series"("id") ON DELETE CASCADE ON UPDATE CASCADE;
