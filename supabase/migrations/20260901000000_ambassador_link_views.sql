-- How many times an ambassador's referral link was actually opened.
--
-- Card scans have been logged since August, but the link is the other half of
-- the same job and nothing counted it: /referral/:code resolved the code and
-- returned, leaving no trace. So an ambassador who handed out fifty cards and
-- one who posted their link to a story looked identical until a business
-- signed up, and the only visible number was the conversion itself. Anything
-- that happened before that -- opened and ignored, opened ten times, never
-- opened at all -- was invisible, which is exactly the part that says whether
-- the link is being shared.
--
-- Deliberately its own table rather than a source column on
-- ambassador_card_scans_f5961d0c. Every existing query against that table --
-- the rate limiter, creatorScanState, the admin stats -- selects without a
-- source filter, so folding link views into it would silently inflate every
-- scan count already on screen. They are also different events worth telling
-- apart: a scan is somebody standing in a shop with a card, a view is a click.
--
-- No raw IP, matching the scans table: ip_hash only, so a row cannot
-- re-identify a visitor. The hash is salted by hashIp().
create table if not exists public.ambassador_link_views_f5961d0c (
  id            uuid primary key default gen_random_uuid(),
  referral_code text not null,
  ip_hash       text,
  user_agent    text,
  occurred_at   timestamptz not null default now(),
  -- An ambassador opening their own link to check it must not inflate their
  -- own number. Counted but flagged, the same way a self-scan is.
  is_self_view  boolean not null default false
);

-- Every read is "this code, newest first" -- the per-ambassador count and the
-- rate limiter's recent-window check both go through it.
create index if not exists ambassador_link_views_code_idx
  on public.ambassador_link_views_f5961d0c (referral_code, occurred_at desc);

-- Same second lock the other ambassador tables carry: the service role reaches
-- these rows, nothing holding the public anon key does.
alter table public.ambassador_link_views_f5961d0c enable row level security;
revoke all on public.ambassador_link_views_f5961d0c from anon, authenticated;

comment on table public.ambassador_link_views_f5961d0c is
  'One row per open of /referral/:code. Card scans live in ambassador_card_scans_f5961d0c; these are deliberately separate counts.';
