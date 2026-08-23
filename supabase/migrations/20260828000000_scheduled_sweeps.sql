-- Schedule the sweeps that were only ever buttons.
--
-- Nothing in this project scheduled anything. Three jobs that have to run on a
-- clock were routes an admin clicked:
--
--   * claim expiry reminders -- only fire inside a six hour window before a
--     deadline, so a click at the wrong time missed the person entirely and
--     there was no second chance;
--   * the expired-claim sweep -- new, and pointless without a scheduler: it is
--     the thing that makes "accept within 24 hours" true;
--   * the Stripe subscription reconcile -- the only correction for a webhook
--     that never arrived (wrong mode, endpoint added late, retries exhausted);
--   * the KV prune -- also new, and not optional: the rate limiters are keyed
--     by hashed IP, so without a sweep kv_store grows by a row per visitor for
--     ever.
--
-- pg_cron runs them, pg_net posts to the edge function. The shared secret lives
-- in Vault rather than in this file, so the repo never carries it.
--
-- ─── One-time setup, before this is any use ──────────────────────────────────
--
--   1. Pick a secret and set it on the function:
--        Dashboard -> Edge Functions -> Secrets -> CRON_SECRET
--   2. Store the same value here, so pg_cron can send it:
--        select vault.create_secret('<the same value>', 'contynt_cron_secret');
--
-- Until step 2 is done the jobs run and get a 401. That is deliberate: they
-- fail loudly in cron.job_run_details rather than silently doing nothing.
--
-- ─── Checking on them ────────────────────────────────────────────────────────
--
--   select * from cron.job;
--   select * from cron.job_run_details order by start_time desc limit 20;
--   select * from net._http_response order by created desc limit 20;

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- One place that knows the function's address and how to authenticate to it, so
-- the schedules below carry a route name and nothing else.
create or replace function public.contynt_call_sweep(p_path text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_secret text;
  v_request_id bigint;
begin
  select decrypted_secret into v_secret
    from vault.decrypted_secrets
   where name = 'contynt_cron_secret'
   limit 1;

  -- Posted regardless of whether the secret was found. A 401 recorded in
  -- net._http_response is a visible, diagnosable failure; skipping the call
  -- would leave a scheduled job that looks healthy and does nothing.
  select net.http_post(
    url := 'https://kskqipduwovvedcuhwre.supabase.co/functions/v1/make-server-f5961d0c' || p_path,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', coalesce(v_secret, '')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  ) into v_request_id;

  return v_request_id;
end;
$$;

revoke all on function public.contynt_call_sweep(text) from public, anon, authenticated;

-- Unscheduled first so re-running this migration replaces the jobs rather than
-- stacking duplicates beside them.
do $$
declare j text;
begin
  foreach j in array array[
    'contynt-sweep-expired-claims',
    'contynt-claim-expiry-reminders',
    'contynt-stripe-reconcile',
    'contynt-kv-prune'
  ] loop
    if exists (select 1 from cron.job where jobname = j) then
      perform cron.unschedule(j);
    end if;
  end loop;
end $$;

-- Hourly. A claim expires at an arbitrary minute, and an hour is the longest a
-- Feature should sit held by somebody whose window has closed.
select cron.schedule(
  'contynt-sweep-expired-claims', '7 * * * *',
  $$select public.contynt_call_sweep('/admin/claims/sweep-expired')$$
);

-- Every two hours. The reminder only fires inside the six hours before a
-- deadline, so this has to run several times inside that window to catch
-- everyone; the send is stamped per claim, so the extra runs cost nothing.
select cron.schedule(
  'contynt-claim-expiry-reminders', '23 */2 * * *',
  $$select public.contynt_call_sweep('/admin/claims/expiry-reminders')$$
);

-- Daily, early. This is the backstop for a webhook that never arrived, not a
-- primary path, and it walks every business with a Stripe customer.
select cron.schedule(
  'contynt-stripe-reconcile', '41 9 * * *',
  $$select public.contynt_call_sweep('/admin/stripe/sync-subscriptions')$$
);

-- Daily. Expired sessions, spent login codes and the per-IP rate-limit buckets.
-- The buckets are the reason this has to be on a clock rather than on demand.
select cron.schedule(
  'contynt-kv-prune', '13 4 * * *',
  $$select public.contynt_call_sweep('/admin/kv/prune')$$
);
