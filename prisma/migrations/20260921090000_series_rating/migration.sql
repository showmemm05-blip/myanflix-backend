-- Series gains the same admin-set 0–10 rating Movie has had since the start.
-- NOT NULL DEFAULT 0 backfills every existing show as "not rated yet", which
-- is exactly what the clients render as a dash.
ALTER TABLE "series" ADD COLUMN "rating" DOUBLE PRECISION NOT NULL DEFAULT 0;
