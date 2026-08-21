# Email setup (Postmark)

Everything in Creator Readiness — the verification send, the Delivered/Bounced
columns, and the 6 digit login codes for both creators and businesses — runs
through one Postmark server.

Checked against the live Postmark account on 2026-08-20. Most of this is
**already done**; what remains is at the bottom.

Check the state at any time in the admin panel: **Creator Readiness → the banner
at the top of the tab**. It asks Postmark directly rather than trusting our own
environment variables, and **Details → Send test** does one real send, which is
the only thing that surfaces an unconfirmed sender signature.

---

## Already done ✅

| | |
|---|---|
| Account | `contynt` |
| Server | `My First Server`, ID `20442101` |
| Domain | `getcontynt.com` — **DKIM verified**, **Return-Path verified** |
| Signature | `team@getcontynt.com` |
| Broadcast stream | Stream ID `broadcast` |
| Transactional stream | Stream ID `outbound` |

Those last three match the code's defaults **exactly**, so `POSTMARK_FROM`,
`POSTMARK_MESSAGE_STREAM` and `POSTMARK_TRANSACTIONAL_STREAM` do not need to be
set at all. Leave them unset and the defaults are already right.

## Blocker: the account is still in Test mode ⚠️

The Postmark header reads **Test mode · We're reviewing your account**. Postmark
reviews every new account by hand, and until it clears:

> Send up to 100 test emails to addresses on the same domain as your Sender
> Signature's domain or verified domain. You can start sending to your customers
> once we review and approve your account.

In practice, **right now only `@getcontynt.com` addresses can receive mail.**
A creator on gmail.com is rejected. That is not something the code can work
around, and it is why a verification blast would fail today even with the token
set.

Postmark quotes **24 hours** (Monday if it lands on a weekend). Status lives at
[account.postmarkapp.com/account/approval/pending](https://account.postmarkapp.com/account/approval/pending).
If it drags, Contact Us → describe the use case: transactional login codes and
opt-in creator notifications for a local creator marketplace, list built from
first-party signups only. Approval usually turns on how clearly you can say the
list is opt-in.

---

## Left to do

### 1. Set the three secrets

Run these yourself — do not paste the token into a chat window. The server token
is at
[Servers → My First Server → API Tokens](https://account.postmarkapp.com/servers/20442101/credentials).

```bash
supabase secrets set POSTMARK_SERVER_TOKEN='<server API token from Postmark>'
```

```bash
supabase secrets set POSTMARK_WEBHOOK_SECRET="$(openssl rand -hex 32)"
```

```bash
supabase secrets set LOGIN_CODE_SALT="$(openssl rand -hex 32)"
```

`secrets list` only prints digests, so **save the webhook secret when you
generate it** — step 2 needs the plaintext. If you lose it, just generate and
set a new one and update Postmark to match.

### 2. Add the delivery webhook to both streams

Without this, sends work but **Delivered** and **Bounced** stay at zero forever
and a dead address is never suppressed.

- [broadcast stream → Webhooks](https://account.postmarkapp.com/servers/20442101/streams/broadcast/webhooks)
- [outbound stream → Webhooks](https://account.postmarkapp.com/servers/20442101/streams/outbound/webhooks)

On each, **Add webhook**:

- **URL**
  `https://kskqipduwovvedcuhwre.supabase.co/functions/v1/make-server-f5961d0c/webhooks/postmark`
- **Use basic auth**: username anything (`postmark`), password the
  `POSTMARK_WEBHOOK_SECRET` from step 1.
- Enable **Delivery**, **Bounce**, **Spam Complaint**, **Open**.

A custom `x-postmark-secret` header carrying the same value works too, if you
would rather rotate a header than a URL.

Open tracking also has to be on for the stream, or no Open events fire.

### 3. Verify — today, before approval

Admin panel → **Creator Readiness**. The banner should flip to **"Email is
live"**. Then **Details → Send test** to an address **@getcontynt.com** — that
is the only domain Postmark will accept until approval. It should arrive.

A test to a gmail address failing right now is *expected*, and the error
Postmark returns will say so.

### 4. Verify — after approval

1. Select one creator (yourself) → **Dry run**. Nothing sends; you see the
   rendered link.
2. **Send verification email** to that one creator. Within a minute the
   **Delivered** count should tick up, which proves the webhook too.
3. Sign in at `/app` with that address to exercise the creator login code, and
   at `/business` for the business one.

The same dry run from the command line:

```bash
ADMIN_SECRET='<your admin secret>' ./scripts/send-verification.sh --dry-run
```

---

## Where the links point

Verification links are `https://getcontynt.com/portal/verify?t=...`, not the
Supabase URL. A link to `kskqipduwovvedcuhwre.supabase.co` inside a message
signed CONTYNT reads like phishing, and the mismatch between the link domain and
the From domain is a small deliverability drag on top of that.

Three pieces hold that up, and they have to move together:

1. `functions/portal/[[path]].ts` — a Cloudflare Pages Function proxying
   `getcontynt.com/portal/*` to the edge function. It is a Function rather than
   a `_redirects` rule because Pages will not proxy to an external origin:
   *"Proxying will only support relative URLs on your site. You cannot proxy
   external domains."* A 30x rule would work but would put the Supabase URL
   straight back in the address bar.
2. `VERIFY_LINK_ORIGIN=https://getcontynt.com` in the Supabase secrets. This is
   the single source for both the emailed link and the action on the resend
   form, so the two cannot disagree.
3. The `/*  /index.html  200` catch-all in `public/_redirects` stays as it is.
   Pages routes to Functions before it consults `_redirects`, and the
   auto-generated `_routes.json` scopes that to `/portal/*`.

**The proxy has to be deployed before the secret is set.** Setting
`VERIFY_LINK_ORIGIN` while `getcontynt.com/portal/*` still falls through to the
SPA would mint links that render the marketing page instead of confirming
anything.

The site is a Direct Upload Pages project (`getcontynt`, production branch
`main`), so pushing to GitHub does **not** deploy it:

```bash
pnpm build && npx wrangler pages deploy dist --project-name=getcontynt --branch=main
```

Wrangler compiles `functions/` from the working directory into the deployment —
look for "Compiled Worker successfully" and "Uploading Functions bundle" in the
output. If those two lines are missing, the proxy did not ship and the links are
broken.

---

## What is deliberately not automatic

- **A send is never repeated within 24 hours.** `verify_email_sent_at` is
  stamped only after Postmark accepts the message, so a failed send does not
  burn the cooldown and re-running the script after a partial failure is safe.
- **Only hard bounces suppress.** A full mailbox is a bad afternoon, not a dead
  address.
- **An Open never advances `verification_status`.** Apple Mail Privacy
  Protection prefetches images, so an open means a mail client touched the
  message, not that a person read it.
- **An Open never advances `verification_status`** (see above), and the same
  goes for a link open: `verify_link_opened_at` is recorded, but only the
  confirm form moves a creator to `confirmed`.
