-- Drop the stored monthly Reel counter.
--
-- reels_used_this_month was incremented on each business feature request, with
-- reels_reset_month stamping the month it belonged to. Usage is now derived
-- from the features themselves (src/app/lib/featureQuota.ts), which is the
-- single source of truth: the stored counter knew nothing about one-off
-- purchases, withdrawn features, or features an admin removed, so it drifted
-- from what both the portal and the admin panel displayed.
--
-- reels_reset_month goes with it -- it existed only to scope the counter to a
-- month and means nothing on its own.
--
-- The edge function stopped reading and writing both columns in the deploy
-- that precedes this migration, so nothing references them.
--
-- This discards the stored counts. They are not recoverable, and deliberately
-- so: they were wrong, and the derived count does not need them.

alter table public.business_signups_f5961d0c
  drop column if exists reels_used_this_month,
  drop column if exists reels_reset_month;
