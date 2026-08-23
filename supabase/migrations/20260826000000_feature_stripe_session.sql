-- A one-time Feature purchase has to create the Feature it was paid for.
--
-- checkout.session.completed for contynt_one_off_feature used to write the
-- customer id, log an event, and stop. Nothing put a Feature on the business's
-- board, so an $89 purchase delivered nothing until somebody noticed it in the
-- dashboard and clicked "One-Time" by hand -- and there was no queue anywhere
-- saying it was owed.
--
-- The webhook now creates the Feature itself. Stripe retries a delivery it did
-- not get a 2xx for, and retries are not rare, so the session id is recorded on
-- the row and made unique: a second delivery of the same event collides here
-- rather than granting a second Reel. The index is partial because every
-- Feature created any other way leaves this null.

alter table public.features_f5961d0c
  add column if not exists stripe_session_id text;

create unique index if not exists features_stripe_session_id_key
  on public.features_f5961d0c (stripe_session_id)
  where stripe_session_id is not null;

comment on column public.features_f5961d0c.stripe_session_id is
  'Stripe Checkout Session that paid for this Feature. Set only for one-time purchases; unique, so a webhook retry cannot grant a second Reel.';
