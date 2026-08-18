-- Creator verification, profile fields, ambassador opt-in, and anonymous
-- ambassador cards.
--
-- Conventions followed from the existing schema:
--   * tables suffixed _f5961d0c
--   * status columns are text + CHECK, never PG enum types (alterable without
--     a type migration, and every existing status column is plain text)
--   * timestamptz everywhere
--
-- Key types, verified against the linked database rather than assumed:
--
--   creator_signups_f5961d0c.id   uuid   (PK)
--   business_signups_f5961d0c.id  uuid   (PK)
--   features_f5961d0c.id          text   (PK)
--   features_f5961d0c.business_id text          <- a uuid held as text
--
-- So card.feature_id is text to match features.id, and every business reference
-- is text because it is sourced from features.business_id, which is text. Those
-- business columns carry no foreign key on purpose: the type does not match
-- business_signups.id (uuid), and a column typed to satisfy a constraint it
-- cannot actually hold would be worse than an honest unconstrained one.

begin;

-- ─── 1. Creator verification ─────────────────────────────────────────────────
alter table creator_signups_f5961d0c
  add column if not exists verify_token             text,
  add column if not exists verify_token_expires_at  timestamptz,
  add column if not exists verify_email_sent_at     timestamptz,
  add column if not exists verify_link_opened_at    timestamptz,
  add column if not exists verify_open_count        integer not null default 0,
  add column if not exists verify_confirmed_at      timestamptz,
  add column if not exists verification_status      text not null default 'pending';

-- One creator per token. Partial so the many NULLs before a send do not collide.
create unique index if not exists creator_signups_verify_token_key
  on creator_signups_f5961d0c (verify_token)
  where verify_token is not null;

create index if not exists creator_signups_verification_status_idx
  on creator_signups_f5961d0c (verification_status);

alter table creator_signups_f5961d0c
  drop constraint if exists creator_signups_verification_status_check;
alter table creator_signups_f5961d0c
  add constraint creator_signups_verification_status_check
  check (verification_status in ('pending', 'opened', 'confirmed', 'expired'));

-- ─── 2. Creator profile ──────────────────────────────────────────────────────
-- instagram already exists on this table and stays the source of truth for the
-- handle. instagram_handle is the normalised form (no @, no URL) written by the
-- confirm handler, so the raw signup value is never destroyed.
alter table creator_signups_f5961d0c
  add column if not exists instagram_handle       text,
  add column if not exists service_areas          text[] not null default '{}',
  add column if not exists max_features_per_week  integer,
  add column if not exists notify_email           boolean not null default true,
  add column if not exists notify_sms             boolean not null default false,
  add column if not exists phone                  text,
  add column if not exists portfolio_url          text,
  add column if not exists dietary_notes          text;

alter table creator_signups_f5961d0c
  drop constraint if exists creator_signups_max_features_check;
alter table creator_signups_f5961d0c
  add constraint creator_signups_max_features_check
  check (max_features_per_week is null or max_features_per_week between 1 and 4);

-- Set by the Postmark webhook. Suppresses further sends.
alter table creator_signups_f5961d0c
  add column if not exists email_bounced_at    timestamptz,
  add column if not exists email_complained_at timestamptz;

-- ─── 3. Ambassador opt-in ────────────────────────────────────────────────────
-- NOTE: ambassadors_f5961d0c.enabled_status is the pre-existing opt-in flag.
-- These columns become the source of truth for consent and its timestamps;
-- the backfill below seeds them from enabled_status so the two agree on day one,
-- and the /enable route must write both from here on.
alter table creator_signups_f5961d0c
  add column if not exists ambassador_opted_in     boolean not null default false,
  add column if not exists ambassador_opted_in_at  timestamptz,
  add column if not exists ambassador_opt_out_at   timestamptz;

-- ─── 4. Event log ────────────────────────────────────────────────────────────
create table if not exists creator_events_f5961d0c (
  id          uuid primary key default gen_random_uuid(),
  creator_id  uuid not null references creator_signups_f5961d0c (id) on delete cascade,
  type        text not null,
  payload     jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);
create index if not exists creator_events_creator_idx on creator_events_f5961d0c (creator_id, occurred_at desc);
create index if not exists creator_events_type_idx    on creator_events_f5961d0c (type, occurred_at desc);

-- ─── 5. Email events (Postmark) ──────────────────────────────────────────────
-- creator_id is nullable: a webhook can arrive for an address no longer matched
-- to a creator, and dropping it would lose the bounce.
create table if not exists email_events_f5961d0c (
  id          uuid primary key default gen_random_uuid(),
  creator_id  uuid references creator_signups_f5961d0c (id) on delete set null,
  message_id  text,
  type        text not null,
  payload     jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);
