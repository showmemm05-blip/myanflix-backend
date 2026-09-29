-- The amount-fallback match was removed from the deposit matcher: a transfer
-- only ever attaches to the deposit carrying its own last-6. Its partial
-- index has no reader left, and every deposit insert paid for it.
DROP INDEX IF EXISTS "deposits_open_amount_idx";
