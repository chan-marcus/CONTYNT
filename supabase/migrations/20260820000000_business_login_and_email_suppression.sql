-- Business email-code login, and email suppression for business addresses.
--
-- The creator side already had all three of these (bounce columns, an event log,
-- and a creator_id on email_events). Businesses are about to log in the same
-- way, so they need the same three or the shared code paths have to branch on
-- audience for no reason other than a missing column.
--
-- Conventions match 20260817000000: tables suffixed _f5961d0c, timestamptz
-- everywhere, RLS on with no policies, grants revoked.

begin;

-- ─── 1. Suppression ──────────────────────────────────────────────────────────
-- Written by the Postmark webhook, read by the login-code request route. A hard
-- bounce or a spam complaint stops us mailing the address, exactly as it does
-- for a creator.
alter table business_signups_f5961d0c
  add column if not exists email_bounced_at    timestamptz,
  add column if not exists email_complained_at timestamptz;

-- ─── 2. Business event log ───────────────────────────────────────────────────
-- Mirrors creator_events_f5961d0c. A portal that shows revenue, creator claims
-- and contact details should record who signed into it and when.
create table if not exists business_events_f5961d0c (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references business_signups_f5961d0c (id) on delete cascade,
  type        text not null,
  payload     jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);
create index if not exists business_events_business_idx on business_events_f5961d0c (business_id, occurred_at desc);
create index if not exists business_events_type_idx     on business_events_f5961d0c (type, occurred_at desc);

-- ─── 3. Email events reach both audiences ────────────────────────────────────
-- Nullable and unconstrained-by-pair on purpose: an event matches a creator, a
-- business, both (same address on two rows) or neither, and all four are real.
alter table email_events_f5961d0c
  add column if not exists business_id uuid references business_signups_f5961d0c (id) on delete set null;
create index if not exists email_events_business_idx on email_events_f5961d0c (business_id, occurred_at desc);

-- ─── 4. Lock down ────────────────────────────────────────────────────────────
-- Reached only by the edge function, which holds the service role key and
-- bypasses RLS. Enabled with no policies is a deny-all for anon and
-- authenticated; the revoke is the second lock, so a permissive policy added
-- later for convenience does not silently come with write access attached.
alter table business_events_f5961d0c enable row level security;
revoke all on business_events_f5961d0c from anon, authenticated;

commit;