create index if not exists email_events_creator_idx on email_events_f5961d0c (creator_id, occurred_at desc);
create index if not exists email_events_message_idx on email_events_f5961d0c (message_id);

-- ─── 6. Ambassador cards ─────────────────────────────────────────────────────
-- code carries no creator identity: 6 chars, crypto-random, from a 30 character
-- alphabet. The omitted characters are 0, 1 and the letters I, L, O, U. NOTE
-- this follows the literal alphabet in the brief, which retains B, S, 5 and 8
-- and drops U; the brief's parenthetical said the opposite. If the parenthetical
-- was the intent, this regex, anonCode() and test-e2e.sh all change together.
-- The CHECK enforces it at the database level so a regressed generator cannot
-- quietly ship an ambiguous code.
create table if not exists ambassador_cards_f5961d0c (
  id                       uuid primary key default gen_random_uuid(),
  creator_id               uuid not null references creator_signups_f5961d0c (id) on delete cascade,
  feature_id               text not null references features_f5961d0c (id) on delete cascade,
  business_id              text,
  code                     text not null,
  generated_at             timestamptz not null default now(),
  printed_at               timestamptz,
  handed_off_at            timestamptz,
  handoff_status           text not null default 'pending',
  handoff_failure_reason   text,
  is_attributed            boolean not null default false,
  attribution_locked_until timestamptz,
  business_signup_id       text,
  constraint ambassador_cards_code_charset check (code ~ '^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{6}$'),
  constraint ambassador_cards_handoff_status_check
    check (handoff_status in ('pending', 'handed_off', 'not_handed_off'))
);

create unique index if not exists ambassador_cards_code_key on ambassador_cards_f5961d0c (code);
-- One card per approved (creator, feature) pair.
create unique index if not exists ambassador_cards_creator_feature_key
  on ambassador_cards_f5961d0c (creator_id, feature_id);
-- Enforces "one attributed card per business" in the database rather than in a
-- read-then-write race between two simultaneous first scans.
create unique index if not exists ambassador_cards_one_attributed_per_business
  on ambassador_cards_f5961d0c (business_id)
  where is_attributed and business_id is not null;
create index if not exists ambassador_cards_creator_idx on ambassador_cards_f5961d0c (creator_id);

-- ─── 7. Card scans ───────────────────────────────────────────────────────────
-- No raw IP. ip_hash only, so a scan row cannot re-identify a walk-in.
create table if not exists ambassador_card_scans_f5961d0c (
  id           uuid primary key default gen_random_uuid(),
  card_code    text not null,
  ip_hash      text,
  user_agent   text,
  occurred_at  timestamptz not null default now(),
  is_self_scan boolean not null default false
);
create index if not exists ambassador_card_scans_code_idx on ambassador_card_scans_f5961d0c (card_code, occurred_at desc);

-- ─── 8. Leads captured in state A ────────────────────────────────────────────
create table if not exists ambassador_leads_f5961d0c (
  id          uuid primary key default gen_random_uuid(),
  card_code   text not null,
  business_id text,
  email       text not null,
  occurred_at timestamptz not null default now(),
  notified_at timestamptz
);
-- Spec calls for unique on (business_id, email). business_id is nullable and
-- NULLs do not collide in a plain unique index, so a card whose business is not
-- yet resolved would admit duplicates; coalesce pins those to one row per email.
create unique index if not exists ambassador_leads_business_email_key
  on ambassador_leads_f5961d0c (coalesce(business_id, card_code), lower(email));
create index if not exists ambassador_leads_card_idx on ambassador_leads_f5961d0c (card_code);

-- ─── 9. Feature gating ───────────────────────────────────────────────────────
alter table features_f5961d0c
  add column if not exists early_access_until timestamptz;

-- ─── 10. Backfill ────────────────────────────────────────────────────────────
-- Existing creators: pending, opted out, notifications on.
update creator_signups_f5961d0c
   set verification_status = 'pending'
 where verification_status is null;

update creator_signups_f5961d0c
   set ambassador_opted_in = false
 where ambassador_opted_in is null;

-- Anyone already live as an ambassador keeps that consent rather than being
-- silently switched off by this migration.
update creator_signups_f5961d0c c
   set ambassador_opted_in    = true,
       ambassador_opted_in_at = coalesce(c.ambassador_opted_in_at, a.created_at, now())
  from ambassadors_f5961d0c a
 where a.creator_id = c.id
   and a.enabled_status
   and not c.ambassador_opted_in;

