-- One ambassador code per CREATOR, replacing the per-feature card code.
--
-- The code used to live on ambassador_cards_f5961d0c, one row per (creator,
-- feature), so a creator working three Features carried three different codes
-- and three different printables. The code now identifies the creator, so the
-- same code and link appear in the Ambassador tab and on every in-progress
-- Feature, and a printed card never goes stale when a Feature closes.

alter table public.creator_signups_f5961d0c
  add column if not exists ambassador_code text;

-- Same alphabet as the card codes: no I, L, O, U, 0 or 1, so a code read off a
-- printed card cannot be mistyped into a different valid one.
alter table public.creator_signups_f5961d0c
  drop constraint if exists creator_ambassador_code_charset;
alter table public.creator_signups_f5961d0c
  add constraint creator_ambassador_code_charset
  check (ambassador_code is null or ambassador_code ~ '^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{6}$');

create unique index if not exists creator_signups_ambassador_code_key
  on public.creator_signups_f5961d0c (ambassador_code)
  where ambassador_code is not null;

comment on column public.creator_signups_f5961d0c.ambassador_code is
  'Stable per-creator ambassador code, uppercase. Matched case-insensitively via canonicalCode(). Minted on opt-in.';

-- Carry existing card codes onto their creator so any card already printed
-- keeps resolving. Picks the earliest card per creator; the rest are dropped
-- below. Skips creators who somehow already have a code.
with first_card as (
  select distinct on (creator_id) creator_id, code
    from public.ambassador_cards_f5961d0c
   order by creator_id, generated_at
)
update public.creator_signups_f5961d0c s
   set ambassador_code = f.code
  from first_card f
 where f.creator_id = s.id
   and s.ambassador_code is null;

-- Anyone already opted in without a card still needs a code. Generated in a
-- retry loop because the unique index, not this loop, is what guarantees
-- uniqueness.
do $$
declare r record; candidate text;
begin
  for r in select id from public.creator_signups_f5961d0c
            where ambassador_opted_in and ambassador_code is null loop
    loop
      select string_agg(substr('ABCDEFGHJKMNPQRSTVWXYZ23456789',
                               (floor(random() * 30) + 1)::int, 1), '')
        into candidate from generate_series(1, 6);
      exit when not exists (
        select 1 from public.creator_signups_f5961d0c where ambassador_code = candidate
      );
    end loop;
    update public.creator_signups_f5961d0c set ambassador_code = candidate where id = r.id;
  end loop;
end $$;

-- Per-feature codes are no longer minted. The table stays for the handoff and
-- attribution history it carries, but its code column is now legacy: /a/:code
-- checks creator codes first and only falls back here for cards printed before
-- this migration.
comment on column public.ambassador_cards_f5961d0c.code is
  'LEGACY per-feature code. New codes live on creator_signups_f5961d0c.ambassador_code; nothing writes this any more.';
