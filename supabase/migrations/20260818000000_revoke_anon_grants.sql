-- Defense in depth for the tables that predate this branch.
--
-- Measured state before this migration: all 12 public tables already had RLS
-- enabled with zero policies, and a live probe with the public anon key
-- confirmed it holds — SELECT returned [], INSERT returned 401, and nothing was
-- written. So this migration does not fix an open door.
--
-- What it fixes is the second lock. Four tables still carried the full default
-- grant set to anon and authenticated:
--
--   creator_signups_f5961d0c   names, emails, phone numbers
--   kv_store_f5961d0c          creator sessions, admin sessions, login codes
--   creator_payouts_f5961d0c   payout records
--   visitors_f5961d0c          analytics
--
--   DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
--
-- RLS is the only thing standing between that grant set and the public internet.
-- Adding one permissive policy to any of those tables — the kind of thing done
-- in a hurry to unblock a feature — turns the grant live instantly, and on
-- kv_store that means handing out every creator and admin session token.
--
-- Nothing in the application reads these tables as anon. The frontend holds the
-- anon key purely as a bearer token for edge-function calls and never queries
-- PostgREST; the edge function and kv_store both use SUPABASE_SERVICE_ROLE_KEY,
-- which bypasses both RLS and grants. So revoking costs nothing at runtime.

begin;

do $$
declare t record;
begin
  for t in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
  loop
    execute format('revoke all on public.%I from anon, authenticated', t.relname);
  end loop;
end $$;

-- Belt and braces: RLS on anything that somehow still lacks it, so this file is
-- a complete statement of the posture rather than a partial one.
do $$
declare t record;
begin
  for t in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
  loop
    execute format('alter table public.%I enable row level security', t.relname);
  end loop;
end $$;

-- Without this, the next `create table` in public silently inherits the same
-- wide grants and the problem returns on a table nobody thought to check.
-- A table that genuinely needs anon access must now grant it explicitly, which
-- is the decision being made out loud rather than by default.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;

commit;