-- Normalised handle seeded from the existing signup value.
update creator_signups_f5961d0c
   set instagram_handle = regexp_replace(
         regexp_replace(coalesce(instagram, ''), '^.*instagram\.com/', '', 'i'),
         '[^A-Za-z0-9._]', '', 'g')
 where instagram_handle is null
   and coalesce(instagram, '') <> '';

-- ─── 11. Hard rotation of handle-derived referral codes ──────────────────────
-- referralCodeFor() built codes from the Instagram handle (JANEDOE123), so the
-- code itself identified the creator. Every existing code is replaced with an
-- anonymous one drawn from the same alphabet as card codes. Old codes stop
-- resolving, which is the point: anything already printed carrying a handle
-- should stop working rather than keep leaking.
--
-- The generator is inlined rather than left behind as a SQL function. The edge
-- function generates codes in TypeScript via crypto.getRandomValues, and a
-- second permanent implementation here would be free to drift from it.
create extension if not exists pgcrypto;

do $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTVWXYZ23456789';   -- 30 chars
  n        constant int  := 30;
  -- 256 is not a multiple of 30, so a bare byte % 30 would favour the first
  -- six letters. Reject bytes at or above the largest multiple of 30 under 256.
  bound    constant int  := 240;
  r        record;
  new_code text;
  b        int;
  tries    int;
begin
  for r in select ambassador_id from ambassadors_f5961d0c loop
    tries := 0;
    loop
      tries := tries + 1;
      new_code := '';
      while length(new_code) < 6 loop
        b := get_byte(gen_random_bytes(1), 0);
        if b < bound then
          new_code := new_code || substr(alphabet, (b % n) + 1, 1);
        end if;
      end loop;
      exit when not exists (
        select 1 from ambassadors_f5961d0c where referral_code = new_code
      );
      if tries > 20 then
        raise exception 'could not allocate a unique referral code after 20 tries';
      end if;
    end loop;

    -- Rewrite only the trailing code segment so whatever origin the URL was
    -- minted against (SITE_ORIGIN is an edge-function env var, unknown here)
    -- is preserved.
    update ambassadors_f5961d0c
       set referral_code = new_code,
           referral_url  = regexp_replace(coalesce(referral_url, ''), '[^/=?]+$', new_code)
     where ambassador_id = r.ambassador_id;

    -- Historical referral rows denormalise the code. Left alone they would keep
    -- displaying the handle-derived value in the admin funnel.
    update ambassador_referrals_f5961d0c
       set referral_code = new_code,
           referral_url  = regexp_replace(coalesce(referral_url, ''), '[^/=?]+$', new_code)
     where ambassador_id = r.ambassador_id;
  end loop;
end $$;

-- Applied after rotation: the handle-derived codes would all have failed it.
create unique index if not exists ambassadors_referral_code_key
  on ambassadors_f5961d0c (referral_code);

alter table ambassadors_f5961d0c
  drop constraint if exists ambassadors_referral_code_charset;
alter table ambassadors_f5961d0c
  add constraint ambassadors_referral_code_charset
  check (referral_code ~ '^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{6}$');

-- ─── 12. Lock down the new tables ────────────────────────────────────────────
-- Every table above is reached only by the edge function, which holds the
-- service role key and therefore bypasses RLS entirely. So RLS is enabled with
-- NO policies: that is a deny-all for anon and authenticated, and it is what the
-- other twelve tables in this schema already do.
--
-- The grants are revoked as well. RLS alone would be enough today, but a grant
-- is a loaded gun: the moment anyone adds a permissive policy for convenience,
-- full INSERT/UPDATE/DELETE is already sitting there waiting. These tables hold
-- email addresses (email_events, ambassador_leads) and the card codes that carry
-- attribution money, so the second lock is worth having.
alter table creator_events_f5961d0c        enable row level security;
alter table email_events_f5961d0c          enable row level security;
alter table ambassador_cards_f5961d0c      enable row level security;
alter table ambassador_card_scans_f5961d0c enable row level security;
alter table ambassador_leads_f5961d0c      enable row level security;

revoke all on creator_events_f5961d0c        from anon, authenticated;
revoke all on email_events_f5961d0c          from anon, authenticated;
revoke all on ambassador_cards_f5961d0c      from anon, authenticated;
revoke all on ambassador_card_scans_f5961d0c from anon, authenticated;
revoke all on ambassador_leads_f5961d0c      from anon, authenticated;

commit;
