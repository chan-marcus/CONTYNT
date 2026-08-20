-- Ambassador scans now name the business, so a scan has to decide whether it is
-- looking at a business we already know or a new one.
--
-- place_id is what makes that decision reliable. Two people typing "Blue Bottle"
-- and "Blue Bottle Coffee" produce different strings for the same shop; the
-- Google place_id is the same either way, so it is the match key and the name is
-- only what we display.

alter table public.business_signups_f5961d0c
  add column if not exists place_id      text,
  add column if not exists place_address text,
  add column if not exists lead_status   text;

-- Partial, so the many businesses without a place_id do not collide on null.
create unique index if not exists business_signups_place_id_key
  on public.business_signups_f5961d0c (place_id)
  where place_id is not null;

alter table public.business_signups_f5961d0c
  drop constraint if exists business_signups_lead_status_check;
alter table public.business_signups_f5961d0c
  add constraint business_signups_lead_status_check
  check (lead_status is null or lead_status in ('prospect', 'lead', 'unverified_lead'));

comment on column public.business_signups_f5961d0c.place_id is
  'Google Places id. The match key for attaching an ambassador scan to an existing business.';
comment on column public.business_signups_f5961d0c.lead_status is
  'prospect -> known but cold. lead -> an owner scanned a card and left an email. unverified_lead -> created by a scan, nobody has checked it is real. Null for businesses that came in through the normal signup.';

-- Businesses created by a scan start unverified and must be approved before
-- they are worked. Nothing puts a Feature on the board for them until an admin
-- offers one, so this flag is what admin filters on rather than a hard gate.
create index if not exists business_signups_lead_status_idx
  on public.business_signups_f5961d0c (lead_status)
  where lead_status is not null;
