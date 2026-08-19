-- A one-time feature is a purchase on top of the subscription, so it must raise
-- the business's monthly entitlement rather than consume one of the Reels they
-- already pay for.
--
-- Until now nothing recorded the difference. /admin/offer-feature wrote
-- is_trial = false for a one-time purchase, which is byte-identical to a
-- subscription Reel the business requested itself, so the quota could not tell
-- them apart and a $89 purchase silently ate a subscription slot.
--
-- Existing rows are all subscription or trial features -- the One-Time button
-- that sets this flag ships alongside this migration -- so the false default
-- is correct for every row already in the table.

alter table public.features_f5961d0c
  add column if not exists is_one_off boolean not null default false;

comment on column public.features_f5961d0c.is_one_off is
  'Purchased outside the subscription. Adds one to the monthly entitlement instead of consuming one.';
