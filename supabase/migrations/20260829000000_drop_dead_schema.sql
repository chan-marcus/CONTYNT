-- Remove the schema nothing reads any more.
--
-- Each item was checked against the codebase before being listed here, and
-- each one destroys nothing: the table is empty, the column is entirely null,
-- and the key-value rows are orphans whose writers no longer exist.
--
-- A backup of everything this touches was taken first, to
-- contynt-db-backups/pre-cleanup-<timestamp>/ outside the repo. The kv rows are
-- the only ones with any content at all.

-- ─── 1. creator_payouts_f5961d0c ─────────────────────────────────────────────
-- A payouts table from before balances were derived. Creator balances now come
-- from creator_earnings_f5961d0c minus creator_payout_requests_f5961d0c, and
-- have since that ledger replaced this. Its only writer was
-- /creator-portal/payout, a route with no callers, removed earlier today; the
-- one reference left in the codebase is a comment saying it is dead.
--
-- 0 rows, so this drops an empty shell. It was worth removing rather than
-- leaving: a second, silently diverging record of what a creator is owed is a
-- genuinely dangerous thing to have sitting in a schema.
drop table if exists public.creator_payouts_f5961d0c;

-- ─── 2. ambassador_cards_f5961d0c.code ───────────────────────────────────────
-- Retired by 20260819030000, which moved the code onto the creator and nulled
-- this column on every row. That migration left the column in place so old rows
-- could be read without a rewrite; nothing has read it since, and the last
-- reference -- /portal/cards shipping it as a permanent null -- went earlier
-- today.
--
-- The table stays. It still carries the handoff and attribution history for
-- each (creator, feature) pair, which is live.
alter table public.ambassador_cards_f5961d0c drop column if exists code;

-- ─── 3. Orphaned kv_store rows ───────────────────────────────────────────────
-- kv_store_f5961d0c is 1,334 rows, and about 1,072 of them are written by code
-- that no longer exists:
--
--   pageview_    649   analytics moved to visitors_f5961d0c; zero references
--   visitor_     367   same move; zero references
--   submission_   39   /store-submission was removed, SQL is the only writer now
--   signup_       11   zero references
--   business_,
--   claim_,
--   feature_       6   remnants of the KV-first design SQL replaced
--
-- Every prefix here was grepped across src/ and supabase/functions/ and has no
-- reader. Deliberately NOT included: creator_claim_ (45 rows), which
-- /creator-portal/approval-status and markReelLive still read, and every
-- ctoken_/biztoken_/admin_session_ key, which are live sessions.
--
-- LIKE patterns escape the underscore, because in LIKE an unescaped `_` is a
-- single-character wildcard -- 'ctoken_%' would happily match 'ctokenref_...'.
-- That is not a hypothetical: it silently mis-grouped these same prefixes when
-- they were first counted.
--
-- Harmless to replay: on a fresh database nothing matches.
delete from public.kv_store_f5961d0c
 where key like 'pageview\_%'
    or key like 'visitor\_%'
    or key like 'signup\_%'
    or key like 'submission\_%'
    or key like 'business\_%'
    or key like 'claim\_%'
    or key like 'feature\_%';

-- Reclaims the space the deletes above just freed. Plain VACUUM, not FULL:
-- FULL takes an exclusive lock, and this table is on the read path of every
-- authenticated request.
-- (Left to autovacuum rather than run here -- VACUUM cannot run inside the
-- transaction a migration executes in.)
