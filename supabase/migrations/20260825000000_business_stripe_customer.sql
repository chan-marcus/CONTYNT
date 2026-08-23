-- The customer the subscription belongs to, so a business can be sent to its
-- own billing portal without us guessing which Stripe customer it is. Written
-- by the checkout webhook; older rows fall back to a lookup by email.
alter table business_signups_f5961d0c
  add column if not exists stripe_customer_id text;
