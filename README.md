# CONTYNT

Connects Instagram Reels creators with local businesses that pay per post.
San Francisco, Los Angeles and New York City.

Live at [getcontynt.com](https://getcontynt.com).

## Layout

```
src/app/            the site and both portals, one React SPA
  components/       marketing sections, CreatorPortal, BusinessPortal, Analytics (admin)
  lib/              shared rules — featureQuota is the one worth reading first
supabase/
  functions/        the whole backend, one Deno edge function
  migrations/       schema, applied with `supabase db push`
functions/portal/   Cloudflare Pages Function proxying getcontynt.com/portal/* to
                    the edge function, so verification links are not supabase.co URLs
public/             _headers (CSP and friends), _redirects, robots, sitemap, og-image
```

Routing is `window.location.pathname` in `src/app/App.tsx`, not a router:
`/app` is the creator portal, `/business` the owner portal, `/portal/*` the
server-rendered verification pages, and a bare six-character path is an
Ambassador card scan.

## Running it

```bash
pnpm install
pnpm dev
```

`pnpm build` typechecks first and refuses to emit if that fails — esbuild
strips types without checking them, so this is the only thing standing between
a type error and production. `pnpm typecheck` runs it alone.

The edge function is Deno and is **not** covered by that typecheck. If Deno is
installed:

```bash
deno check supabase/functions/make-server-f5961d0c/index.tsx
```

## Deploying

Two independent halves. Ship both when a change spans them.

```bash
# frontend — Cloudflare Pages, direct upload
pnpm build && npx wrangler pages deploy dist --project-name=getcontynt --branch=main

# backend
supabase functions deploy make-server-f5961d0c
supabase db push
```

## Secrets

Set in Dashboard → Edge Functions → Secrets. None live in this repo.

`ADMIN_SECRET`, `POSTMARK_SERVER_TOKEN`, `POSTMARK_WEBHOOK_SECRET`,
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `GOOGLE_PLACES_KEY`,
`LOGIN_CODE_SALT`, `VERIFY_LINK_ORIGIN`, `CRON_SECRET`.

`CRON_SECRET` is the one with a second half: pg_cron sends it, and reads its
copy from Vault. Both must match or every scheduled job returns 401.

```sql
select vault.create_secret('<same value as CRON_SECRET>', 'contynt_cron_secret');
```

## Scheduled work

Four pg_cron jobs (see `migrations/20260828000000_scheduled_sweeps.sql`) release
expired claims, send claim-deadline reminders, reconcile subscriptions against
Stripe, and prune the KV store. Checking on them:

```sql
select j.jobname, d.status, d.start_time
  from cron.job_run_details d join cron.job j on j.jobid = d.jobid
 order by d.start_time desc limit 10;

-- cron 'succeeded' only means the SQL ran; this is whether the call authenticated
select status_code, created, left(content::text, 200)
  from net._http_response order by created desc limit 5;
```

## Known gaps

- **The baseline migration is an empty stub.** `supabase db reset`, or any
  replay from an empty database, will not recreate the original schema and
  every migration after it will fail. The only copy is the live database.
  Fixing it needs Docker and `supabase db dump --schema public`.
- **Portal tokens revoke but do not rotate.** Signing out kills the session,
  and signing back in restores the same token string — because claims,
  submissions and earnings are all keyed by it. Real rotation needs those
  tables re-keyed to `creator_id` first.
