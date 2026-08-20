-- Retire the per-feature card code.
--
-- The previous migration moved the code onto the creator. ambassador_cards rows
-- stay, because they carry the handoff and attribution history for a (creator,
-- feature) pair, but they no longer carry a code of their own: /a/:code now
-- resolves a creator, so a second code per row is a second source of truth for
-- something that has one answer.
--
-- The earliest card code per creator was copied onto creator_signups in
-- 20260819020000, so the codes dropped here are already preserved where they
-- are now read from.

drop index if exists public.ambassador_cards_code_key;

alter table public.ambassador_cards_f5961d0c
  drop constraint if exists ambassador_cards_code_charset;

alter table public.ambassador_cards_f5961d0c
  alter column code drop not null;

update public.ambassador_cards_f5961d0c set code = null where code is not null;

comment on column public.ambassador_cards_f5961d0c.code is
  'Retired. Codes live on creator_signups_f5961d0c.ambassador_code. Kept nullable so old rows can be read without a rewrite.';
