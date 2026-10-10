import { Hono } from "npm:hono@4";
import { cors } from "npm:hono@4/cors";
import { logger } from "npm:hono@4/logger";
import { createClient } from "jsr:@supabase/supabase-js@2.49.8";
import * as kv from "./kv_store.tsx";

const app = new Hono();
app.use("*", logger(console.log));
app.use("/*", cors({ origin: "*", allowHeaders: ["Content-Type", "Authorization", "x-admin-token", "x-cron-secret"], allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"], exposeHeaders: ["Content-Length"], maxAge: 600 }));

const db = () => createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

// Supabase returns failures on the result object rather than throwing, so an
// unchecked write looks identical to a successful one. A missing column made
// every feature-completion write fail silently while still reporting success —
// route writes that matter through here so that can't happen unnoticed.
async function must<T extends { error: any }>(label: string, q: PromiseLike<T>): Promise<T> {
  const res = await q;
  if (res.error) {
    console.error(`[db] ${label} failed:`, res.error.message ?? res.error);
    throw new Error(`${label}: ${res.error.message ?? "database error"}`);
  }
  return res;
}

// ─── Creator balances ─────────────────────────────────────────────────────────
// Balances are derived from the two ledger tables rather than stored, so they
// cannot drift out of sync with the rows that justify them.
//
//   totalEarned = credits - paid out      (this is what "Mark as Paid" zeroes)
//   pending     = requested, not yet paid
//   available   = credits - paid - requested
function parseAmount(v: any): number {
  if (typeof v === "number") return isFinite(v) ? v : 0;
  const n = parseFloat(String(v ?? "").replace(/[^0-9.]/g, ""));
  return isFinite(n) ? n : 0;
}

async function creatorBalance(token: string) {
  const supabase = db();
  const [earnRes, payRes] = await Promise.all([
    supabase.from("creator_earnings_f5961d0c").select("amount").eq("creator_token", token),
    supabase.from("creator_payout_requests_f5961d0c").select("amount, status").eq("creator_token", token),
  ]);
  const credits = (earnRes.data ?? []).reduce((s: number, r: any) => s + parseAmount(r.amount), 0);
  let paid = 0, requested = 0;
  for (const r of (payRes.data ?? [])) {
    if (r.status === "paid") paid += parseAmount(r.amount);
    else if (r.status === "requested") requested += parseAmount(r.amount);
  }
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    // Balance still owed to the creator, in-flight requests included.
    totalEarned: round(Math.max(0, credits - paid)),
    // Requested and waiting to be sent.
    pendingEarnings: round(requested),
    // Free to cash out right now.
    availableEarnings: round(Math.max(0, credits - paid - requested)),
    // Lifetime figures, for the wallet breakdown. These only ever go up, so
    // they are the honest answer to "how much have I made with CONTYNT".
    lifetimeEarned: round(credits),
    lifetimePaid: round(paid),
  };
}

// Same derivation as creatorBalance, but for every creator at once — the admin
// list needs all of them and per-creator queries would be N round trips.
async function allCreatorBalances(): Promise<Record<string, any>> {
  const supabase = db();
  const [earnRes, payRes] = await Promise.all([
    supabase.from("creator_earnings_f5961d0c").select("creator_token, amount"),
    supabase.from("creator_payout_requests_f5961d0c").select("creator_token, amount, status"),
  ]);
  const acc: Record<string, { credits: number; paid: number; requested: number }> = {};
  const slot = (t: string) => (acc[t] ??= { credits: 0, paid: 0, requested: 0 });
  for (const r of (earnRes.data ?? [])) slot(r.creator_token).credits += parseAmount(r.amount);
  for (const r of (payRes.data ?? [])) {
    if (r.status === "paid") slot(r.creator_token).paid += parseAmount(r.amount);
    else if (r.status === "requested") slot(r.creator_token).requested += parseAmount(r.amount);
  }
  const round = (n: number) => Math.round(n * 100) / 100;
  const out: Record<string, any> = {};
  for (const [t, v] of Object.entries(acc)) {
    out[t] = {
      totalEarned: round(Math.max(0, v.credits - v.paid)),
      pendingEarnings: round(v.requested),
      availableEarnings: round(Math.max(0, v.credits - v.paid - v.requested)),
    };
  }
  return out;
}

// Row ids, not credentials. Math.random is fine here -- nothing is guarded by
// guessing a feature id, and these strings are stored, never presented as
// proof of anything.
function uid(prefix = "") {
  return `${prefix}${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

// token32() lived here: 8 characters drawn from Math.random, used to mint the
// private admin link and the creator and business portal tokens. Three real
// credentials from a PRNG that is not one -- V8's generator gives up its state
// to anyone who collects a few outputs, so a single leaked portal token was
// leverage on the admin link beside it, and 8 characters was thin regardless.
//
// Everything now goes through secureToken(), which draws from
// crypto.getRandomValues. Tokens already minted the old way keep working: they
// are looked up by KV key, so nothing about their format is load bearing.

// ─── Admin auth ───────────────────────────────────────────────────────────────
// ADMIN_SECRET is set in Dashboard → Project Settings → Edge Functions → Secrets.
// The browser never holds it: /admin/login trades it for a short-lived session token.
const ADMIN_SECRET = Deno.env.get("ADMIN_SECRET") || "";
const SESSION_HOURS = 12;

async function validAdminToken(token: string): Promise<boolean> {
  if (!token) return false;
  const session = await kv.get(`admin_session_${token}`).catch(() => null);
  if (session?.expiresAt && new Date(session.expiresAt) > new Date()) return true;
  // Private admin links (/admin/generate-link) remain a valid way in.
  const priv = await kv.get("admin_private_token").catch(() => null);
  return !!priv?.token && priv.token === token;
}

// Creator portal links are bearer secrets: possession of the token is the only
// credential. Every route that reads or writes a creator's rows must check it,
// otherwise any caller can act as an arbitrary creator.
// Impersonation is full access on purpose: an admin viewing a creator's portal
// can claim Features, submit Reels and request payouts exactly as the creator
// would. Writes made this way are indistinguishable from the creator's own, so
// the audit trail is the admin_impersonated event recorded in creator_events
// when the token is minted -- it says an admin held a session for that creator,
// but not which rows they touched.

async function creatorFromToken(token: string): Promise<any | null> {
  if (!token) return null;
  const data = await kv.get(`ctoken_${token}`).catch(() => null);
  if (!data) return null;
  // Only impersonation tokens carry expiresAt. Creator sessions are open ended,
  // so an absent expiry means "does not expire" rather than "already expired".
  if (data.expiresAt && new Date(data.expiresAt) <= new Date()) {
    await kv.del(`ctoken_${token}`).catch(() => {});
    return null;
  }
  return data;
}

// Business portal tokens work the same way, so they expire the same way: a real
// business link has no expiresAt and lives until it is regenerated, while an
// admin impersonation token carries one and stops working when it passes.
async function businessFromToken(token: string): Promise<any | null> {
  if (!token) return null;
  const data = await kv.get(`biztoken_${token}`).catch(() => null);
  if (!data) return null;
  if (data.expiresAt && new Date(data.expiresAt) <= new Date()) {
    await kv.del(`biztoken_${token}`).catch(() => {});
    return null;
  }
  return data;
}

// These two ARE the auth handshake, so they cannot require auth themselves.
const ADMIN_OPEN = new Set([
  "/make-server-f5961d0c/admin/login",
  "/make-server-f5961d0c/admin/verify",
]);

// ─── Scheduled sweeps ─────────────────────────────────────────────────────────
// Nothing in this project scheduled anything: the expiry sweeps and the Stripe
// reconcile were buttons in the admin dashboard, so a reminder went out only if
// somebody happened to click within the six hours before a deadline, and a
// webhook that never arrived stayed uncorrected until a human noticed.
//
// A scheduler cannot hold an admin session, so these specific routes -- and only
// these -- also accept a shared secret. They are all idempotent sweeps that take
// no parameters and expose no data, which is what makes that safe; nothing that
// reads a person's details or moves money is on this list.
//
// CRON_SECRET is set in Dashboard -> Edge Functions -> Secrets, and the pg_cron
// jobs in migration 20260828000000 read their copy from Vault.
const CRON_SECRET = Deno.env.get("CRON_SECRET") || "";
const CRON_CALLABLE = new Set([
  "/make-server-f5961d0c/admin/claims/sweep-expired",
  "/make-server-f5961d0c/admin/claims/expiry-reminders",
  "/make-server-f5961d0c/admin/stripe/sync-subscriptions",
  "/make-server-f5961d0c/admin/kv/prune",
]);

const adminGuard = async (c: any, next: any) => {
  const path = new URL(c.req.url).pathname;
  if (ADMIN_OPEN.has(path)) return next();
  const cronHeader = c.req.header("x-cron-secret") || "";
  if (cronHeader && CRON_SECRET && CRON_CALLABLE.has(path)
      && timingSafeEqual(cronHeader, CRON_SECRET)) {
    return next();
  }
  if (!ADMIN_SECRET) return c.json({ error: "Server is missing ADMIN_SECRET" }, 500);
  if (!(await validAdminToken(c.req.header("x-admin-token") || ""))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return next();
};

// Registered before the routes below so it actually wraps them.
app.use("/make-server-f5961d0c/admin/*", adminGuard);
app.use("/make-server-f5961d0c/signups", adminGuard);
// Was reachable with nothing but the anon key, which ships inside the client
// bundle: it returns signup and visitor totals plus the last 50 pageviews with
// visitor id, user agent, referrer and geo. Its only caller is the admin
// dashboard. Guarded by exact path, not /analytics/*, because the pageview
// write beside it is posted by every visitor and must stay open.
app.use("/make-server-f5961d0c/analytics/stats", adminGuard);
app.use("/make-server-f5961d0c/business-signups", adminGuard);
// These mint creator/business portal tokens — admin-only.
app.use("/make-server-f5961d0c/creator-links", adminGuard);
app.use("/make-server-f5961d0c/creator-links/*", adminGuard);
app.use("/make-server-f5961d0c/business-links", adminGuard);
app.use("/make-server-f5961d0c/business-links/*", adminGuard);
// Only the admin panel closes out a feature; it writes to any feature by id.
app.use("/make-server-f5961d0c/feature-complete", adminGuard);

// ADMIN_SECRET is a password compared in one shot, and /admin/verify answers
// yes or no about a token, so both are oracles worth walking -- and CORS is
// open, so a browser anywhere could do the walking. Counted per hashed IP in a
// fixed window: cheap, approximately right, and it does not turn the store into
// a list of addresses that tried.
const ADMIN_MAX_ATTEMPTS = 8;
const ADMIN_WINDOW_MIN = 15;

async function adminAttemptLimited(c: any, bucket: string): Promise<boolean> {
  const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "";
  // An unidentifiable caller shares one bucket rather than being waved through.
  const key = `adminrl_${bucket}_${ip ? await hashIp(ip) : "unknown"}`;
  const rec = await kv.get(key).catch(() => null);
  const now = Date.now();
  const fresh = !rec?.windowStart || now - new Date(rec.windowStart).getTime() > ADMIN_WINDOW_MIN * 60e3;
  const count = fresh ? 0 : (rec?.count ?? 0);
  if (count >= ADMIN_MAX_ATTEMPTS) return true;
  await kv.set(key, {
    windowStart: fresh ? new Date(now).toISOString() : rec.windowStart,
    count: count + 1,
    expiresAt: new Date(now + ADMIN_WINDOW_MIN * 60e3).toISOString(),
  }).catch(() => {});
  return false;
}

async function clearAdminAttempts(c: any, bucket: string) {
  const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "";
  await kv.del(`adminrl_${bucket}_${ip ? await hashIp(ip) : "unknown"}`).catch(() => {});
}

app.post("/make-server-f5961d0c/admin/login", async (c) => {
  try {
    if (!ADMIN_SECRET) return c.json({ error: "Server is missing ADMIN_SECRET" }, 500);
    if (await adminAttemptLimited(c, "login")) {
      return c.json({ error: "Too many attempts. Try again in a few minutes." }, 429);
    }
    const { password } = await c.req.json();
    // Constant time, so the comparison cannot be walked a character at a time.
    if (!password || !timingSafeEqual(String(password), ADMIN_SECRET)) {
      return c.json({ error: "Incorrect password" }, 401);
    }
    await clearAdminAttempts(c, "login");
    const token = secureToken(32);
    const expiresAt = new Date(Date.now() + SESSION_HOURS * 60 * 60 * 1000).toISOString();
    await kv.set(`admin_session_${token}`, { createdAt: new Date().toISOString(), expiresAt });
    return c.json({ success: true, token, expiresAt });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// ─── Ambassador ───────────────────────────────────────────────────────────────
const SITE_ORIGIN = Deno.env.get("SITE_ORIGIN") || "https://getcontynt.com";
const REFERRAL_REWARD = 25;

// Codes are anonymous. The generator that derived them from the Instagram
// handle (JANEDOE123) was removed rather than left unused: the whole point of
// the rotation migration is that no code identifies its creator, and a handy
// handle-shaped generator sitting here is how that quietly comes back.
// See anonCode() for the replacement.
const referralUrlFor = (code: string) => `${SITE_ORIGIN}/?ref=${code}`;

async function ambassadorForToken(token: string) {
  const creatorData = await creatorFromToken(token);
  if (!creatorData?.creatorId) return { creatorData: null, ambassador: null };
  const { data } = await db().from("ambassadors_f5961d0c").select("*").eq("creator_id", creatorData.creatorId).maybeSingle();
  return { creatorData, ambassador: data ?? null };
}

function ambassadorPayload(a: any) {
  if (!a) return null;
  return {
    ambassadorId: a.ambassador_id, creatorId: a.creator_id,
    creatorInstagram: a.creator_instagram || "",
    referralCode: a.referral_code, referralUrl: a.referral_url,
    enabled: !!a.enabled_status, createdAt: a.created_at,
  };
}

// Creator-facing: current ambassador state plus referral performance.
app.get("/make-server-f5961d0c/creator-portal/ambassador", async (c) => {
  try {
    const token = c.req.query("t");
    if (!token) return c.json({ error: "Token required" }, 400);
    const { creatorData, ambassador } = await ambassadorForToken(token);
    if (!creatorData) return c.json({ error: "Invalid or expired link" }, 401);
    if (!ambassador) return c.json({ enabled: false, ambassador: null, referrals: [], stats: null, ambassadorCode: null });
    // The creator's own code. Backfilled here as well as on opt-in so an
    // ambassador who predates the per-creator code still gets one.
    const ambassadorCode = await ensureAmbassadorCode(String(creatorData.creatorId));

    const { data: refs } = await db().from("ambassador_referrals_f5961d0c")
      .select("*").eq("ambassador_id", ambassador.ambassador_id).order("created_at", { ascending: false });
    const rows = refs ?? [];
    const stats = {
      businessesReferred: rows.length,
      // Anything not yet paid is pending, rather than matching the literal
      // "pending": the referral insert leaves reward_status to the column
      // default, so a business that just signed up under the link would drop
      // out of this count if the default is ever null or renamed -- and the
      // creator would see nothing for a referral they had just made.
      pendingReferrals: rows.filter((r: any) => r.reward_status !== "paid").length,
      activeBusinesses: rows.filter((r: any) => !!r.subscription_active_at).length,
      rewardsEarned: rows.filter((r: any) => r.reward_status === "paid").reduce((s: number, r: any) => s + parseAmount(r.reward_amount), 0),
      rewardsPending: rows.filter((r: any) => r.reward_status !== "paid").reduce((s: number, r: any) => s + parseAmount(r.reward_amount), 0),
    };
    return c.json({
      enabled: !!ambassador.enabled_status,
      ambassador: ambassadorPayload(ambassador),
      ambassadorCode,
      cardUrl: cardUrlFor(ambassadorCode),
      stats,
      referrals: rows.map((r: any) => ({
        id: r.id, businessName: r.business_name, businessEmail: r.business_email,
        status: r.status, rewardStatus: r.reward_status,
        rewardAmount: parseAmount(r.reward_amount), createdAt: r.created_at,
      })),
    });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// Creator opts in. Idempotent — re-enabling an existing ambassador keeps the
// same referral code, so printables and QR codes already handed out stay valid.
app.post("/make-server-f5961d0c/creator-portal/ambassador/enable", async (c) => {
  try {
    const { token: rawToken } = await c.req.json();
    if (!rawToken) return c.json({ error: "token required" }, 400);
    const creatorData = await creatorFromToken(rawToken);
    if (!creatorData?.creatorId) return c.json({ error: "Invalid or expired link" }, 401);
    // Impersonation writes must land on the creator's own rows, not on the
    // short lived admin token, which expires in an hour and is in no index.
    const token = creatorData.realToken ?? rawToken;

    // Delegates to the single consent writer so this route cannot leave
    // enabled_status set while ambassador_opted_in stays false.
    const { data: creator } = await db().from("creator_signups_f5961d0c")
      .select("*").eq("id", creatorData.creatorId).maybeSingle();
    if (!creator) return c.json({ error: "Creator not found" }, 404);

    const wasOptedIn = !!creator.ambassador_opted_in;
    const created = await setAmbassadorOptIn(creator, true);
    // The creator's own code, minted here and reused everywhere after.
    const ambassadorCode = await ensureAmbassadorCode(creator.id);
    if (!wasOptedIn) await logCreatorEvent(creator.id, "ambassador_opted_in", { source: "enable" });
    return c.json({ success: true, ambassadorCode, ambassador: ambassadorPayload(created) });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// Public: who does this referral code belong to? Drives the landing page.
app.get("/make-server-f5961d0c/referral/:code", async (c) => {
  try {
    const code = c.req.param("code");
    const data = await ambassadorByAnyCode(code);
    if (!data || !data.enabled_status) return c.json({ valid: false });

    // The open is recorded here because this is the only call the landing page
    // has to make -- it cannot render without knowing whose code it is, so a
    // view and this request are the same event.
    //
    // Never allowed to fail the page. A link that 500s because a counter could
    // not be written costs a referral; a lost row costs a number.
    try {
      const selfToken = c.req.query("t") || "";
      let isSelfView = false;
      if (selfToken) {
        const cd = await creatorFromToken(selfToken);
        isSelfView = !!cd?.creatorId && String(cd.creatorId) === String(data.creator_id);
      }
      const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "";
      const ipHash = ip ? await hashIp(ip) : null;
      if (isSelfView || !(await linkViewRateLimited(String(data.referral_code || code), ipHash))) {
        await db().from("ambassador_link_views_f5961d0c").insert({
          referral_code: String(data.referral_code || code),
          ip_hash: ipHash,
          user_agent: c.req.header("user-agent") || "",
          is_self_view: isSelfView,
        });
      }
    } catch (e: any) { console.error("[link-view] not recorded:", e?.message ?? e); }

    // Same key the scan page gets. Both are in-person signups; the address
    // behind a Places pick is the only place either flow learns a city.
    return c.json({
      valid: true, referralCode: data.referral_code,
      creatorInstagram: data.creator_instagram || "",
      placesKey: Deno.env.get("GOOGLE_PLACES_KEY") || "",
    });
  } catch { return c.json({ valid: false }); }
});

// Public: a referred business submits its name and email.
//
// This must never dead-end — an owner standing in their shop with the creator
// should always land in the portal. So an existing business is matched and
// linked, and anything unmatched is created rather than rejected.
app.post("/make-server-f5961d0c/referral/:code/business", async (c) => {
  try {
    const code = c.req.param("code");
    const { businessName, businessEmail, instagram: instagramRaw, city: cityRaw,
            preferredContact: contactRaw, placeId: placeIdRaw, placeAddress: placeAddressRaw } = await c.req.json();
    const preferredContact = String(contactRaw ?? "").trim().slice(0, 40);
    const placeId = String(placeIdRaw ?? "").trim().slice(0, 200) || null;
    const placeAddress = String(placeAddressRaw ?? "").trim().slice(0, 300) || null;
    // The form no longer asks for a city. Google's address is where it comes
    // from now, on the same terms as the scan page: read it if the shape holds,
    // otherwise leave it empty rather than guess.
    const city = String(cityRaw ?? "").trim().slice(0, 80) || cityFromFormattedAddress(placeAddressRaw);
    if (!businessName || !businessEmail) return c.json({ error: "Business name and email are required" }, 400);
    // Optional on the wire so an older client still works, but rejected when
    // present and unusable rather than stored as junk.
    const handle = instagramRaw === undefined || String(instagramRaw).trim() === ""
      ? "" : normalizeHandle(instagramRaw);
    if (handle === null) return c.json({ error: "Enter a valid Instagram handle." }, 400);

    const amb = await ambassadorByAnyCode(code);
    if (!amb || !amb.enabled_status) return c.json({ error: "This referral link is no longer active" }, 404);
    // Attribution is always stored under the ambassador's own referral code, so
    // a signup that arrived by card is not filed under a second string.
    const attribCode = amb.referral_code || code;

    const email = String(businessEmail).trim().toLowerCase();
    const name = String(businessName).trim();

    // Match on email first (the stronger key), then on the handle, then on the
    // name. The handle sits above the name because it is what the main signup
    // form keys on: a business that signed up there and is now being referred
    // has to land on the same row, or its Features and quota split in two.
    let biz: any = null;
    if (placeId) {
      // Ahead of email: two people at one business use two addresses, but the
      // place is the place. The scan lead route already matches this way.
      const { data } = await db().from("business_signups_f5961d0c")
        .select("*").eq("place_id", placeId).maybeSingle();
      biz = data ?? null;
    }
    if (!biz) {
      const byEmail = await db().from("business_signups_f5961d0c").select("*").ilike("email", email).limit(1);
      biz = byEmail.data?.[0] ?? null;
    }
    if (!biz && handle) {
      // Compared normalised in memory for the same reason the signup form does
      // it: stored values include "@name" and full profile URLs, and Instagram
      // handles are case insensitive, so neither matches in SQL.
      const { data: all } = await db().from("business_signups_f5961d0c").select("*");
      const wanted = handle.toLowerCase();
      biz = (all ?? []).find((r: any) =>
        (normalizeHandle(String(r.instagram ?? "")) ?? "").toLowerCase() === wanted) ?? null;
    }
    if (!biz) {
      const byName = await db().from("business_signups_f5961d0c").select("*").ilike("business_name", name).limit(1);
      biz = byName.data?.[0] ?? null;
    }

    let createdBusiness = false;
    if (!biz) {
      const { data: made, error } = await db().from("business_signups_f5961d0c").insert({
        business_name: name, email, instagram: handle, city,
        address: placeAddress || "",
        place_id: placeId, place_address: placeAddress,
        preferred_contact: preferredContact,
        referral_code: attribCode, referral_source: "ambassador", referred_by_creator: amb.creator_id,
      }).select("*").single();
      if (error) throw error;
      biz = made; createdBusiness = true;
    } else if (preferredContact && !String(biz.preferred_contact ?? "").trim()) {
      // Gap filled, answer never overwritten -- the same rule the handle and
      // the city below follow.
      await db().from("business_signups_f5961d0c")
        .update({ preferred_contact: preferredContact }).eq("id", biz.id);
      biz = { ...biz, preferred_contact: preferredContact };
    }
    if (biz && !createdBusiness && handle && !String(biz.instagram ?? "").trim()) {
      // Same rule as the city below: fill a gap, never overwrite an answer.
      await db().from("business_signups_f5961d0c").update({ instagram: handle }).eq("id", biz.id);
      biz = { ...biz, instagram: handle };
    }
    if (biz && !createdBusiness && placeId && !biz.place_id) {
      await db().from("business_signups_f5961d0c")
        .update({ place_id: placeId, place_address: placeAddress }).eq("id", biz.id);
      biz = { ...biz, place_id: placeId, place_address: placeAddress };
    }
    if (biz && !createdBusiness && city && !biz.city) {
      // An existing row created without one -- a scan lead, say -- gets the
      // city filled in, but an answer already on file is never overwritten.
      await db().from("business_signups_f5961d0c").update({ city }).eq("id", biz.id);
      biz = { ...biz, city };
    }
    // Attribution already on file comes in two shapes: a referral link sets a
    // code and a creator, a card scan sets a creator and no code at all. This
    // used to guard on the code alone, so a scanned lead read as unattributed
    // and the next link click reassigned it to a different creator -- the exact
    // thing the comment said it would not do.
    //
    // Any of the three fields counts as attributed, and they are written
    // together or not at all: filling a missing code from a second creator
    // while the first creator stays in referred_by_creator would leave a pair
    // that disagrees about who earned it.
    const alreadyAttributed = !!(biz.referral_code || biz.referred_by_creator || biz.referral_source);
    if (biz && !createdBusiness && !alreadyAttributed) {
      const attribution = {
        referral_code: attribCode, referral_source: "ambassador", referred_by_creator: amb.creator_id,
      };
      await db().from("business_signups_f5961d0c").update(attribution).eq("id", biz.id);
      biz = { ...biz, ...attribution };
    }

    // One referral row per (ambassador, business).
    const { data: existing } = await db().from("ambassador_referrals_f5961d0c")
      .select("id").eq("ambassador_id", amb.ambassador_id).eq("business_id", biz.id).limit(1);
    if (!existing?.length) {
      const now = new Date().toISOString();
      await must("referral: record", db().from("ambassador_referrals_f5961d0c").insert({
        ambassador_id: amb.ambassador_id,
        creator_id: amb.creator_id,
        creator_instagram: amb.creator_instagram || "",
        referral_code: attribCode,
        referral_url: amb.referral_url,
        business_id: biz.id, business_name: biz.business_name, business_email: biz.email,
        referral_source: "ambassador",
        status: createdBusiness ? "business_created" : "lead_created",
        reward_amount: REFERRAL_REWARD,
        business_created_at: createdBusiness ? now : null,
      }));
    }

    // Deliberately no portal token in this response. The form matches an
    // existing business by email, handle or place, so handing back a session
    // for whatever it matched would let anyone who knows a business's email
    // type it here and be signed in as them. A code to that address proves the
    // person filling this in can read the inbox it belongs to.
    await issueLoginCode({
      audience: "business", addr: email, to: biz.email || email, subjectId: biz.id,
      log: (type, payload) => logBusinessEvent(biz.id, type, payload),
    });
    return c.json({ success: true, businessId: biz.id, businessCreated: createdBusiness, needsVerification: true });
  } catch (e: any) { return c.json({ error: "Could not complete signup", details: e.message }, 500); }
});

// ─── Crypto helpers ───────────────────────────────────────────────────────────
// The only token mint in this file. Everything that is presented as proof of
// anything -- admin sessions, the private admin link, creator and business
// portal tokens, verification links -- comes from here. Tokens issued by the
// retired token32() are still live in the wild and keep working: KV looks them
// up by key, so nothing about their format is load bearing.
function secureToken(bytes = 32): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// The card and referral alphabet. 30 characters: I, L, O and U are omitted so a
// handwritten or verbally relayed code cannot be misread. Kept identical to the
// CHECK constraint in the migration, which is the real enforcement point.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";

function anonCode(len = 6): string {
  // 256 is not a multiple of 30, so a bare byte % 30 would make the first six
  // letters ~20% more likely than the rest. Reject bytes at or above 240.
  const n = CODE_ALPHABET.length;
  const bound = 256 - (256 % n);
  const buf = new Uint8Array(1);
  let out = "";
  while (out.length < len) {
    crypto.getRandomValues(buf);
    if (buf[0] < bound) out += CODE_ALPHABET[buf[0] % n];
  }
  return out;
}

// The verify token carries 256 bits, so a timing attack on the lookup is not a
// practical threat. This makes the *comparison* constant time regardless; the
// indexed lookup that precedes it cannot be, and pretending otherwise would be
// worse than saying so.
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a), bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < Math.max(ab.length, bb.length); i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

// ─── Feature gating ───────────────────────────────────────────────────────────
// A Feature can carry early_access_until. Confirmed creators see it straight
// away; everyone else only once that timestamp passes. Features without the
// column set are visible to everyone, so this is inert until an admin uses it.
const EARLY_ACCESS_HOURS = 24;

function visibleToCreator(feature: any, confirmed: boolean): boolean {
  if (!feature?.early_access_until) return true;
  if (confirmed) return true;
  return new Date(feature.early_access_until) <= new Date();
}

async function creatorIsConfirmed(creatorId: string | undefined): Promise<boolean> {
  if (!creatorId) return false;
  const { data } = await db().from("creator_signups_f5961d0c")
    .select("verification_status").eq("id", creatorId).maybeSingle();
  return data?.verification_status === "confirmed";
}

// ─── Creator verification ─────────────────────────────────────────────────────
// How long a selected creator has to accept before the Feature goes back.
const ACCEPTANCE_HOURS = 24;
// The other half of the same clock: 24 hours to accept, then this long to film
// and submit. Module scope rather than inside accept-feature, because the
// reminder sweep, the portal's fallback and the copy in both all have to agree
// with it, and a constant buried in one route handler is easy to change on its
// own.
const CLAIM_DAYS = 14;
// How close to a deadline a reminder goes out, and how far past it is still
// worth reminding -- a sweep that runs late should not skip somebody silently.
const REMIND_WITHIN_HOURS = 6;

const VERIFY_DAYS = 90;
// Short, because this is a person who just told us their link does not work.
// Long enough that a public form cannot be used to mail somebody repeatedly.
const RESEND_COOLDOWN_MIN = 10;
// Where the tokenized link points, and the origin every page served under
// /portal builds its own URLs from -- the resend form below posts back through
// whichever of the two origins minted the link, so the two cannot disagree.
//
// In production this is https://getcontynt.com, proxied to this function by the
// Pages Function in functions/portal/[[path]].ts. A link to supabase.co inside
// an email signed CONTYNT reads like phishing. The default is the function's own
// URL, so a deployment without that proxy still works.
const VERIFY_ORIGIN = Deno.env.get("VERIFY_LINK_ORIGIN") || `${Deno.env.get("SUPABASE_URL") || ""}/functions/v1/make-server-f5961d0c`;
const verifyLinkFor = (t: string) => `${VERIFY_ORIGIN}/portal/verify?t=${encodeURIComponent(t)}`;

// One-click unsubscribe for the announcement stream. Gmail and Yahoo both
// require a working List-Unsubscribe on bulk mail now, and a broadcast without
// one is a spam complaint waiting to happen: the only control left to a reader
// is the "report spam" button, and that is charged against the sending domain
// rather than against the message.
//
// Signed rather than stored, so nothing has to be issued, kept or expired. The
// digest covers the creator id under a purpose string, which also stops it
// being replayed against any other route signing with the same salt.
async function unsubSigFor(creatorId: string) {
  const salt = Deno.env.get("LOGIN_CODE_SALT") || ADMIN_SECRET || "contynt";
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:unsubscribe:${creatorId}`));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}
const unsubLinkFor = async (creatorId: string) =>
  `${VERIFY_ORIGIN}/portal/unsubscribe?c=${encodeURIComponent(creatorId)}&s=${await unsubSigFor(creatorId)}`;

// Served to the client from /creator-portal/confirm-data rather than duplicated
// in the frontend bundle: the server validates against this list, so the form
// and the validator can never drift apart.
const SF_NEIGHBORHOODS = [
  "Bernal Heights", "Castro", "Chinatown", "Cole Valley", "Dogpatch", "Excelsior",
  "Fillmore", "Financial District", "Glen Park", "Haight", "Hayes Valley",
  "Inner Richmond", "Inner Sunset", "Marina", "Mission", "Mission Bay",
  "Nob Hill", "Noe Valley", "North Beach", "Outer Richmond", "Outer Sunset",
  "Pacific Heights", "Potrero Hill", "Presidio", "Russian Hill", "SoMa",
  "Tenderloin", "West Portal",
];

// City is written in two shapes by two halves of the funnel: the signup forms
// save a slug ("san-francisco"), while scan leads and referral signups save
// whatever Google's address yields ("San Francisco"). Nothing reconciled them,
// so any comparison between a creator's city and a Feature's would have missed
// on format alone.
//
// Stored values are deliberately left as they are -- cityLabel() already
// renders both, and rewriting live rows to suit a comparison is the wrong way
// round. This is the form everything *compares* on.
function citySlug(raw: any): string {
  return String(raw ?? "")
    .trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Is this Feature in the creator's market?
//
// Fails open in both directions, on purpose. A creator we cannot place, or a
// Feature with no city on it, is a gap in the data rather than a reason to hide
// paid work from somebody -- and an empty city is visible to an admin, where a
// Feature silently withheld from every creator would not be.
function featureInCreatorCity(feature: any, creatorCity: any): boolean {
  const want = citySlug(creatorCity);
  const have = citySlug(feature?.city);
  if (!want || !have) return true;
  return want === have;
}

// Google's formattedAddress is the only place a scan lead carries a location,
// and city is what Feature matching runs on. The shape is reliably
// "street, city, region postcode, country", so the city is the second field
// from the front -- taken from the front rather than counting back, because the
// tail varies: some addresses carry no postcode, some no country.
//
// Returns "" when the shape does not hold. An empty city is a gap an admin can
// see and fill; a wrong one silently files the business in the wrong market.
function cityFromFormattedAddress(raw: any): string {
  const parts = String(raw ?? "").split(",").map(p => p.trim()).filter(Boolean);
  if (parts.length < 3) return "";
  const city = parts[1];
  // A house number or a postcode in this slot means the address was not in the
  // expected shape, so nothing is guessed from it.
  if (!city || /\d/.test(city)) return "";
  return city;
}

// Accepts "@jane", "jane", "instagram.com/jane/", "https://www.instagram.com/jane?hl=en".
// Returns null when what is left is not a legal handle, so the caller can reject
// rather than silently storing garbage.
function normalizeHandle(raw: string): string | null {
  let h = String(raw ?? "").trim();
  h = h.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/^instagram\.com\//i, "");
  h = h.replace(/[?#].*$/, "").replace(/\/+$/, "").replace(/^@+/, "").trim();
  return /^[A-Za-z0-9._]{1,30}$/.test(h) ? h : null;
}

// Stored lowercased because every lookup that matters -- the resend form, the
// Postmark webhook, the magic link -- matches on the address case-insensitively.
// Returns null on anything that is not a plausible address, so a typo is
// rejected at the form rather than becoming an inbox we can never reach.
function normalizeEmail(raw: any): string | null {
  const e = String(raw ?? "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(e) && e.length <= 254 ? e : null;
}

// Events are an audit trail, not part of the transaction. A creator confirming
// their profile must not fail because the log write did.
async function logCreatorEvent(creatorId: string, type: string, payload: any = {}) {
  if (!creatorId) return;
  try {
    await db().from("creator_events_f5961d0c").insert({ creator_id: creatorId, type, payload });
  } catch (e: any) { console.error(`[events] ${type} failed:`, e?.message ?? e); }
}

// The creator's portal token, minted once and reused for ever after.
//
// This string is not just a session: creator_claims, submissions,
// creator_earnings and creator_payout_requests are all keyed by it, so it is
// the creator's durable identity in this schema. Handing back a *different*
// string orphans every row they have earned -- their balance reads zero and
// their history disappears -- which is why a token already on file is reused
// even when its session record is gone. Signing out deletes the session
// (`ctoken_`); this recreates it against the same string on the way back in.
//
// ctokenref_ is therefore the record of identity and ctoken_ the record of a
// live session, and only the second is disposable.
async function ensureCreatorPortalToken(creator: any): Promise<string> {
  const ref = await kv.get(`ctokenref_${creator.id}`).catch(() => null);
  const token = ref?.token || secureToken(24);
  const live = await kv.get(`ctoken_${token}`).catch(() => null);
  if (!live) {
    await kv.set(`ctoken_${token}`, {
      creatorId: creator.id, instagram: creator.instagram, email: creator.email,
      city: creator.city, createdAt: new Date().toISOString(),
    });
  }
  if (ref?.token !== token) {
    await kv.set(`ctokenref_${creator.id}`, { token, creatorId: creator.id, createdAt: new Date().toISOString() });
  }
  return token;
}

// The business-side twin of logCreatorEvent, and just as non-transactional: an
// owner signing in must not fail because the audit write did.
async function logBusinessEvent(businessId: string, type: string, payload: any = {}) {
  if (!businessId) return;
  try {
    await db().from("business_events_f5961d0c").insert({ business_id: businessId, type, payload });
  } catch (e: any) { console.error(`[events] ${type} failed:`, e?.message ?? e); }
}

// Same contract as ensureCreatorPortalToken: one durable token per business,
// reused whether or not a session is currently live, so signing in through the
// code flow does not invalidate the ?biz= link already sitting in the owner's
// inbox and signing out does not strand anything keyed to the string.
// Impersonation tokens are deliberately absent from biztokenref_, so an admin
// session can never be handed back here.
async function ensureBusinessPortalToken(biz: any): Promise<string> {
  const ref = await kv.get(`biztokenref_${biz.id}`).catch(() => null);
  const token = ref?.token || secureToken(24);
  const live = await kv.get(`biztoken_${token}`).catch(() => null);
  if (!live) {
    await kv.set(`biztoken_${token}`, {
      businessId: biz.id, businessName: biz.business_name, city: biz.city || "",
      createdAt: new Date().toISOString(),
    });
  }
  if (ref?.token !== token) {
    await kv.set(`biztokenref_${biz.id}`, { token, businessId: biz.id, createdAt: new Date().toISOString() });
  }
  return token;
}

// Minimal server-rendered shell. The SPA cannot serve these: they need real
// status codes, real redirects and a real noindex header.
function htmlPage(opts: { title: string; body: string; noindex?: boolean; status?: number; extraHead?: string }) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${opts.title}</title>${opts.noindex ? '<meta name="robots" content="noindex,nofollow">' : ""}${opts.extraHead ?? ""}
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
       background:#0a0a0a;color:#fff;min-height:100vh;display:flex;flex-direction:column;
       align-items:center;justify-content:center;padding:24px;-webkit-font-smoothing:antialiased}
  .wrap{width:100%;max-width:420px;text-align:center}
  .brand{font-size:12px;font-weight:600;letter-spacing:.2em;color:#a3a3a3;margin-bottom:28px}
  h1{font-size:22px;font-weight:700;line-height:1.3;margin-bottom:10px}
  p{font-size:14px;line-height:1.6;color:#a3a3a3;margin-bottom:20px}
  form{display:flex;flex-direction:column;gap:10px;margin-top:22px}
  input{width:100%;padding:12px 14px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.2);
        border-radius:12px;color:#fff;font-size:15px}
  input::placeholder{color:#737373}
  button{width:100%;padding:13px;background:#fff;color:#0a0a0a;border:0;border-radius:12px;
         font-size:14px;font-weight:600;cursor:pointer}
  .note{font-size:12px;color:#525252;margin-top:18px}
</style></head><body><div class="wrap"><div class="brand">C O N T Y N T</div>${opts.body}</div></body></html>`;
  return new Response(html, {
    status: opts.status ?? 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      ...(opts.noindex ? { "X-Robots-Tag": "noindex, nofollow" } : {}),
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}

const resendFormPage = (title: string, message: string) => htmlPage({
  title, noindex: true, status: 400,
  body: `<h1>${title}</h1><p>${message}</p>
    <form method="POST" action="${VERIFY_ORIGIN}/portal/verify/resend">
      <input type="email" name="email" placeholder="you@email.com" required autocomplete="email">
      <button type="submit">Send me a new link</button>
    </form>
    <p class="note">We will send a fresh link to the address you signed up with.</p>`,
});

// Magic link. This handler must never confirm anything: email security scanners
// and link previewers fetch GET URLs before a human ever sees them, so a GET
// that confirmed would mark creators confirmed who never opened the mail.
// Confirmation happens only on POST /portal/confirm.
app.get("/make-server-f5961d0c/portal/verify", async (c) => {
  try {
    const supplied = c.req.query("t") || "";
    if (!supplied) return resendFormPage("This link is incomplete", "The link was missing its token. Ask for a new one below.");

    const { data: row } = await db().from("creator_signups_f5961d0c")
      .select("id, instagram, email, city, verify_token, verify_token_expires_at, verify_open_count, verification_status")
      .eq("verify_token", supplied).maybeSingle();

    if (!row || !timingSafeEqual(String(row.verify_token ?? ""), supplied)) {
      return resendFormPage("This link is not valid", "It may have been replaced by a newer one. Enter your email and we will send a fresh link.");
    }

    const expired = row.verify_token_expires_at && new Date(row.verify_token_expires_at) <= new Date();
    if (expired) {
      if (row.verification_status !== "confirmed") {
        await db().from("creator_signups_f5961d0c").update({ verification_status: "expired" }).eq("id", row.id);
      }
      return resendFormPage("This link has expired", "Links are good for 90 days. Enter your email and we will send a fresh one.");
    }

    const now = new Date().toISOString();
    const patch: any = {
      verify_link_opened_at: now,
      verify_open_count: (row.verify_open_count ?? 0) + 1,
    };
    // Never walk a confirmed creator backwards to opened.
    if (row.verification_status === "pending") patch.verification_status = "opened";
    await must("verify: record open", db().from("creator_signups_f5961d0c").update(patch).eq("id", row.id));

    // The user agent is logged because open counts include scanner prefetches,
    // so a raw count cannot be read as human intent without it.
    await logCreatorEvent(row.id, "verify_link_opened", {
      openCount: patch.verify_open_count,
      userAgent: c.req.header("user-agent") || "",
    });

    // Land them signed in, no password. A creator who has already confirmed
    // goes straight to the portal: the link is the same one in an email that
    // may be months old, and re-opening it should not send them back through a
    // form they have already filled in. The confirm screen stays reachable at
    // ?view=confirm for anyone who wants to change an answer.
    const portalToken = await ensureCreatorPortalToken(row);
    const confirmed = row.verification_status === "confirmed";
    const dest = `${SITE_ORIGIN}/app?creator=${encodeURIComponent(portalToken)}${confirmed ? "" : "&view=confirm"}`;
    return c.redirect(dest, 302);
  } catch (e: any) {
    console.error("[verify]", e?.message ?? e);
    return resendFormPage("Something went wrong", "We could not open that link. Enter your email and we will send a fresh one.");
  }
});

// Deliberately identical response whether or not the address is on file, so
// this cannot be used to enumerate who is a CONTYNT creator.
app.post("/make-server-f5961d0c/portal/verify/resend", async (c) => {
  const done = () => htmlPage({
    title: "Check your email", noindex: true,
    body: `<h1>Check your email</h1><p>If that address is on file, a new link is on its way. It is good for 90 days.</p>`,
  });
  try {
    const body = await c.req.parseBody().catch(() => ({} as any));
    const email = String((body as any).email ?? "").trim().toLowerCase();
    if (!email) return done();

    const { data: row } = await db().from("creator_signups_f5961d0c")
      .select("id, email, instagram, instagram_handle, email_bounced_at, email_complained_at, verify_email_sent_at")
      .ilike("email", email).maybeSingle();

    // Requests from a creator we stopped emailing are accepted and dropped.
    if (row && !row.email_bounced_at && !row.email_complained_at) {
      // A public form that mails whoever is on file is worth throttling: without
      // it, anyone who knows an address can have us mail that person on repeat.
      // The reply below never varies, so a throttled request looks exactly like
      // a sent one and this leaks nothing.
      const lastSent = row.verify_email_sent_at ? new Date(row.verify_email_sent_at).getTime() : 0;
      if (Date.now() - lastSent < RESEND_COOLDOWN_MIN * 60_000) return done();

      // Sent before the new token is stored, so a send that fails leaves the
      // link the creator already has working. The other order is how this
      // behaved until now: it retired their link, told them a new one was on the
      // way, and mailed nothing -- leaving them worse off for having asked.
      const token = secureToken(32);
      const link = verifyLinkFor(token);
      const rendered = renderVerificationEmail(row, link);

      if (!POSTMARK_SERVER_TOKEN) {
        await logCreatorEvent(row.id, "verify_link_resend_failed", { reason: "POSTMARK_SERVER_TOKEN not set" });
        return done();
      }
      const sent = await postmarkSend({ to: row.email, ...rendered, stream: POSTMARK_TRANSACTIONAL_STREAM });
      if (!sent.ok) {
        // Logged rather than swallowed: the creator is now waiting on an email
        // that is not coming, and this is the only place that says so.
        await logCreatorEvent(row.id, "verify_link_resend_failed", { error: sent.error });
        return done();
      }

      await must("verify: reissue token", db().from("creator_signups_f5961d0c").update({
        verify_token: token,
        verify_token_expires_at: new Date(Date.now() + VERIFY_DAYS * 864e5).toISOString(),
        verify_email_sent_at: new Date().toISOString(),
      }).eq("id", row.id));
      await logCreatorEvent(row.id, "verify_link_requested", {
        link, messageId: sent.payload?.MessageID ?? null, via: "resend_form",
      });
    }
    return done();
  } catch { return done(); }
});

// A Reel URL is rendered as an href in the business portal and the admin
// dashboard. React 18 renders a `javascript:` href with nothing but a console
// warning, so an unvalidated field here was a stored script waiting for an
// admin -- the one person holding a session token -- to click it. Validation
// existed only in the browser, which is not where it counts.
const REEL_HOSTS = ["instagram.com", "instagr.am"];

function normalizeReelUrl(raw: any): string | null {
  const v = String(raw ?? "").trim();
  if (!v || v.length > 500) return null;
  let u: URL;
  try { u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.replace(/^www\./i, "").toLowerCase();
  // Instagram only. This is where a Reel lives, and a link anywhere else is
  // either a mistake worth catching at the form or somebody trying it on.
  if (!REEL_HOSTS.includes(host) && !REEL_HOSTS.some(h => host.endsWith(`.${h}`))) return null;
  return u.toString();
}

function normalizeUrl(raw: any): string | null {
  const v = String(raw ?? "").trim();
  if (!v) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch { return null; }
}

// Single writer for ambassador consent. creator_signups carries the consent and
// its timestamps; ambassadors_f5961d0c carries the code and referral URL. Both
// are written here so enabled_status and ambassador_opted_in cannot disagree,
// which they would if each caller updated whichever one it happened to know about.
async function setAmbassadorOptIn(creator: any, optIn: boolean) {
  const now = new Date().toISOString();
  await must("ambassador: consent", db().from("creator_signups_f5961d0c").update(
    optIn
      ? { ambassador_opted_in: true, ambassador_opted_in_at: creator.ambassador_opted_in_at || now }
      // opted_in_at is deliberately left intact: it records that consent was
      // once given, which the opt-out timestamp alone would not tell you.
      : { ambassador_opted_in: false, ambassador_opt_out_at: now }
  ).eq("id", creator.id));

  const { data: existing } = await db().from("ambassadors_f5961d0c")
    .select("*").eq("creator_id", creator.id).maybeSingle();

  if (!optIn) {
    if (existing) {
      await must("ambassador: disable", db().from("ambassadors_f5961d0c")
        .update({ enabled_status: false }).eq("ambassador_id", existing.ambassador_id));
    }
    return null;
  }

  // Re-enabling keeps the existing code, so any card already handed out stays live.
  if (existing) {
    if (!existing.enabled_status) {
      await must("ambassador: enable", db().from("ambassadors_f5961d0c")
        .update({ enabled_status: true }).eq("ambassador_id", existing.ambassador_id));
    }
    return { ...existing, enabled_status: true };
  }

  const portalToken = await ensureCreatorPortalToken(creator);
  for (let i = 0; i < 5; i++) {
    const code = anonCode();
    const { data, error } = await db().from("ambassadors_f5961d0c").insert({
      creator_id: creator.id,
      creator_token: portalToken,
      creator_instagram: creator.instagram || "",
      referral_code: code,
      referral_url: referralUrlFor(code),
      enabled_status: true,
    }).select("*").single();
    if (!error) return data;
    if (!String(error.message || "").includes("duplicate")) throw error;
  }
  throw new Error("Could not allocate a referral code");
}

// Bootstrap for the confirm screen. Returns the creator's current values plus
// the neighborhood list the server will validate against.
app.get("/make-server-f5961d0c/creator-portal/confirm-data", async (c) => {
  try {
    const token = c.req.query("t");
    if (!token) return c.json({ error: "Token required" }, 400);
    const creatorData = await creatorFromToken(token);
    if (!creatorData?.creatorId) return c.json({ error: "Invalid or expired link" }, 401);

    const { data: row } = await db().from("creator_signups_f5961d0c")
      .select("*").eq("id", creatorData.creatorId).maybeSingle();
    if (!row) return c.json({ error: "Creator not found" }, 404);

    return c.json({
      neighborhoods: SF_NEIGHBORHOODS,
      verificationStatus: row.verification_status || "pending",
      confirmedAt: row.verify_confirmed_at || null,
      profile: {
        instagramHandle: row.instagram_handle || normalizeHandle(row.instagram || "") || "",
        serviceAreas: row.service_areas || [],
        maxFeaturesPerWeek: row.max_features_per_week ?? null,
        notifyEmail: row.notify_email ?? true,
        notifyDm: row.notify_dm ?? true,
        notifySms: row.notify_sms ?? false,
        phone: row.phone || "",
        portfolioUrl: row.portfolio_url || "",
        dietaryNotes: row.dietary_notes || "",
        email: row.email || "",
      },
      ambassador: {
        optedIn: !!row.ambassador_opted_in,
        optedInAt: row.ambassador_opted_in_at || null,
      },
    });
  } catch (e: any) { return c.json({ error: "Failed to load", details: e.message }, 500); }
});

// Confirmation. Re-submitting is a normal update, not an error: a creator who
// changes their neighborhoods three months in should land here again and simply
// refresh the snapshot.
app.post("/make-server-f5961d0c/creator-portal/confirm", async (c) => {
  try {
    const body = await c.req.json();
    const { token: rawToken } = body;
    if (!rawToken) return c.json({ error: "token required" }, 400);
    const creatorData = await creatorFromToken(rawToken);
    if (!creatorData?.creatorId) return c.json({ error: "Invalid or expired link" }, 401);
    // Impersonation writes must land on the creator's own rows, not on the
    // short lived admin token, which expires in an hour and is in no index.
    const token = creatorData.realToken ?? rawToken;

    const { data: creator } = await db().from("creator_signups_f5961d0c")
      .select("*").eq("id", creatorData.creatorId).maybeSingle();
    if (!creator) return c.json({ error: "Creator not found" }, 404);

    const handle = normalizeHandle(body.instagramHandle);
    if (!handle) return c.json({ error: "Enter a valid Instagram handle, letters, numbers, periods and underscores only." }, 400);

    // Everything below the handle is optional, and absent means "leave it
    // alone". The confirm screen no longer asks for neighborhoods, capacity,
    // portfolio or dietary notes, so treating an omitted key as an empty value
    // would wipe whatever an earlier confirm or an admin already recorded.
    const optional: Record<string, unknown> = {};

    // The confirm screen asks the creator to check the address we mail Features
    // to, so it can come back changed. null means "sent, but not an address".
    let email = String(creator.email ?? "").trim().toLowerCase();
    const nextEmail = body.email === undefined ? email : normalizeEmail(body.email);
    if (nextEmail === null) return c.json({ error: "Enter a valid email address." }, 400);
    const emailChanged = nextEmail !== email;
    if (emailChanged) {
      // Two creator rows on one address break every lookup that resolves an
      // address back to a creator with maybeSingle(), the resend form included.
      const { data: taken } = await db().from("creator_signups_f5961d0c")
        .select("id").ilike("email", nextEmail).neq("id", creator.id).limit(1);
      if (taken?.length) return c.json({ error: "That email is already on another Contynt account." }, 409);
      email = nextEmail;
      optional.email = email;
      // A bounce recorded against the old address suppresses every later send,
      // which would make correcting a mistyped address pointless. A spam
      // complaint is left standing: that one was a choice, not a typo.
      optional.email_bounced_at = null;
    }

    if (body.serviceAreas !== undefined) {
      const areas = Array.isArray(body.serviceAreas)
        ? body.serviceAreas.filter((a: any) => SF_NEIGHBORHOODS.includes(a)) : [];
      if (!areas.length) return c.json({ error: "Pick at least one neighborhood." }, 400);
      optional.service_areas = areas;
    }

    if (body.maxFeaturesPerWeek !== undefined && body.maxFeaturesPerWeek !== null) {
      const capacity = Number(body.maxFeaturesPerWeek);
      if (!Number.isInteger(capacity) || capacity < 1 || capacity > 4) {
        return c.json({ error: "Choose how many features you can take per week." }, 400);
      }
      optional.max_features_per_week = capacity;
    }

    const notifyEmail = body.notifyEmail !== false;
    // Default on: the handle is the one contact detail we always have.
    const notifyDm = body.notifyDm !== false;
    const phone = body.phone === undefined ? String(creator.phone ?? "") : String(body.phone ?? "").trim();
    const hasPhone = phone.replace(/\D/g, "").length >= 10;
    // The confirm screen no longer asks about texts, so a stored opt-in rides
    // along untouched. It can only be rejected when the screen actually asked;
    // otherwise a creator opted in without a usable number would hit an error
    // for a field that is not on the page, with no way to clear it.
    let notifySms = body.notifySms === undefined ? !!creator.notify_sms : !!body.notifySms;
    if (notifySms && !hasPhone) {
      if (body.notifySms !== undefined) return c.json({ error: "Add a phone number to get text alerts." }, 400);
      notifySms = false;
    }
    if (body.phone !== undefined) optional.phone = phone || null;

    if (body.portfolioUrl !== undefined) {
      const portfolioRaw = String(body.portfolioUrl ?? "").trim();
      const portfolioUrl = portfolioRaw ? normalizeUrl(portfolioRaw) : null;
      if (portfolioRaw && !portfolioUrl) return c.json({ error: "That portfolio link does not look like a URL." }, 400);
      optional.portfolio_url = portfolioUrl;
    }

    if (body.dietaryNotes !== undefined) {
      optional.dietary_notes = String(body.dietaryNotes).trim() || null;
    }

    const now = new Date().toISOString();
    await must("confirm: save profile", db().from("creator_signups_f5961d0c").update({
      // Both handle columns move together. The portal, claims and submissions
      // all read `instagram`, so correcting only instagram_handle would leave
      // the creator looking at the typo they just fixed.
      instagram: handle,
      instagram_handle: handle,
      notify_email: notifyEmail,
      notify_dm: notifyDm,
      notify_sms: notifySms,
      ...optional,
      verify_confirmed_at: now,
      verification_status: "confirmed",
    }).eq("id", creator.id));

    // The KV session caches the handle for the portal header and the email for
    // the sends that read the session, so refresh it or a correction will not
    // take effect until the token is regenerated.
    if (creatorData.instagram !== handle || creatorData.email !== email) {
      await kv.set(`ctoken_${token}`, { ...creatorData, instagram: handle, email });
    }

    const snapshot = {
      instagramHandle: handle,
      notifyEmail, notifyDm, notifySms, hasPhone,
      ...optional,
    };
    await logCreatorEvent(creator.id, "profile_confirmed", snapshot);
    if (emailChanged) {
      await logCreatorEvent(creator.id, "email_changed", { from: creator.email ?? "", to: email });
    }

    // Only a change is an event. Re-confirming with the toggle untouched should
    // not litter the log with opt-in rows that record nothing happening.
    const wants = !!body.ambassadorOptIn;
    const had = !!creator.ambassador_opted_in;
    let ambassador = null;
    if (wants !== had) {
      ambassador = await setAmbassadorOptIn(creator, wants);
      await logCreatorEvent(creator.id, wants ? "ambassador_opted_in" : "ambassador_opted_out", {});
    }

    return c.json({
      success: true, confirmedAt: now,
      ambassador: { optedIn: wants, referralCode: ambassador?.referral_code ?? null },
    });
  } catch (e: any) { return c.json({ error: "Could not save your profile", details: e.message }, 500); }
});

// Standalone toggle for the success card and the settings screen. Separate from
// confirm so it can be flipped with one POST without resubmitting the form.
app.post("/make-server-f5961d0c/creator-portal/ambassador/toggle", async (c) => {
  try {
    const { token: rawToken, optIn } = await c.req.json();
    if (!rawToken || typeof optIn !== "boolean") return c.json({ error: "token and optIn required" }, 400);
    const creatorData = await creatorFromToken(rawToken);
    if (!creatorData?.creatorId) return c.json({ error: "Invalid or expired link" }, 401);
    // Impersonation writes must land on the creator's own rows, not on the
    // short lived admin token, which expires in an hour and is in no index.
    const token = creatorData.realToken ?? rawToken;

    const { data: creator } = await db().from("creator_signups_f5961d0c")
      .select("*").eq("id", creatorData.creatorId).maybeSingle();
    if (!creator) return c.json({ error: "Creator not found" }, 404);

    if (!!creator.ambassador_opted_in === optIn) {
      return c.json({ success: true, optedIn: optIn, unchanged: true });
    }
    const ambassador = await setAmbassadorOptIn(creator, optIn);
    await logCreatorEvent(creator.id, optIn ? "ambassador_opted_in" : "ambassador_opted_out", {});
    return c.json({ success: true, optedIn: optIn, referralCode: ambassador?.referral_code ?? null });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// ─── Stripe ───────────────────────────────────────────────────────────────────
// Called over the REST API rather than through the SDK: this function already
// talks to Postmark the same way, and a payment dependency is not worth pulling
// into a Deno bundle for four endpoints.
//
// The secret never appears in this repo. It is read from the environment, the
// same as POSTMARK_SERVER_TOKEN, so the key lives in Supabase secrets and is
// visible to nobody who reads the source.
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") || "";
const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET") || "";

// Stripe wants form encoding, including for nested fields, which is why this
// flattens rather than posting JSON.
function stripeForm(obj: Record<string, any>, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object" && !Array.isArray(v)) out.push(...stripeForm(v, key));
    else if (Array.isArray(v)) v.forEach((item, i) => {
      if (typeof item === "object") out.push(...stripeForm(item, `${key}[${i}]`));
      else out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(item))}`);
    });
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out;
}

// Which kind of key is in STRIPE_SECRET_KEY, judged by prefix alone -- nothing
// here reads or logs the value itself.
//
//   sk_ / rk_   secret and restricted keys. Both work server side.
//   pk_         publishable. Public by design, meant for browsers, and rejected
//               by every endpoint this server calls.
//
// The publishable key is the one on screen in the Stripe dashboard; the secret
// is hidden behind "Reveal". So copying the wrong one is the easy mistake, and
// Stripe answers it with a message that never names which key you used --
// repeated once per call, which reads like six separate faults.
function stripeKeyProblem(): string {
  if (!STRIPE_SECRET_KEY) return "STRIPE_SECRET_KEY is not set on the server.";
  if (STRIPE_SECRET_KEY.startsWith("pk_")) {
    const mode = STRIPE_SECRET_KEY.startsWith("pk_live_") ? "live" : "test";
    return `STRIPE_SECRET_KEY holds a publishable key (pk_${mode}_...). `
      + `That one is public and cannot make these calls. You need the secret key `
      + `(sk_${mode}_...) from Stripe > Developers > API keys -- it is hidden until you `
      + `press "Reveal". Nothing was exposed: a publishable key is meant to be public.`;
  }
  return "";
}

async function stripeCall(method: "GET" | "POST", path: string, body?: Record<string, any>) {
  // Checked before the request rather than after: this cannot succeed, and
  // failing here says which key is wrong instead of relaying Stripe's answer.
  const keyProblem = stripeKeyProblem();
  if (keyProblem) return { ok: false as const, error: keyProblem, data: null };
  const url = `https://api.stripe.com/v1/${path}`;
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  };
  if (body && method === "POST") (init as any).body = stripeForm(body).join("&");
  try {
    const res = await fetch(method === "GET" && body ? `${url}?${stripeForm(body).join("&")}` : url, init);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false as const, error: data?.error?.message || `Stripe ${res.status}`, data };
    return { ok: true as const, error: "", data };
  } catch (e: any) {
    return { ok: false as const, error: e?.message ?? String(e), data: null };
  }
}

// The plans as Stripe should see them. Kept beside the portal's own copy rather
// than derived from it: the portal's PLANS array is marketing text that changes
// freely, and a price is not something a copy edit should be able to move.
//
// lookup_key is what makes creating these idempotent. Stripe rejects a second
// price with the same key, so a sync that runs twice reuses what is there.
const STRIPE_PLANS = [
  { tier: "Starter", lookupKey: "contynt_starter_monthly", label: "Contynt Starter", amount: 6900, interval: "month" as const, reels: 1 },
  { tier: "Growth", lookupKey: "contynt_growth_monthly", label: "Contynt Growth", amount: 11900, interval: "month" as const, reels: 2 },
  { tier: "Pro", lookupKey: "contynt_pro_monthly", label: "Contynt Pro", amount: 19900, interval: "month" as const, reels: 4 },
  { tier: null, lookupKey: "contynt_one_off_feature", label: "Contynt One-Time Feature", amount: 8900, interval: null, reels: 1 },
];

// Every tier name the app will accept, derived from the plans above so a new
// plan cannot be sellable in Stripe and unknown to /admin/set-tier.
const KNOWN_TIERS = STRIPE_PLANS.map(p => p.tier).filter(Boolean) as string[];

// Stripe sets subscription metadata once, at checkout, and never touches it
// again -- so a business that upgrades Starter -> Growth in the billing portal
// kept the tier it first bought. The price on the subscription item does move,
// and lookup_key is the stable name we gave it, so the tier is read from there
// and metadata is only the fallback for a subscription whose price predates a
// lookup key.
function tierFromSubscription(sub: any): string | null {
  const key = sub?.items?.data?.[0]?.price?.lookup_key ?? null;
  const byKey = key ? STRIPE_PLANS.find(p => p.lookupKey === key)?.tier ?? null : null;
  return byKey ?? sub?.metadata?.contynt_tier ?? null;
}

// Finds the price for a plan, creating the product and price the first time.
// Idempotent on lookup_key, so this is safe to run against a live account more
// than once -- which matters, because the alternative is duplicate products in
// somebody's real Stripe dashboard.
async function ensureStripePrice(plan: typeof STRIPE_PLANS[number], dryRun: boolean) {
  const found = await stripeCall("GET", "prices", { lookup_keys: [plan.lookupKey], limit: 1, active: true });
  if (!found.ok) return { plan: plan.label, error: found.error };
  const existing = found.data?.data?.[0];
  if (existing) return { plan: plan.label, priceId: existing.id, lookupKey: plan.lookupKey, existed: true, livemode: !!existing.livemode };
  if (dryRun) return { plan: plan.label, lookupKey: plan.lookupKey, wouldCreate: true, amount: plan.amount };

  const product = await stripeCall("POST", "products", {
    name: plan.label,
    metadata: { contynt_tier: plan.tier ?? "one_off" },
  });
  if (!product.ok) return { plan: plan.label, error: product.error };

  const price = await stripeCall("POST", "prices", {
    product: product.data.id,
    unit_amount: plan.amount,
    currency: "usd",
    lookup_key: plan.lookupKey,
    ...(plan.interval ? { recurring: { interval: plan.interval } } : {}),
    metadata: { contynt_tier: plan.tier ?? "one_off" },
  });
  if (!price.ok) return { plan: plan.label, error: price.error };
  return { plan: plan.label, priceId: price.data.id, lookupKey: plan.lookupKey, created: true, livemode: !!price.data.livemode };
}

app.post("/make-server-f5961d0c/admin/stripe/sync-prices", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const dryRun = !!body.dryRun;
    const keyProblem = stripeKeyProblem();
    if (keyProblem) return c.json({ error: keyProblem }, 400);
    // Which account this key belongs to, and what it can do. A pending account
    // and a test key look identical from in here otherwise, and the two need
    // opposite responses: one is waiting on Stripe, the other on a key swap.
    // Balance rather than account, because the Account object carries no
    // livemode flag and a Price only exists after the thing this check is
    // supposed to happen before. Balance always exists and always says.
    // Webhook endpoints are listed with the same key, which is the point: a key
    // only ever sees endpoints in its own mode. An endpoint that exists in the
    // Stripe dashboard but is absent here is in the other mode, and will never
    // be sent an event by these payments no matter how correct its URL is.
    const [acct, balance, hooks] = await Promise.all([
      stripeCall("GET", "account"),
      stripeCall("GET", "balance"),
      stripeCall("GET", "webhook_endpoints", { limit: 10 }),
    ]);
    const webhooks = hooks.ok
      ? (hooks.data?.data ?? []).map((w: any) => ({
          url: w.url, status: w.status,
          events: w.enabled_events ?? [],
          // Named so the reader can tell at a glance whether the three events
          // this integration depends on are actually subscribed.
          hasCheckoutCompleted: (w.enabled_events ?? []).includes("checkout.session.completed")
            || (w.enabled_events ?? []).includes("*"),
        }))
      : [{ error: hooks.error }];
    const account = acct.ok ? {
      chargesEnabled: !!acct.data?.charges_enabled,
      payoutsEnabled: !!acct.data?.payouts_enabled,
      detailsSubmitted: !!acct.data?.details_submitted,
      country: acct.data?.country ?? null,
    } : { error: acct.error };
    const accountLivemode = balance.ok ? !!balance.data?.livemode : null;

    const results = [];
    for (const plan of STRIPE_PLANS) results.push(await ensureStripePrice(plan, dryRun));
    // The account's own mode wins; a price's is only a fallback for the case
    // where balance could not be read. Neither is guessed from the key prefix,
    // which has changed format before and is not worth parsing.
    const priceLivemode = results.map((r: any) => r.livemode).find((v: any) => v !== undefined) ?? null;
    const livemode = accountLivemode ?? priceLivemode;
    return c.json({
      success: true, dryRun, account, livemode, webhooks,
      created: results.filter(r => (r as any).created).length,
      existed: results.filter(r => (r as any).existed).length,
      wouldCreate: results.filter(r => (r as any).wouldCreate).length,
      failed: results.filter(r => (r as any).error).length,
      results,
    });
  } catch (e: any) { return c.json({ error: "Price sync failed", details: e.message }, 500); }
});

// Starts checkout for one plan. The business is identified from its own portal
// token, never from anything the browser sends: a body that named its own
// business id would let anyone buy a plan onto somebody else's account.
app.post("/make-server-f5961d0c/business-portal/checkout", async (c) => {
  try {
    const { bizToken, tier } = await c.req.json();
    const session = await businessFromToken(String(bizToken ?? ""));
    if (!session?.businessId) return c.json({ error: "Invalid or expired link" }, 401);
    if (!STRIPE_SECRET_KEY) return c.json({ error: "Payments are not configured yet." }, 400);

    const plan = STRIPE_PLANS.find(p => (p.tier ?? "one_off") === String(tier));
    if (!plan) return c.json({ error: "Unknown plan" }, 400);

    const found = await stripeCall("GET", "prices", { lookup_keys: [plan.lookupKey], limit: 1, active: true });
    if (!found.ok) return c.json({ error: found.error }, 502);
    const price = found.data?.data?.[0];
    // A price that was never synced is a setup problem, and saying so beats a
    // Stripe error that means nothing to whoever is standing at the till.
    if (!price) return c.json({ error: "That plan has no price in Stripe yet. Run the price sync in the admin dashboard." }, 409);

    const { data: biz } = await db().from("business_signups_f5961d0c")
      .select("id, email, business_name").eq("id", session.businessId).maybeSingle();

    const back = `${SITE_ORIGIN}/business?biz=${encodeURIComponent(String(bizToken))}`;
    const created = await stripeCall("POST", "checkout/sessions", {
      mode: plan.interval ? "subscription" : "payment",
      line_items: [{ price: price.id, quantity: 1 }],
      // Both, deliberately. client_reference_id survives on the session for a
      // human reading the Stripe dashboard; metadata is what the webhook reads.
      client_reference_id: session.businessId,
      metadata: { business_id: session.businessId, contynt_tier: plan.tier ?? "one_off" },
      ...(plan.interval ? { subscription_data: { metadata: { business_id: session.businessId, contynt_tier: plan.tier } } } : {}),
      customer_email: biz?.email || undefined,
      success_url: `${back}&paid=1`,
      cancel_url: back,
      allow_promotion_codes: true,
    });
    if (!created.ok) return c.json({ error: created.error }, 502);

    await logBusinessEvent(session.businessId, "checkout_started", { tier: plan.tier ?? "one_off", sessionId: created.data.id });
    return c.json({ success: true, url: created.data.url });
  } catch (e: any) { return c.json({ error: "Could not start checkout", details: e.message }, 500); }
});

// Sends a business to Stripe's own billing portal, where it can change its card,
// read invoices and cancel. Cancelling there ends the plan at the period end,
// which is the deal the portal already promises -- so this needs no cancel
// button of its own, and no code here can accidentally cut somebody off early.
app.post("/make-server-f5961d0c/business-portal/billing", async (c) => {
  try {
    const { bizToken } = await c.req.json();
    const session = await businessFromToken(String(bizToken ?? ""));
    if (!session?.businessId) return c.json({ error: "Invalid or expired link" }, 401);
    if (!STRIPE_SECRET_KEY) return c.json({ error: "Payments are not configured yet." }, 400);

    const { data: biz } = await db().from("business_signups_f5961d0c")
      .select("id, email, stripe_customer_id").eq("id", session.businessId).maybeSingle();
    if (!biz) return c.json({ error: "Business not found" }, 404);

    // Stored id first. Anything bought before that column existed is found by
    // email instead, and the id is written back so the lookup happens once.
    let customer = biz.stripe_customer_id || null;
    if (!customer && biz.email) {
      const found = await stripeCall("GET", "customers", { email: String(biz.email).trim().toLowerCase(), limit: 1 });
      if (found.ok && found.data?.data?.[0]?.id) {
        customer = found.data.data[0].id;
        await db().from("business_signups_f5961d0c")
          .update({ stripe_customer_id: customer }).eq("id", biz.id);
      }
    }
    // Nothing has ever been bought, so there is no billing to manage. Said
    // plainly rather than as a Stripe error about a missing customer.
    if (!customer) return c.json({ error: "No billing set up yet. Choose a plan first." }, 409);

    const back = `${SITE_ORIGIN}/business?biz=${encodeURIComponent(String(bizToken))}`;
    // The configuration is what carries plan switching and cancel-at-period-end.
    // Without one Stripe falls back to the dashboard default, which has neither.
    const portalConfig = await kv.get("stripe_portal_config").catch(() => null);
    let made = await stripeCall("POST", "billing_portal/sessions", {
      customer, return_url: back,
      ...(portalConfig?.id ? { configuration: portalConfig.id } : {}),
    });
    // A configuration from the other mode is rejected by name. Retrying without
    // it opens the dashboard-default portal, which is worse than the configured
    // one and far better than a business being unable to reach billing at all.
    if (!made.ok && portalConfig?.id) {
      await logBusinessEvent(biz.id, "billing_portal_config_rejected", { configuration: portalConfig.id, error: made.error });
      made = await stripeCall("POST", "billing_portal/sessions", { customer, return_url: back });
    }
    if (!made.ok) return c.json({ error: made.error }, 502);
    await logBusinessEvent(biz.id, "billing_portal_opened", {});
    return c.json({ success: true, url: made.data.url });
  } catch (e: any) { return c.json({ error: "Could not open billing", details: e.message }, 500); }
});

// What a Stripe subscription actually says, in one place. Read from three
// fields on purpose: newer API versions express "cancel at the end of the
// period" as a cancel_at timestamp and leave cancel_at_period_end false -- so
// the boolean alone reports no cancellation at all -- and they moved
// current_period_end off the subscription onto its items. Older versions do the
// opposite. Shared by the webhook and the reconcile below so the push and the
// pull can never disagree about the same subscription.
function readSubscriptionState(sub: any) {
  const itemPeriodEnd = sub?.items?.data?.[0]?.current_period_end ?? null;
  const periodEnd = sub?.current_period_end ?? itemPeriodEnd;
  const cancelAtTs = sub?.cancel_at ?? (sub?.cancel_at_period_end ? periodEnd : null);
  return {
    live: ["active", "trialing", "past_due"].includes(String(sub?.status)),
    tier: tierFromSubscription(sub),
    endsAt: cancelAtTs ? new Date(Number(cancelAtTs) * 1000).toISOString() : null,
    status: sub?.status ?? null,
  };
}

// Pulls the current truth from Stripe for every business with a customer, and
// writes what it finds. A webhook that never arrived -- wrong mode, endpoint
// added late, a delivery that failed every retry -- leaves the app quietly out
// of step with what people are paying, and nothing else here can notice. This
// is how that gets corrected without waiting for the next billing event.
app.post("/make-server-f5961d0c/admin/stripe/sync-subscriptions", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const dryRun = !!body.dryRun;
    const keyProblem = stripeKeyProblem();
    if (keyProblem) return c.json({ error: keyProblem }, 400);

    const { data: rows } = await db().from("business_signups_f5961d0c")
      .select("id, business_name, subscription_tier, subscription_ends_at, stripe_customer_id")
      .not("stripe_customer_id", "is", null);

    const results: any[] = [];
    for (const b of (rows ?? [])) {
      const subs = await stripeCall("GET", "subscriptions", { customer: b.stripe_customer_id, status: "all", limit: 10 });
      if (!subs.ok) { results.push({ business: b.business_name, error: subs.error }); continue; }

      // The one that still grants something, else the most recent, so a
      // business with an old cancelled subscription beside a live one is read
      // from the live one.
      const all = subs.data?.data ?? [];
      const chosen = all.find((x: any) => readSubscriptionState(x).live) ?? all[0] ?? null;
      const state = chosen ? readSubscriptionState(chosen) : { live: false, tier: null, endsAt: null, status: "none" };

      const tier = state.live ? state.tier : null;
      const endsAt = state.live ? state.endsAt : null;
      const changed = (b.subscription_tier ?? null) !== (tier ?? null)
        || (b.subscription_ends_at ?? null) !== (endsAt ?? null);

      if (!changed) { results.push({ business: b.business_name, status: state.status, unchanged: true }); continue; }
      if (dryRun) {
        results.push({ business: b.business_name, status: state.status,
          from: { tier: b.subscription_tier ?? null, endsAt: b.subscription_ends_at ?? null },
          to: { tier, endsAt }, wouldUpdate: true });
        continue;
      }
      await db().from("business_signups_f5961d0c")
        .update({ subscription_tier: tier, subscription_ends_at: endsAt }).eq("id", b.id);
      await logBusinessEvent(b.id, "subscription_reconciled", { status: state.status, tier, endsAt });
      results.push({ business: b.business_name, status: state.status, to: { tier, endsAt }, updated: true });
    }

    return c.json({
      success: true, dryRun,
      considered: (rows ?? []).length,
      updated: results.filter(r => r.updated).length,
      wouldUpdate: results.filter(r => r.wouldUpdate).length,
      unchanged: results.filter(r => r.unchanged).length,
      failed: results.filter(r => r.error).length,
      results,
    });
  } catch (e: any) { return c.json({ error: "Subscription sync failed", details: e.message }, 500); }
});

// The Customer Portal, configured from here rather than by hand in the Stripe
// dashboard.
//
// Two things this settles that the dashboard default does not. Plan switching
// is off by default, so "Manage billing" opened a portal that could update a
// card and cancel but not move Starter -> Growth, which is the one change a
// growing business actually wants to make. And cancellation defaults to
// immediate, which contradicts what this app promises everywhere else: the plan
// is paid for to the end of the period and runs until then. mode=at_period_end
// is that promise, written where Stripe enforces it rather than where somebody
// remembers it.
//
// A configuration belongs to one mode. The id minted against a test key is
// meaningless to a live key, so the stored record carries its livemode and the
// session below falls back to no configuration rather than failing outright --
// which is what the first portal open after a live cutover would otherwise do.
app.post("/make-server-f5961d0c/admin/stripe/sync-portal", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const dryRun = !!body.dryRun;
    const keyProblem = stripeKeyProblem();
    if (keyProblem) return c.json({ error: keyProblem }, 400);

    // Only the recurring plans. The one-off Feature is a payment, not a
    // subscription, and offering it as something to switch to would be a way to
    // turn a paying subscription into a single Reel.
    const wanted = STRIPE_PLANS.filter(p => p.interval && p.tier);
    const resolved: any[] = [];
    for (const plan of wanted) {
      const found = await stripeCall("GET", "prices", {
        lookup_keys: [plan.lookupKey], limit: 1, active: true, expand: ["data.product"],
      });
      if (!found.ok) return c.json({ error: found.error }, 502);
      const price = found.data?.data?.[0];
      if (!price) {
        return c.json({
          error: `No price in Stripe for ${plan.label}. Press "Create Stripe prices" first — a portal cannot offer a plan that does not exist yet.`,
        }, 409);
      }
      resolved.push({
        tier: plan.tier, label: plan.label, amount: plan.amount,
        priceId: price.id,
        productId: typeof price.product === "string" ? price.product : price.product?.id,
        livemode: !!price.livemode,
      });
    }

    const stored = await kv.get("stripe_portal_config").catch(() => null);
    if (dryRun) {
      return c.json({
        success: true, dryRun: true,
        existingConfig: stored?.id ?? null,
        existingLivemode: stored?.livemode ?? null,
        plans: resolved.map(r => ({ tier: r.tier, priceId: r.priceId, livemode: r.livemode })),
      });
    }

    const payload = {
      business_profile: { headline: "CONTYNT — manage your plan" },
      features: {
        subscription_update: {
          enabled: true,
          default_allowed_updates: ["price"],
          // Prorated, so a mid-month upgrade is charged the difference rather
          // than a second full month, and a downgrade credits what is unused.
          proration_behavior: "create_prorations",
          products: resolved.map(r => ({ product: r.productId, prices: [r.priceId] })),
        },
        subscription_cancel: {
          enabled: true,
          mode: "at_period_end",
          cancellation_reason: {
            enabled: true,
            options: ["too_expensive", "missing_features", "switched_service", "unused", "other"],
          },
        },
        payment_method_update: { enabled: true },
        invoice_history: { enabled: true },
      },
    };

    // Updated in place when one already exists, so re-running this does not
    // leave a trail of stale configurations behind.
    const reuse = stored?.id && resolved.every(r => r.livemode === stored.livemode);
    const path = reuse ? `billing_portal/configurations/${stored.id}` : "billing_portal/configurations";
    const made = await stripeCall("POST", path, payload);
    if (!made.ok) return c.json({ error: made.error }, 502);

    await kv.set("stripe_portal_config", {
      id: made.data.id,
      livemode: !!made.data.livemode,
      updatedAt: new Date().toISOString(),
    });

    return c.json({
      success: true,
      configurationId: made.data.id,
      livemode: !!made.data.livemode,
      reused: !!reuse,
      planSwitching: true,
      cancelMode: "at_period_end",
      plans: resolved.map(r => ({ tier: r.tier, priceId: r.priceId })),
    });
  } catch (e: any) { return c.json({ error: "Portal setup failed", details: e.message }, 500); }
});

// Stripe signs every webhook. Without checking it, this endpoint is a public
// route that upgrades any business named in its body, so an unverified request
// is refused rather than trusted.
async function stripeSignatureValid(rawBody: string, header: string): Promise<boolean> {
  if (!STRIPE_WEBHOOK_SECRET || !header) return false;
  const parts = Object.fromEntries(header.split(",").map(p => p.split("=").map(x => x.trim()) as [string, string]));
  const timestamp = parts["t"], signature = parts["v1"];
  if (!timestamp || !signature) return false;
  // Five minutes, so a captured request cannot be replayed indefinitely.
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(STRIPE_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${rawBody}`));
  const expected = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(expected, signature);
}

app.post("/make-server-f5961d0c/webhooks/stripe", async (c) => {
  // Read once, as text: the signature is over the exact bytes Stripe sent, so
  // parsing first and re-serialising would never match.
  const raw = await c.req.text();
  const sigHeader = c.req.header("stripe-signature") || "";
  const valid = await stripeSignatureValid(raw, sigHeader);

  // Records that a request arrived and whether it verified, because from the
  // database side "Stripe never delivered" and "Stripe delivered and we refused
  // it" are indistinguishable otherwise -- both leave no trace at all. Holds no
  // secret: the signature header is a MAC over a body Stripe already sent.
  try {
    let peek: any = null;
    try {
      const p = JSON.parse(raw);
      const o = p?.data?.object ?? {};
      peek = {
        type: p?.type ?? null, id: p?.id ?? null,
        apiVersion: p?.api_version ?? null,
        hasMetadataBusinessId: !!o?.metadata?.business_id,
        clientReferenceId: o?.client_reference_id ?? null,
        // Stripe has moved subscription period fields between versions, so the
        // shape is recorded rather than assumed. Field names only where the
        // value is large; the timestamps themselves are the point.
        sub: p?.type?.startsWith?.("customer.subscription") ? {
          status: o?.status ?? null,
          cancelAtPeriodEnd: o?.cancel_at_period_end ?? null,
          cancelAt: o?.cancel_at ?? null,
          canceledAt: o?.canceled_at ?? null,
          currentPeriodEnd: o?.current_period_end ?? null,
          itemPeriodEnd: o?.items?.data?.[0]?.current_period_end ?? null,
          cancellationDetails: o?.cancellation_details ?? null,
          topLevelKeys: Object.keys(o ?? {}),
        } : null,
      };
    } catch { /* not JSON */ }
    await kv.set("stripehook_last", {
      at: new Date().toISOString(),
      signatureValid: valid,
      hadSignatureHeader: !!sigHeader,
      secretConfigured: !!STRIPE_WEBHOOK_SECRET,
      bodyBytes: raw.length,
      ...peek,
    });
  } catch { /* diagnostics must never break the webhook */ }

  if (!valid) return c.json({ error: "Bad signature" }, 400);
  let event: any;
  try { event = JSON.parse(raw); } catch { return c.json({ error: "Bad payload" }, 400); }

  try {
    const obj = event?.data?.object ?? {};
    const businessId = obj?.metadata?.business_id || obj?.client_reference_id || null;
    const tier = obj?.metadata?.contynt_tier || null;

    switch (event.type) {
      case "checkout.session.completed": {
        if (!businessId) break;
        // A one-off buys a single Feature, not a tier, so it must not write one.
        // The customer is kept whichever kind of purchase this was: a one-off
        // buyer still has invoices and a card on file worth reaching.
        const patch: Record<string, unknown> = {};
        if (obj.customer) patch.stripe_customer_id = String(obj.customer);
        if (tier && tier !== "one_off") patch.subscription_tier = tier;
        if (Object.keys(patch).length) {
          await db().from("business_signups_f5961d0c").update(patch).eq("id", businessId);
        }
        await logBusinessEvent(businessId, tier === "one_off" ? "one_off_purchased" : "subscription_started", {
          tier, sessionId: obj.id, amountTotal: obj.amount_total ?? null,
        });

        // The purchase has to become the thing that was bought. Until now this
        // logged the sale and stopped, so the Feature only appeared if somebody
        // spotted the event and clicked "One-Time" in the dashboard by hand.
        //
        // Created "offered", exactly as the admin button creates it: the
        // business accepts it in their own portal and says what the Reel should
        // cover, and is_one_off raises their allowance rather than spending it.
        if (tier === "one_off") {
          const { data: biz } = await db().from("business_signups_f5961d0c")
            .select("business_name, address, city, instagram").eq("id", businessId).maybeSingle();
          const { error: featErr } = await db().from("features_f5961d0c").insert({
            id: uid("feat_"), business_id: businessId,
            business_name: (biz as any)?.business_name || "",
            address: (biz as any)?.address || "", city: (biz as any)?.city || "",
            business_instagram: (biz as any)?.instagram || "",
            status: "offered", is_one_off: true,
            offered_at: new Date().toISOString(),
            category: "", payout_range: "",
            // Unique in the database. Stripe retries any delivery it did not
            // get a 2xx for, and a retry must not grant a second Reel.
            stripe_session_id: String(obj.id),
          });
          if (featErr) {
            const dupe = /duplicate|unique/i.test(String(featErr.message || ""));
            if (!dupe) {
              // Money has changed hands and the Feature did not appear. Loud,
              // and recorded against the business, because this is the one
              // trace an admin has that something is owed.
              console.error("[stripe webhook] one-off Feature not created:", featErr.message);
              await logBusinessEvent(businessId, "one_off_feature_failed", {
                sessionId: obj.id, error: featErr.message,
              });
            }
          } else {
            await logBusinessEvent(businessId, "one_off_feature_granted", { sessionId: obj.id });
          }
        }
        break;
      }
      case "customer.subscription.updated": {
        // A subscription that has lapsed should stop granting quota. Anything
        // still active or in its grace period keeps the tier it paid for.
        //
        // Cancelling is one of these, not a deletion: Stripe leaves the status
        // active and sets cancel_at_period_end, then sends the delete when the
        // period actually runs out. So a business that cancels keeps its plan
        // to the end of the month it paid for, which is the intended deal --
        // and the end date is recorded rather than left implicit, so a pending
        // cancellation is visible instead of a tier that vanishes one morning.
        if (!businessId) break;
        // Read through the shared reader rather than off `tier` above: that one
        // is the frozen checkout metadata, so an upgrade made in the billing
        // portal would have written the plan the business first bought.
        const { live, endsAt, tier: liveTier } = readSubscriptionState(obj);
        await db().from("business_signups_f5961d0c")
          .update({ subscription_tier: live ? liveTier : null, subscription_ends_at: endsAt })
          .eq("id", businessId);
        await logBusinessEvent(businessId,
          endsAt ? "subscription_cancel_scheduled" : "subscription_updated",
          { tier: liveTier, status: obj.status, endsAt, reason: obj?.cancellation_details?.reason ?? null });
        break;
      }
      case "customer.subscription.deleted": {
        // The period has now run out. This is where the plan actually stops.
        if (!businessId) break;
        await db().from("business_signups_f5961d0c")
          .update({ subscription_tier: null, subscription_ends_at: null }).eq("id", businessId);
        await logBusinessEvent(businessId, "subscription_ended", { tier });
        break;
      }
    }
    // Acknowledged whatever happened above. Stripe retries on a non-2xx, and a
    // retry storm over an event we do not handle helps nobody.
    return c.json({ received: true });
  } catch (e: any) {
    console.error("[stripe webhook]", e?.message ?? e);
    return c.json({ received: true, error: e?.message ?? String(e) });
  }
});

// ─── Postmark webhook ─────────────────────────────────────────────────────────
// Postmark's own convention is basic auth embedded in the webhook URL, but a
// custom header is easier to rotate, so both are accepted.
const POSTMARK_WEBHOOK_SECRET = Deno.env.get("POSTMARK_WEBHOOK_SECRET") || "";

function postmarkAuthorized(c: any): boolean {
  if (!POSTMARK_WEBHOOK_SECRET) return false;
  const header = c.req.header("x-postmark-secret") || "";
  if (header && timingSafeEqual(header, POSTMARK_WEBHOOK_SECRET)) return true;
  const auth = c.req.header("authorization") || "";
  if (auth.toLowerCase().startsWith("basic ")) {
    try {
      const decoded = atob(auth.slice(6));
      // Postmark sends user:password; only the password half is the secret.
      const password = decoded.slice(decoded.indexOf(":") + 1);
      return timingSafeEqual(password, POSTMARK_WEBHOOK_SECRET);
    } catch { return false; }
  }
  return false;
}

const POSTMARK_TYPES = new Set(["Delivery", "Bounce", "SpamComplaint", "Open", "Click", "SubscriptionChange"]);

async function recordEmailEvent(ev: any) {
  const type = String(ev?.RecordType ?? "");
  if (!POSTMARK_TYPES.has(type)) return { skipped: type || "unknown" };

  // Field naming varies by event type: Delivery/Open/Click carry Recipient,
  // Bounce and SpamComplaint carry Email.
  const email = String(ev.Recipient ?? ev.Email ?? "").trim().toLowerCase();
  const occurredAt = ev.DeliveredAt ?? ev.BouncedAt ?? ev.ChangedAt ?? ev.ReceivedAt ?? new Date().toISOString();

  // An address can belong to a creator, to a business, to both, or to neither.
  // All four are real, so both lookups run and neither is required.
  let creatorId: string | null = null;
  let businessId: string | null = null;
  if (email) {
    const [creRes, bizRes] = await Promise.all([
      db().from("creator_signups_f5961d0c").select("id").ilike("email", email).limit(1),
      db().from("business_signups_f5961d0c").select("id").ilike("email", email).limit(1),
    ]);
    creatorId = creRes.data?.[0]?.id ?? null;
    businessId = bizRes.data?.[0]?.id ?? null;
  }

  // Both id columns stay nullable on purpose: a bounce for an address no longer
  // matched to anyone is still worth keeping, and dropping it would lose the
  // only signal that the address is dead.
  //
  // Through must(): this insert IS the record. Unchecked, a failing write left
  // the route answering 200 to Postmark, which then considered the event
  // delivered and never retried -- losing the one thing this table exists for,
  // on the one table whose entire job is remembering what happened.
  await must("email event: record", db().from("email_events_f5961d0c").insert({
    creator_id: creatorId,
    business_id: businessId,
    message_id: ev.MessageID ?? ev.MessageId ?? null,
    type,
    payload: ev,
    occurred_at: occurredAt,
  }));

  if (!creatorId && !businessId) return { recorded: type, matched: false };

  // A soft bounce is a full mailbox or a temporary outage. Suppressing on that
  // would permanently stop mailing someone over one bad afternoon, so only hard
  // bounces and addresses Postmark itself deactivated count.
  const hardBounce = type === "Bounce" &&
    (ev.Inactive === true || /hard|bademail|blocked|manuallydeactivated/i.test(String(ev.Type ?? "")));

  if (type === "SpamComplaint" || hardBounce) {
    const column = type === "SpamComplaint" ? "email_complained_at" : "email_bounced_at";
    const eventType = type === "SpamComplaint" ? "email_complained" : "email_bounced";
    const detail = type === "SpamComplaint"
      ? { messageId: ev.MessageID ?? null }
      : { bounceType: ev.Type ?? null, messageId: ev.MessageID ?? null };

    if (creatorId) {
      await db().from("creator_signups_f5961d0c")
        .update({ [column]: occurredAt }).eq("id", creatorId);
      await logCreatorEvent(creatorId, eventType, detail);
    }
    if (businessId) {
      await db().from("business_signups_f5961d0c")
        .update({ [column]: occurredAt }).eq("id", businessId);
      await logBusinessEvent(businessId, eventType, detail);
    }
  }
  // Postmark keeps its own suppression list, and its List-Unsubscribe handler
  // and dashboard both write to it without telling this database. Without this,
  // a creator who unsubscribed through their mail client would still read as
  // subscribed here and still be counted into every future batch -- and every
  // one of those sends would be dropped at Postmark, invisibly.
  if (type === "SubscriptionChange") {
    const off = ev.SuppressSending === true;
    const detail = { via: "postmark", reason: ev.SuppressionReason ?? null, stream: ev.MessageStream ?? null };
    if (creatorId) {
      await db().from("creator_signups_f5961d0c").update({ notify_email: !off }).eq("id", creatorId);
      await logCreatorEvent(creatorId, off ? "email_unsubscribed" : "email_resubscribed", detail);
    }
    if (businessId) {
      await logBusinessEvent(businessId, off ? "email_unsubscribed" : "email_resubscribed", detail);
    }
  }

  // Delivery, Open and Click are logged and nothing more. Apple Mail Privacy
  // Protection prefetches images, so an Open means a mail client touched the
  // message, not that a human read it. Letting it advance verification_status
  // would mark creators confirmed who never saw the mail.
  return { recorded: type, matched: true };
}

app.post("/make-server-f5961d0c/webhooks/postmark", async (c) => {
  // Records that a request arrived and whether it authorised, before deciding
  // anything -- the same diagnostic the Stripe hook carries, and for the same
  // reason. Without it "Postmark never posted" and "Postmark posted and we
  // refused it" are the identical observation from in here: an empty table.
  //
  // That ambiguity had a real cost. email_events_f5961d0c sat at zero rows
  // while three messages went out and one link was opened twice, and there was
  // no way to tell from the data whether the webhook was misconfigured or
  // simply absent. It was absent -- Postmark had no webhook registered at all
  // -- but confirming that meant going and asking Postmark by hand.
  //
  // Holds no secret: it records whether a credential matched, never what was
  // sent. Overwritten each time, so it is a "what happened last" probe rather
  // than a log that grows.
  const authorized = postmarkAuthorized(c);
  try {
    await kv.set("postmarkhook_last", {
      at: new Date().toISOString(),
      authorized,
      secretConfigured: !!POSTMARK_WEBHOOK_SECRET,
      // Which of the two accepted credential shapes was offered, so a webhook
      // configured with neither is distinguishable from one configured wrongly.
      hadCustomHeader: !!c.req.header("x-postmark-secret"),
      hadBasicAuth: (c.req.header("authorization") || "").toLowerCase().startsWith("basic "),
      userAgent: c.req.header("user-agent") || "",
    });
  } catch { /* diagnostics must never break the webhook */ }

  try {
    if (!POSTMARK_WEBHOOK_SECRET) return c.json({ error: "Server is missing POSTMARK_WEBHOOK_SECRET" }, 500);
    if (!authorized) return c.json({ error: "Unauthorized" }, 401);

    const body = await c.req.json();
    const events = Array.isArray(body) ? body : [body];
    const results = [];
    for (const ev of events) results.push(await recordEmailEvent(ev));

    // Always 200 on a payload we accepted. A non-2xx makes Postmark retry, and
    // retrying an event we simply do not care about achieves nothing.
    return c.json({ success: true, results });
  } catch (e: any) {
    console.error("[postmark]", e?.message ?? e);
    return c.json({ error: "Failed to record event" }, 500);
  }
});

// ─── Anonymous ambassador cards ───────────────────────────────────────────────
//
// CORE RULE: the creator's identity appears nowhere in the card, the code, the
// URL, the scan page before the Reel is live, the title, or any meta tag. Only
// state B reveals it, and by then the Reel is public and tagged, so the
// creator is identifiable regardless.
//
// The practical consequence for anyone editing below: in state A, render from
// `businessName` only. Never widen that select to creator columns "just for
// logging". test-e2e.sh asserts the state A body and headers are clean.

const CARD_LIFETIME_DAYS = 60;

// Codes are matched case-insensitively and tolerate the ways a person retypes
// something read off a card: lowercase, stray hyphens, spaces.
const canonicalCode = (raw: string) => String(raw ?? "").replace(/[\s-]/g, "").toUpperCase();

// One ambassador code per creator, minted on opt-in and never rotated: the same
// code is printed on cards, shown as a QR and listed in the Ambassador tab, so
// changing it would strand every card already handed out.
//
// The unique index is what guarantees uniqueness; this retries on collision
// rather than trusting the random draw.
async function ensureAmbassadorCode(creatorId: string): Promise<string> {
  const { data: existing } = await db().from("creator_signups_f5961d0c")
    .select("ambassador_code").eq("id", creatorId).maybeSingle();
  if (existing?.ambassador_code) return existing.ambassador_code;

  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = anonCode(6);
    const { error } = await db().from("creator_signups_f5961d0c")
      .update({ ambassador_code: candidate }).eq("id", creatorId).is("ambassador_code", null);
    if (!error) {
      // The update is a no-op if another request won the race, so read back
      // rather than assuming the candidate stuck.
      const { data: after } = await db().from("creator_signups_f5961d0c")
        .select("ambassador_code").eq("id", creatorId).maybeSingle();
      if (after?.ambassador_code) return after.ambassador_code;
    }
  }
  throw new Error("Could not allocate an ambassador code");
}

async function hashIp(ip: string): Promise<string> {
  // Salted so scan rows cannot be reversed into visitor IPs by rainbow table.
  const salt = Deno.env.get("SCAN_IP_SALT") || ADMIN_SECRET || "contynt";
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${ip}`));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

// Cards exist only for approved (creator, feature) pairs, and only for creators
// who opted in. Called from claim approval, not from claiming: a card handed out
// for a shoot that was never approved would point at a Reel that never comes.
async function ensureCardForApprovedClaim(featureId: string, creatorToken: string) {
  try {
    const creatorData = await creatorFromToken(creatorToken);
    if (!creatorData?.creatorId) return null;

    const { data: creator } = await db().from("creator_signups_f5961d0c")
      .select("id, ambassador_opted_in").eq("id", creatorData.creatorId).maybeSingle();
    if (!creator?.ambassador_opted_in) return null;

    const { data: existing } = await db().from("ambassador_cards_f5961d0c")
      .select("*").eq("creator_id", creator.id).eq("feature_id", featureId).maybeSingle();
    if (existing) return existing;

    const { data: feature } = await db().from("features_f5961d0c")
      .select("id, business_id").eq("id", featureId).maybeSingle();

    // No code is minted here any more. The creator already has one, and this
    // row exists only to track handoff and attribution for the pair.
    const { data, error } = await db().from("ambassador_cards_f5961d0c").insert({
      creator_id: creator.id, feature_id: featureId,
      business_id: feature?.business_id ?? null,
    }).select("*").single();
    if (error) {
      if (String(error.message || "").includes("duplicate")) return null;
      throw error;
    }
    await logCreatorEvent(creator.id, "ambassador_card_generated", { featureId });
    return data;
  } catch (e: any) {
    // A failed card must not block the claim approval itself.
    console.error("[cards] generate failed:", e?.message ?? e);
    return null;
  }
}

// Resolves which of the three states a card is in, and returns ONLY the fields
// that state is allowed to render.
// A creator code has no single Feature behind it, so the state is derived from
// the creator's own most recent work rather than one card's Feature.
//
//   B  a Reel of theirs is live      -> show it; identity is public by now
//   A  they filmed recently          -> collect the business and an email
//   C  nothing recent                -> generic, says nothing about anyone
async function creatorScanState(creatorId: string) {
  const { data: subs } = await db().from("submissions_f5961d0c")
    .select("status, reel_url, creator_instagram, metrics, approved_at, submitted_at, feature_id")
    .eq("creator_id", creatorId)
    .order("submitted_at", { ascending: false })
    .limit(10);
  const rows = subs ?? [];

  const live = rows.find((r: any) => r.status === "approved" && r.reel_url);
  if (live) {
    const { data: feature } = await db().from("features_f5961d0c")
      .select("business_name, business_instagram").eq("id", live.feature_id).maybeSingle();
    return {
      state: "B" as const,
      businessName: feature?.business_name || "this spot",
      reelUrl: live.reel_url,
      creatorInstagram: (live.creator_instagram || "").replace(/^@+/, ""),
      metrics: live.metrics || {},
    };
  }

  const newest = rows[0]?.submitted_at ? new Date(rows[0].submitted_at).getTime() : 0;
  const recent = newest && (Date.now() - newest) / 864e5 <= CARD_LIFETIME_DAYS;
  // No submission yet is still state A: the card is handed over at the shoot,
  // so a scan usually lands before anything has been posted.
  if (!rows.length || recent) return { state: "A" as const, businessName: "" };
  return { state: "C" as const, businessName: "" };
}

// A business can arrive holding either code. The share link carries
// ambassadors.referral_code, while a printed card carries the creator's
// ambassador_code, and the two are different strings for the same creator. A
// card scan that reached the signup form used to 404 there because only the
// first was recognised, so both resolve here.
async function ambassadorByAnyCode(code: string) {
  const raw = String(code || "").trim();
  const direct = await db().from("ambassadors_f5961d0c")
    .select("*").eq("referral_code", raw).maybeSingle();
  if (direct.data) return direct.data as any;
  const creator = await db().from("creator_signups_f5961d0c")
    .select("id").eq("ambassador_code", canonicalCode(raw)).maybeSingle();
  if (!creator.data) return null;
  const byCreator = await db().from("ambassadors_f5961d0c")
    .select("*").eq("creator_id", (creator.data as any).id).maybeSingle();
  return (byCreator.data as any) ?? null;
}

// Scans are cheap to forge, so cap them per code and per IP. Counted off the
// scan log itself rather than a separate store: it is already written on every
// scan and already indexed by code and time.
const SCAN_WINDOW_MIN = 10;
const SCAN_MAX_PER_CODE = 40;
const SCAN_MAX_PER_IP = 12;
async function scanRateLimited(code: string, ipHash: string | null) {
  const since = new Date(Date.now() - SCAN_WINDOW_MIN * 60e3).toISOString();
  const byCode = await db().from("ambassador_card_scans_f5961d0c")
    .select("id", { count: "exact", head: true })
    .eq("card_code", code).gte("occurred_at", since);
  if ((byCode.count ?? 0) >= SCAN_MAX_PER_CODE) return true;
  if (!ipHash) return false;
  const byIp = await db().from("ambassador_card_scans_f5961d0c")
    .select("id", { count: "exact", head: true })
    .eq("ip_hash", ipHash).gte("occurred_at", since);
  return (byIp.count ?? 0) >= SCAN_MAX_PER_IP;
}

// Same shape as scanRateLimited and for the same reason: the log is the only
// store, so it has to defend itself. Looser per-code than the scan limit --
// a link posted to a story can legitimately be opened in bursts, where forty
// scans of one physical card in ten minutes cannot be real.
const LINK_VIEW_WINDOW_MIN = 10;
const LINK_VIEW_MAX_PER_CODE = 200;
const LINK_VIEW_MAX_PER_IP = 12;
async function linkViewRateLimited(code: string, ipHash: string | null) {
  const since = new Date(Date.now() - LINK_VIEW_WINDOW_MIN * 60e3).toISOString();
  const byCode = await db().from("ambassador_link_views_f5961d0c")
    .select("id", { count: "exact", head: true })
    .eq("referral_code", code).gte("occurred_at", since);
  if ((byCode.count ?? 0) >= LINK_VIEW_MAX_PER_CODE) return true;
  if (!ipHash) return false;
  const byIp = await db().from("ambassador_link_views_f5961d0c")
    .select("id", { count: "exact", head: true })
    .eq("ip_hash", ipHash).gte("occurred_at", since);
  return (byIp.count ?? 0) >= LINK_VIEW_MAX_PER_IP;
}

const esc = (s: any) => String(s ?? "").replace(/[&<>"']/g, m =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m] as string));

// Public scan route. Mobile in practice: a phone held behind a counter.
// Scan resolution, as JSON.
//
// This used to render the page itself, but Supabase rewrites any HTML an Edge
// Function returns to text/plain with a sandbox CSP, so a business scanning a
// card saw markup as text. The page is now rendered by the site at /a/CODE and
// calls this for the data.
app.get("/make-server-f5961d0c/scan/:code", async (c) => {
  try {
    const code = canonicalCode(c.req.param("code"));

    // The code identifies a CREATOR, not a card or a business.
    const { data: creator } = await db().from("creator_signups_f5961d0c")
      .select("id, ambassador_opted_in, instagram").eq("ambassador_code", code).maybeSingle();

    if (!creator || !creator.ambassador_opted_in) return c.json({ state: "unknown", code });

    // A creator previewing their own card must not consume a scan. There are no
    // cookies in this stack, so the portal passes its own bearer token on the
    // preview link; anything else is treated as a genuine outside scan.
    const selfToken = c.req.query("t") || "";
    let isSelfScan = false;
    if (selfToken) {
      const cd = await creatorFromToken(selfToken);
      isSelfScan = !!cd?.creatorId && String(cd.creatorId) === String(creator.id);
    }

    const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "";
    const ipHash = ip ? await hashIp(ip) : null;

    if (!isSelfScan && await scanRateLimited(code, ipHash)) {
      return c.json({ state: "throttled", code }, 429);
    }

    await db().from("ambassador_card_scans_f5961d0c").insert({
      card_code: code,
      ip_hash: ipHash,
      user_agent: c.req.header("user-agent") || "",
      is_self_scan: isSelfScan,
    });

    const st = await creatorScanState(String(creator.id));
    // A Places browser key is public by design and restricted by referrer, so
    // handing it to the page is how it is meant to be used.
    const placesKey = Deno.env.get("GOOGLE_PLACES_KEY") || "";
    // Only the stage is taken from the scan state. The rest of it describes a
    // Reel filmed at some other business, and this is a public endpoint that
    // anyone holding a code can call, so none of it goes over the wire. The
    // handle does: the page names who left the card, which is the detail that
    // makes the scan read as a real visit rather than an ad.
    return c.json({
      state: st.state, code, placesKey,
      creatorInstagram: String((creator as any).instagram || "").replace(/^@+/, ""),
    });
  } catch (e: any) {
    console.error("[scan]", e?.message ?? e);
    return c.json({ state: "error" }, 500);
  }
});

// State A capture: the business this card was left at, plus an email.
//
// The code identifies the creator, so this is also where attribution is
// recorded. Attribution is still one payout per business ever and still admin
// approved -- nothing here credits anybody.
app.post("/make-server-f5961d0c/scan/:code/lead", async (c) => {
  // Hoisted so the failure path below can park what was sent. Losing a lead is
  // the one outcome this route must not have.
  const code = canonicalCode(c.req.param("code"));
  let body: any = {};
  try {
    body = await c.req.json().catch(() => ({} as any));
    const email = String((body as any).email ?? "").trim().toLowerCase();
    const businessName = String((body as any).businessName ?? "").trim().slice(0, 120);
    const city = String((body as any).city ?? "").trim().slice(0, 80);
    // Optional on the wire so an older client still works, rejected when
    // present and unusable rather than stored as junk.
    const rawHandle = (body as any).instagram;
    const handle = rawHandle === undefined || String(rawHandle).trim() === ""
      ? "" : normalizeHandle(rawHandle);
    if (handle === null) return c.json({ error: "Enter a valid Instagram handle." }, 400);
    const placeId = String((body as any).placeId ?? "").trim().slice(0, 200) || null;
    const placeAddress = String((body as any).placeAddress ?? "").trim().slice(0, 300) || null;
    if (!email || !email.includes("@") || !businessName) {
      return c.json({ error: "A business name and email are required" }, 400);
    }

    const { data: creator } = await db().from("creator_signups_f5961d0c")
      .select("id, ambassador_opted_in, city").eq("ambassador_code", code).maybeSingle();
    if (!creator?.ambassador_opted_in) return c.json({ error: "This card is not active" }, 404);

    // Match on place_id first, then fall back to an exact name match so a lead
    // submitted without a key still has a chance of attaching rather than
    // always minting a twin.
    let business: any = null;
    let createdBusiness = false;
    if (placeId) {
      const { data } = await db().from("business_signups_f5961d0c")
        .select("id, lead_status, place_id, business_name, city").eq("place_id", placeId).maybeSingle();
      business = data ?? null;
    }
    if (!business && handle) {
      // Above the name for the same reason the other two forms put it there:
      // it is what the main signup keys on, so a business that signed up
      // through it has to land on the same row. Compared normalised in memory
      // because stored values include "@name" and full profile URLs, and
      // handles are case insensitive -- neither matches in SQL.
      const { data: all } = await db().from("business_signups_f5961d0c")
        .select("id, lead_status, place_id, instagram, city, business_name");
      const wanted = handle.toLowerCase();
      business = (all ?? []).find((r: any) =>
        (normalizeHandle(String(r.instagram ?? "")) ?? "").toLowerCase() === wanted) ?? null;
    }
    if (!business) {
      const { data } = await db().from("business_signups_f5961d0c")
        .select("id, lead_status, place_id, instagram, city, business_name").ilike("business_name", businessName).limit(1);
      business = (data ?? [])[0] ?? null;
    }

    if (business) {
      // Known business: promote a cold prospect to a lead, and backfill the
      // place_id so the next scan matches on it directly.
      const patch: Record<string, unknown> = {};
      if (business.lead_status === "prospect" || business.lead_status == null) patch.lead_status = "lead";
      if (placeId && !business.place_id) { patch.place_id = placeId; patch.place_address = placeAddress; }
      const derived = city || cityFromFormattedAddress(placeAddress);
      if (derived && !business.city) patch.city = derived;
      if (handle && !String(business.instagram ?? "").trim()) patch.instagram = handle;
      if (Object.keys(patch).length) {
        await db().from("business_signups_f5961d0c").update(patch).eq("id", business.id);
      }
    } else {
      createdBusiness = true;
      // Unknown: create it, flagged unverified. Nothing puts a Feature on the
      // board for it, so it stays invisible to creators until an admin works it.
      // instagram and city are NOT NULL with no default, so both are always sent.
      const { data: made, error: makeErr } = await db().from("business_signups_f5961d0c").insert({
        business_name: businessName,
        instagram: handle,
        email,
        // Whatever the form sent, else whatever Google's address yields, else
        // nothing. Never the creator's own city: they may be filming a town
        // over, and a wrong answer here is not visibly missing the way an
        // empty one is. The column is NOT NULL, so "".
        city: city || cityFromFormattedAddress(placeAddress),
        address: placeAddress || "",
        place_id: placeId,
        place_address: placeAddress,
        lead_status: "unverified_lead",
        referral_source: "ambassador_scan",
        referred_by_creator: creator.id,
      }).select("id, business_name, city").single();
      if (makeErr) console.error("[lead] could not create business:", makeErr.message);
      business = made ?? null;
    }

    // Attribution belongs to the creator whose code this is. The single-payout
    // rule is enforced where payouts are made, not here.
    if (business?.id) {
      await db().from("business_signups_f5961d0c")
        .update({ referred_by_creator: creator.id })
        .eq("id", business.id).is("referred_by_creator", null);
    }

    // A scan recorded attribution on the business and a row in
    // ambassador_leads, and nothing in ambassador_referrals -- which is the
    // table the Ambassadors tab counts and lists. So a creator who handed over
    // a card and signed the business up right there read as "Referred 0", with
    // no way to see the business they had just brought in. The referral link
    // route writes this row; the scan route has to as well, or the two doors
    // into the same programme disagree about what happened.
    if (business?.id) {
      const amb = await ambassadorByAnyCode(code);
      if (amb?.ambassador_id) {
        const { data: existing } = await db().from("ambassador_referrals_f5961d0c")
          .select("id").eq("ambassador_id", amb.ambassador_id).eq("business_id", business.id).limit(1);
        if (!existing?.length) {
          const now = new Date().toISOString();
          await must("scan lead: record referral", db().from("ambassador_referrals_f5961d0c").insert({
            ambassador_id: amb.ambassador_id,
            creator_id: amb.creator_id,
            creator_instagram: amb.creator_instagram || "",
            referral_code: amb.referral_code || code,
            referral_url: amb.referral_url,
            business_id: business.id,
            business_name: businessName,
            business_email: email,
            // Distinct from the link route's "ambassador", so the two ways in
            // stay tellable apart in the data even though they now agree.
            referral_source: "ambassador_scan",
            status: createdBusiness ? "business_created" : "lead_created",
            reward_amount: REFERRAL_REWARD,
            business_created_at: createdBusiness ? now : null,
          }));
        }
      }
    }

    // Unique on (business_id, email), so a second submission is a no-op rather
    // than an error the person standing at the counter has to understand.
    const { error } = await db().from("ambassador_leads_f5961d0c").insert({
      card_code: code, business_id: business?.id ?? null, email,
    });
    if (error && !String(error.message || "").includes("duplicate")) throw error;

    // Hand back a way straight into the portal, the same as the referral route
    // does. The owner is standing at their own counter with the creator; a
    // screen saying a link is on its way makes them wait on an inbox to see
    // something they could be looking at now. Reuses their live token, so a
    // link already mailed to them keeps working.
    // A code rather than a session, for the same reason the referral form does
    // it: this matches an existing business by place, handle or name, and a
    // session handed to whoever filled the form in would be a way into an
    // account belonging to somebody else.
    let verifying = false;
    if (business?.id) {
      try {
        await issueLoginCode({
          audience: "business", addr: email, to: email, subjectId: business.id,
          log: (type, payload) => logBusinessEvent(business.id, type, payload),
        });
        verifying = true;
      } catch (e: any) {
        // The lead is saved either way. A code that could not be sent is a
        // worse landing, not a lost signup, so the confirmation screen stands.
        console.error("[lead] could not send login code:", e?.message ?? e);
      }
    }
    return c.json({ ok: true, saved: true, businessId: business?.id ?? null, needsVerification: verifying });
  } catch (e: any) {
    console.error("[lead]", e?.message ?? e);
    // Never dead-end the person standing at the counter -- and never lose them
    // either. This used to answer a bare { ok: true }, which the scan page
    // reads as success, so a lead that failed to save showed a confirmation
    // screen to the owner and left no trace anywhere for anyone to chase. The
    // payload is parked so an admin can replay it, and `saved: false` tells the
    // page not to promise an email that is not coming.
    try {
      await kv.set(`leadfailed_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, {
        at: new Date().toISOString(), code,
        error: e?.message ?? String(e),
        businessName: String(body?.businessName ?? "").slice(0, 120),
        email: String(body?.email ?? "").slice(0, 254),
        instagram: String(body?.instagram ?? "").slice(0, 60),
        placeId: String(body?.placeId ?? "").slice(0, 200),
        placeAddress: String(body?.placeAddress ?? "").slice(0, 300),
      });
    } catch (parkErr: any) {
      console.error("[lead] could not park the failed lead:", parkErr?.message ?? parkErr);
    }
    return c.json({ ok: true, saved: false });
  }
});

// The parked leads above, so a failure is something an admin can see and work
// rather than a line in a log nobody reads.
app.get("/make-server-f5961d0c/admin/failed-leads", async (c) => {
  try {
    const rows = await kv.getByPrefix("leadfailed_");
    return c.json({
      leads: (rows ?? []).sort((a: any, b: any) => String(b?.at).localeCompare(String(a?.at))),
      total: (rows ?? []).length,
    });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// ─── Reel goes live ───────────────────────────────────────────────────────────
// Admin approval and business approval both put a Reel live and were carrying
// identical copies of this block. One of them would eventually gain a step the
// other lacked, so both now call through here.
async function markReelLive(sub: any) {
  const now = new Date().toISOString();
  await db().from("submissions_f5961d0c").update({ status: "approved", approved_at: now }).eq("id", sub.id);
  // The winner is settled here, but the Feature is deliberately NOT completed.
  // Both callers -- the admin sending a Reel to the business, and the business
  // approving it -- come before any money moves. Only Approve & Add to Balance
  // (/admin/approve-payout) closes the Feature, so it cannot read as finished
  // while the creator is still owed.
  await must("approve-reel: record winner", db().from("features_f5961d0c").update({
    winner_instagram: sub.creator_instagram || "",
  }).eq("id", sub.feature_id));
  await db().from("creator_claims_f5961d0c").update({ status: "approved" })
    .eq("feature_id", sub.feature_id).eq("creator_token", sub.token);
  const kvKey = `creator_claim_${sub.token}_${sub.feature_id}`;
  const existing = await kv.get(kvKey);
  if (existing) await kv.set(kvKey, { ...existing, status: "approved" });

  await notifyLeadsForFeature(sub.feature_id);
}

// TRIGGER POINT for the lead notification in section 8 of the brief.
//
// Every lead captured in state A against a card for this feature should now get
// an email from CONTYNT with the live Reel, and have notified_at stamped.
// There is no queue, job runner or mail transport in this stack yet, so the
// send itself is deliberately left unwired rather than faked: the rows are
// selected and logged so the backlog is visible and nothing is lost, and the
// moment Postmark sending exists this is the one function that changes.
async function notifyLeadsForFeature(featureId: string) {
  try {
    // Leads are filed under the CREATOR's ambassador code. This used to read
    // ambassador_cards.code, which migration 20260819030000 retired and set to
    // null on every row -- so the lookup matched nothing, and even the backlog
    // count the TODO below promised was never printed. The code moved onto the
    // creator, so that is where it is read from.
    const { data: cards } = await db().from("ambassador_cards_f5961d0c")
      .select("creator_id").eq("feature_id", featureId);
    const creatorIds = [...new Set((cards ?? []).map((r: any) => r.creator_id).filter(Boolean))];
    if (!creatorIds.length) return;

    const { data: creators } = await db().from("creator_signups_f5961d0c")
      .select("ambassador_code").in("id", creatorIds);
    const codes = (creators ?? []).map((r: any) => r.ambassador_code).filter(Boolean);
    if (!codes.length) return;

    const { data: leads } = await db().from("ambassador_leads_f5961d0c")
      .select("id, email, card_code").in("card_code", codes).is("notified_at", null);
    if (!leads?.length) return;

    // TODO(send): dispatch via Postmark, then stamp notified_at per row. Stamping
    // before a send exists would silently drop every one of these leads.
    console.log(`[leads] ${leads.length} lead(s) awaiting the live-Reel email for feature ${featureId}`);
  } catch (e: any) {
    console.error("[leads] notify failed:", e?.message ?? e);
  }
}

// ─── Card printables ──────────────────────────────────────────────────────────
// The card link is printed and read aloud, so it defaults to the short site
// origin rather than the raw function URL: getcontynt.com/a/K7M2P9 fits under a
// QR and can be typed by hand. /a/* is forwarded to this function by the site's
// _redirects, so the short form resolves here either way.
const CARD_ORIGIN = Deno.env.get("CARD_LINK_ORIGIN") || SITE_ORIGIN;
// Bare code at the root: getcontynt.com/4JEAZ7. This gets read off a card and
// typed by hand, so every character removed is one fewer to get wrong. /a/CODE
// still resolves, for cards printed before this.
const cardUrlFor = (code: string) => `${CARD_ORIGIN}/${code}`;

// Shown on the print sheet and the card screen. Plain language on purpose: the
// creator is going to be asked "what is this?" while holding it.
const ATTRIBUTION_RULE = "First scan at a spot wins. One payout per business, ever.";
// TODO(copy): placeholder handoff script. Replace with the wording you want
// creators to actually say before this ships.
const HANDOFF_SCRIPT =
  "Hey, I just filmed a Reel here for Contynt. This card has a code on it. " +
  "If you scan it you can see the Reel when it goes live, and get set up if you want more.";


// buildCardSheet() stood here: an A6 print sheet rendered by this function.
// It had no callers and could not have worked if it did -- Supabase rewrites
// any HTML an Edge Function returns to text/plain with a sandbox CSP, which is
// exactly why the sheet moved into the SPA. It was also the only reason this
// file imported npm:qrcode, so a QR library was being bundled into the edge
// deploy for code that never ran.

// The printable sheet and the on-screen QR are rendered by the site, not here.
// Supabase rewrites any HTML an Edge Function returns to text/plain with
// `content-security-policy: default-src 'none'; sandbox`, so a page served from
// this origin opens as source text in a browser. Anything a person is meant to
// look at lives in the SPA: /app?view=cards and /app?view=qr, which read the
// code from the JSON route below.

// Unsubscribe from feature announcements.
//
// Split across GET and POST for exactly the reason /portal/verify is: security
// scanners and link previewers fetch every GET in a message before a human
// sees it, so a GET that unsubscribed would silently mute creators who never
// touched the link. GET asks, POST acts.
//
// POST is also the RFC 8058 one-click endpoint. Gmail and Yahoo post
// "List-Unsubscribe=One-Click" here with nobody watching, and that has to work
// with no confirmation step, so the two paths deliberately end in the same
// place rather than the button being the only way through.
async function creatorForUnsub(c: any) {
  const id = String(c.req.query("c") || "");
  const sig = String(c.req.query("s") || "");
  if (!id || !sig) return null;
  if (!timingSafeEqual(sig, await unsubSigFor(id))) return null;
  const { data: row } = await db().from("creator_signups_f5961d0c")
    .select("id, email, notify_email").eq("id", id).maybeSingle();
  return row ?? null;
}

const unsubDeadLink = () => htmlPage({
  title: "This link is not valid", noindex: true, status: 400,
  body: `<h1>This link is not valid</h1>
    <p>Your email app may have cut it short. You can turn feature emails off from your portal at any time.</p>`,
});

app.get("/make-server-f5961d0c/portal/unsubscribe", async (c) => {
  try {
    const row = await creatorForUnsub(c);
    if (!row) return unsubDeadLink();
    const who = esc(row.email || "this address");
    if (row.notify_email === false) {
      return htmlPage({
        title: "Already unsubscribed", noindex: true,
        body: `<h1>You are unsubscribed</h1><p>We are not sending feature emails to ${who}.</p>`,
      });
    }
    return htmlPage({
      title: "Unsubscribe", noindex: true,
      body: `<h1>Stop feature emails?</h1>
        <p>We will stop emailing ${who} about new features.</p>
        <form method="POST" action="${VERIFY_ORIGIN}/portal/unsubscribe?c=${encodeURIComponent(row.id)}&amp;s=${await unsubSigFor(row.id)}">
          <button type="submit">Unsubscribe</button>
        </form>
        <p class="note">This stops every email we send, including the reminder before a Feature you are holding expires.</p>`,
    });
  } catch (e: any) {
    console.error("[unsubscribe] GET failed:", e?.message ?? e);
    return unsubDeadLink();
  }
});

app.post("/make-server-f5961d0c/portal/unsubscribe", async (c) => {
  try {
    const row = await creatorForUnsub(c);
    if (!row) return unsubDeadLink();
    // Re-running it is not an error: a mail client may one-click a link the
    // creator already used, and answering that with a failure page would be
    // both wrong and alarming.
    if (row.notify_email !== false) {
      await db().from("creator_signups_f5961d0c").update({ notify_email: false }).eq("id", row.id);
      await logCreatorEvent(row.id, "email_unsubscribed", { via: "link" });
    }
    return htmlPage({
      title: "Unsubscribed", noindex: true,
      body: `<h1>Unsubscribed</h1>
        <p>We have stopped sending email to ${esc(row.email || "this address")}.</p>
        <p class="note">Changed your mind? Turn emails back on from your portal.</p>`,
    });
  } catch (e: any) {
    console.error("[unsubscribe] POST failed:", e?.message ?? e);
    return unsubDeadLink();
  }
});

// Cards for the portal's "Print your card" step.
app.get("/make-server-f5961d0c/portal/cards", async (c) => {
  try {
    const token = c.req.query("t") || "";
    const creatorData = await creatorFromToken(token);
    if (!creatorData?.creatorId) return c.json({ error: "Invalid or expired link" }, 401);

    const { data: rows } = await db().from("ambassador_cards_f5961d0c")
      .select("*").eq("creator_id", creatorData.creatorId).order("generated_at", { ascending: false });

    return c.json({
      handoffScript: HANDOFF_SCRIPT,
      attributionRule: ATTRIBUTION_RULE,
      unprintedCount: (rows ?? []).filter((r: any) => !r.printed_at).length,
      // No `code` here any more. Migration 20260819030000 retired the
      // per-card code and nulled the column -- the code lives on the creator
      // now -- so this field was shipping null to a client that never read it.
      cards: (rows ?? []).map((r: any) => ({
        id: r.id, featureId: r.feature_id,
        printedAt: r.printed_at, handedOffAt: r.handed_off_at,
        handoffStatus: r.handoff_status, isAttributed: r.is_attributed,
      })),
    });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// ─── Creator readiness (admin) ────────────────────────────────────────────────
// Tiers are computed, never stored: they are a view over verification, contact
// preferences and ambassador consent, all of which move independently. A stored
// tier would be wrong the moment any one of them changed.
function readinessTier(r: any): "Ready+" | "Ready" | "Warm" | "Cold" {
  const confirmed = r.verification_status === "confirmed";
  const notifications = !!r.notify_email || !!r.notify_sms;
  if (confirmed && notifications && r.ambassador_opted_in) return "Ready+";
  if (confirmed && notifications) return "Ready";
  if (r.verify_link_opened_at) return "Warm";
  return "Cold";
}

app.get("/make-server-f5961d0c/admin/creator-readiness", async (c) => {
  try {
    const supabase = db();
    const [creRes, delivRes, payRes] = await Promise.all([
      supabase.from("creator_signups_f5961d0c").select("*").order("created_at", { ascending: false }),
      // Delivery is only knowable from Postmark, so it comes from the event log
      // rather than a column we would have to keep in sync.
      supabase.from("email_events_f5961d0c").select("creator_id, type").in("type", ["Delivery", "Bounce", "SpamComplaint"]),
      supabase.from("creator_payout_requests_f5961d0c").select("creator_token, payment_method"),
    ]);

    const delivered = new Set<string>(), bouncedEv = new Set<string>();
    for (const e of (delivRes.data ?? [])) {
      if (!e.creator_id) continue;
      if (e.type === "Delivery") delivered.add(e.creator_id);
      else bouncedEv.add(e.creator_id);
    }

    // "Payouts connected" means the creator has actually told us how to pay
    // them, which in this schema only ever appears on a payout request.
    const tokenRefs = await kv.getByPrefix("ctokenref_");
    const tokenFor: Record<string, string> = {};
    for (const ref of tokenRefs) if (ref?.creatorId && ref?.token) tokenFor[ref.creatorId] = ref.token;
    const payoutTokens = new Set((payRes.data ?? []).filter((r: any) => (r.payment_method || "").trim()).map((r: any) => r.creator_token));

    const rows = (creRes.data ?? []).map((r: any) => {
      const tier = readinessTier(r);
      return {
        id: r.id,
        handle: r.instagram_handle || (r.instagram || "").replace(/^@+/, ""),
        email: r.email || "",
        // Captured at signup and never asked for again, so it is the one
        // location every creator has, confirmed or not.
        city: r.city || "",
        tier,
        status: r.verification_status || "pending",
        sentAt: r.verify_email_sent_at || null,
        openedAt: r.verify_link_opened_at || null,
        openCount: r.verify_open_count ?? 0,
        confirmedAt: r.verify_confirmed_at || null,
        neighborhoods: r.service_areas || [],
        capacity: r.max_features_per_week ?? null,
        notifyEmail: !!r.notify_email, notifyDm: r.notify_dm ?? true, notifySms: !!r.notify_sms,
        ambassadorOptedIn: !!r.ambassador_opted_in,
        payoutsConnected: payoutTokens.has(tokenFor[r.id]),
        delivered: delivered.has(r.id),
        bounced: !!r.email_bounced_at || !!r.email_complained_at || bouncedEv.has(r.id),
      };
    });

    return c.json({
      funnel: {
        sent: rows.filter(r => r.sentAt).length,
        delivered: rows.filter(r => r.delivered).length,
        linkOpened: rows.filter(r => r.openedAt).length,
        confirmed: rows.filter(r => r.status === "confirmed").length,
        ambassadorOptedIn: rows.filter(r => r.ambassadorOptedIn).length,
        bounced: rows.filter(r => r.bounced).length,
      },
      neighborhoods: SF_NEIGHBORHOODS,
      creators: rows,
    });
  } catch (e: any) { return c.json({ error: "Failed to load readiness", details: e.message }, 500); }
});

// ─── Verification send ────────────────────────────────────────────────────────
const POSTMARK_SERVER_TOKEN = Deno.env.get("POSTMARK_SERVER_TOKEN") || "";
const POSTMARK_FROM = Deno.env.get("POSTMARK_FROM") || "team@getcontynt.com";
// Postmark falls back to the sender signature's own name when From carries a
// bare address, which is why these arrived from "Marcus Chan". An explicit
// display name overrides it per message, without anyone having to remember to
// change the signature in the Postmark UI. Quotes and backslashes are stripped
// rather than escaped: nothing legitimate needs them, and an unbalanced quote
// makes the whole header unparseable.
const POSTMARK_FROM_NAME = (Deno.env.get("POSTMARK_FROM_NAME") || "CONTYNT Team").replace(/["\\]/g, "");
// An address that already carries its own display name is left alone.
const POSTMARK_FROM_HEADER = POSTMARK_FROM.includes("<")
  ? POSTMARK_FROM
  : `"${POSTMARK_FROM_NAME}" <${POSTMARK_FROM}>`;
const POSTMARK_STREAM = Deno.env.get("POSTMARK_MESSAGE_STREAM") || "broadcast";
const SEND_COOLDOWN_HOURS = 24;

// ─── Email shell ──────────────────────────────────────────────────────────────
// One chrome for every message we send, so the login code and the announcement
// cannot drift apart.
//
// Deliberately old fashioned markup: tables with bgcolor attributes rather than
// divs, inline styles rather than a <style> block, and no web font. Gmail strips
// <style>, Outlook ignores background-color on a div, and a black band declared
// only in CSS is how a header turns into white text on white.
//
// A light card with a black band, rather than the site's full dark treatment. A
// dark email is at the mercy of Gmail's dark-mode inversion, and the wordmark
// and black button already read as CONTYNT without betting the legibility of the
// whole message on it.
const EMAIL_FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function emailShell(opts: { preheader: string; body: string; footerNote?: string }) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<!-- Light only. Without this, Apple Mail and Outlook invert the card and the
     black band stops being a deliberate choice. -->
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;">
<!-- Preheader: what the inbox shows next to the subject. Without it Gmail
     pulls the first line of the body, which is the greeting and says nothing.
     The zero-width padding stops it pulling body text in after this. -->
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#f4f4f5;">
${esc(opts.preheader)}${"&#8203;&zwnj;&nbsp;".repeat(30)}
</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="#f4f4f5" style="background-color:#f4f4f5;">
<tr><td align="center" style="padding:32px 16px;">

  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:100%;max-width:600px;background-color:#ffffff;border-radius:16px;overflow:hidden;">

    <!-- Wordmark. The spaces are literal, exactly as the site sets it: real
         letter-spacing is unreliable in Outlook, and spaces are not. -->
    <tr><td align="center" bgcolor="#0a0a0a" style="background-color:#0a0a0a;padding:26px 24px;">
      <span style="font-family:${EMAIL_FONT};font-size:13px;font-weight:600;color:#ffffff;letter-spacing:0.12em;">C O N T Y N T</span>
    </td></tr>

    <tr><td style="padding:34px 32px 30px 32px;font-family:${EMAIL_FONT};font-size:15px;line-height:1.65;color:#171717;">
${opts.body}
    </td></tr>

    <tr><td style="padding:0 32px;"><div style="height:1px;background-color:#e5e5e5;line-height:1px;font-size:1px;">&nbsp;</div></td></tr>

    <tr><td style="padding:20px 32px 26px 32px;font-family:${EMAIL_FONT};font-size:12px;line-height:1.6;color:#8a8a8a;">
${opts.footerNote ? `      <p style="margin:0 0 6px 0;">${opts.footerNote}</p>\n` : ""}      <p style="margin:0;">CONTYNT &middot; San Francisco</p>
    </td></tr>

  </table>

</td></tr>
</table>
</body></html>`;
}

// The bulletproof button: a table cell carries the colour so Outlook paints it,
// and the anchor carries the padding so the whole block is clickable.
const emailButton = (href: string, label: string) =>
`      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0;">
        <tr><td align="center" bgcolor="#0a0a0a" style="background-color:#0a0a0a;border-radius:12px;">
          <a href="${esc(href)}" style="display:inline-block;padding:15px 30px;font-family:${EMAIL_FONT};font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:12px;">${esc(label)}</a>
        </td></tr>
      </table>`;

// How a link is shown in an email, as opposed to how it is followed. Hosts are
// case insensitive, so capitalising the brand costs nothing and reads better in
// a paste-this-in line. Only the origin is touched: the path and query carry the
// token, which is very much case sensitive.
const prettyLink = (u: string) =>
  String(u ?? "").replace(/^https:\/\/getcontynt\.com/i, "https://GetContynt.com");

// There is no name column on creator_signups, so the handle is what a creator
// gets greeted by. It used to take only the part before the first dot or
// underscore, on the theory that it approximated a first name -- but a handle
// is not a name, and the guess reads worse than the thing it guesses from:
// @sierra.eats.8 became "Hi sierra", and @ugcwith_diana would become "Hi
// ugcwith". Nobody is truncated in the data today, which is exactly why it was
// never noticed.
//
// "there" is the last resort for a row with no handle at all, and no creator
// currently hits it.
const greetingFor = (r: any) =>
  (r.instagram_handle || (r.instagram || "").replace(/^@+/, "").trim() || "there");

// Sent on approval, and again as the reminder -- one template for both, so the
// two cannot say different things about the same account.
//
// It used to open on "the first wave of features in San Francisco is dropping
// soon", which was a launch announcement. There is no first wave any more, the
// features are already live, and a creator reading it after being approved was
// being told to wait for something that had already happened. The city was
// hardcoded too, so a creator in Los Angeles was told about San Francisco --
// their own city is not needed to say this, so it now says neither.
function renderVerificationEmail(row: any, link: string) {
  const first = greetingFor(row);
  const text =
`Hi ${first},

You have been approved.

Confirm your account and we will match you to features in your area as they go live:
${prettyLink(link)}

This link is good for 90 days and is just for you. Please do not forward it.

CONTYNT
San Francisco`;
  const html = emailShell({
    preheader: "Confirm your account and we will match you to features in your area.",
    footerNote: "You are receiving this because you signed up for Contynt.",
    body:
`      <p style="margin:0 0 16px 0;font-size:21px;line-height:1.35;font-weight:700;color:#0a0a0a;">You have been approved</p>
      <p style="margin:0 0 14px 0;">Hi ${esc(first)},</p>
      <p style="margin:0;">Confirm your account and we will match you to features in your area as they go live.</p>
${emailButton(link, "Confirm your account")}
      <p style="margin:0 0 6px 0;font-size:13px;color:#8a8a8a;">Or paste this into your browser:</p>
      <p style="margin:0 0 18px 0;font-size:13px;word-break:break-all;"><a href="${esc(link)}" style="color:#525252;">${esc(prettyLink(link))}</a></p>
      <p style="margin:0;font-size:13px;color:#8a8a8a;">This link is good for 90 days and is just for you. Please do not forward it.</p>`,
  });
  return { text, html, subject: "Confirm your Contynt account" };
}

// City is stored two ways: the creator signup form saves its dropdown as a slug
// ("san-francisco") plus free text from its Other field, while the business form
// saves proper names. A subject line reading "live in san-francisco" is the
// visible cost, so the raw value is titled before it reaches a creator.
const CITY_LABELS: Record<string, string> = {
  "san francisco": "San Francisco",
  "los angeles": "Los Angeles",
  "new york": "New York City",
  "new york city": "New York City",
};

function cityLabel(raw: any): string {
  const k = String(raw ?? "").trim().toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ");
  if (!k) return "";
  return CITY_LABELS[k] ?? k.replace(/(^|\s)\p{L}/gu, m => m.toUpperCase());
}

// The Feature drop announcement. Unlike the verification email this one goes to
// creators who are already confirmed, so it does not carry a token: it points at
// the portal they can already reach.
//
// The count is of everything currently open, not of what was released in some
// window: a Feature published through approve-business gets neither approved_at
// nor offered_at, so "released in the last N days" cannot be computed for every
// Feature and a number claimed on that basis would sometimes be wrong. The
// recency lives in the framing, which the admin makes true by sending this when
// they have just dropped something; the number is the one fact that is checked
// at send time.
function renderFeatureDropEmail(row: any, link: string, count: number, cities: string[], unsubLink?: string) {
  const first = greetingFor(row);
  const isAre = count === 1 ? "is" : "are";
  const plural = count === 1 ? "Feature" : "Features";
  // Two cities read as a list; more than two would run long in a subject line.
  const where = cities.length === 0 ? "your area"
    : cities.length <= 2 ? cities.join(" and ")
    : `${cities[0]}, ${cities[1]} and more`;

  // With nothing open the count sentence is dropped rather than printed as a
  // zero: the send no longer depends on the number, so the number has to be
  // able to be absent.
  const openLine = count > 0 ? ` There ${isAre} ${count} ${plural} open in your portal right now.` : "";

  const text =
`Hi ${first},

We just released new features in ${where}!${openLine}

Features go first come, first served!

Open your portal:
${prettyLink(link)}

CONTYNT
San Francisco${unsubLink ? `\n\nStop these emails: ${unsubLink}` : ""}`;

  const html = emailShell({
    preheader: count > 0
      ? `${count} ${plural} ${isAre} open in your portal right now.`
      : `New features just landed in ${where}.`,
    // The visible link matters as much as the header. The header is what Gmail
    // grades, but a reader who cannot find a way out reaches for "report spam"
    // instead, and one complaint costs more than every unsubscribe it prevents.
    footerNote: unsubLink
      ? `You are receiving this because you asked to hear about features by email. <a href="${esc(unsubLink)}" style="color:#8a8a8a;text-decoration:underline;">Unsubscribe</a>.`
      : "You are receiving this because you asked to hear about features by email.",
    body:
`      <p style="margin:0 0 16px 0;font-size:21px;line-height:1.35;font-weight:700;color:#0a0a0a;">New features just dropped</p>
      <p style="margin:0 0 14px 0;">Hi ${esc(first)},</p>
      <p style="margin:0 0 14px 0;">We just released new features in ${esc(where)}!${count > 0 ? ` There ${isAre} <strong>${count} ${plural}</strong> open in your portal right now.` : ""}</p>
      <p style="margin:0;">Features go first come, first served!</p>
${emailButton(link, "Open your portal")}
      <p style="margin:0 0 6px 0;font-size:13px;color:#8a8a8a;">Or paste this into your browser:</p>
      <p style="margin:0;font-size:13px;word-break:break-all;"><a href="${esc(link)}" style="color:#525252;">${esc(prettyLink(link))}</a></p>`,
  });

  return { text, html, subject: `New features just dropped in ${where}` };
}

// Both claim emails are about one creator's own Feature, so they go on the
// transactional stream, not the broadcast one the drop announcement uses. A
// creator who muted announcements has not asked to stop hearing that the thing
// they are holding is about to lapse.
// A one-off announcement: the submit window went from 5 days to 7. Its own
// template rather than a general "announcement" one, because a generic body
// with an admin-typed message in it is how a broadcast ends up saying
// something nobody proofread.
function renderSubmitWindowEmail(row: any, link: string, unsubLink?: string) {
  const first = greetingFor(row);
  // Plain rather than playful. An earlier draft opened "You asked. We caved.",
  // which was funnier and put the joke ahead of the news; this is the one piece
  // of unambiguously good news the product has ever sent creators, and it does
  // not need help landing.
  //
  // Both numbers read from the constants, so a further change to either window
  // rewrites this email rather than leaving it to be found later.
  const text =
`Hi ${first},

The window to film and submit a Reel is now ${CLAIM_DAYS} days, up from five.

It was the most asked-for change, and five days left no room for a reshoot.

Accepting a feature still has a ${ACCEPTANCE_HOURS} hour window, so do that one promptly.

Open your portal:
${prettyLink(link)}

CONTYNT
San Francisco${unsubLink ? `\n\nStop these emails: ${unsubLink}` : ""}`;
  const html = emailShell({
    preheader: `The window to film and submit a Reel is now ${CLAIM_DAYS} days.`,
    footerNote: unsubLink
      ? `You are receiving this because you signed up for Contynt. <a href="${esc(unsubLink)}" style="color:#8a8a8a;text-decoration:underline;">Unsubscribe</a>.`
      : "You are receiving this because you signed up for Contynt.",
    body:
`      <p style="margin:0 0 16px 0;font-size:21px;line-height:1.35;font-weight:700;color:#0a0a0a;">More time to film</p>
      <p style="margin:0 0 14px 0;">Hi ${esc(first)},</p>
      <p style="margin:0 0 14px 0;">The window to film and submit a Reel is now <strong>${CLAIM_DAYS} days</strong>, up from five.</p>
      <p style="margin:0 0 14px 0;">It was the most asked-for change, and five days left no room for a reshoot.</p>
      <p style="margin:0;">Accepting a feature still has a ${ACCEPTANCE_HOURS} hour window, so do that one promptly.</p>
${emailButton(link, "Open your portal")}`,
  });
  return { text, html, subject: `The filming window is now ${CLAIM_DAYS} days` };
}

// A nudge to open the portal, sendable any time.
//
// Distinct from the feature drop, which announces a specific release and says
// how many. This one carries no count, so it does not go stale and does not
// need there to be news -- its job is the seventeen creators who signed up,
// confirmed, and then never requested anything.
//
// The pull is the actual mechanic rather than enthusiasm about it: features go
// to whoever asks first, so checking often is most of what separates a creator
// who films from one who does not. That is true, and it is the reason to open
// the thing.
function renderPortalNudgeEmail(row: any, link: string, unsubLink?: string) {
  const first = greetingFor(row);
  const text =
`Hi ${first},

Features go to whoever asks first, so checking often is most of the job.

Your earnings, a cash out button and your ambassador link are in there too.

Worth a look today:
${prettyLink(link)}

CONTYNT
San Francisco${unsubLink ? `\n\nStop these emails: ${unsubLink}` : ""}`;
  const html = emailShell({
    preheader: "Features go to whoever asks first. Your earnings are in there too.",
    footerNote: unsubLink
      ? `You are receiving this because you signed up for Contynt. <a href="${esc(unsubLink)}" style="color:#8a8a8a;text-decoration:underline;">Unsubscribe</a>.`
      : "You are receiving this because you signed up for Contynt.",
    body:
`      <p style="margin:0 0 16px 0;font-size:21px;line-height:1.35;font-weight:700;color:#0a0a0a;">Your portal, in a minute</p>
      <p style="margin:0 0 14px 0;">Hi ${esc(first)},</p>
      <p style="margin:0 0 14px 0;">Features go to whoever asks first, so checking often is most of the job.</p>
      <p style="margin:0;">Your earnings, a cash out button and your ambassador link are in there too.</p>
${emailButton(link, "Open your portal")}`,
  });
  return { text, html, subject: "Features go to whoever asks first" };
}

function renderSelectedEmail(row: any, feature: any, link: string, hoursToAccept: number) {
  const first = greetingFor(row);
  const where = [feature?.business_name, cityLabel(feature?.city)].filter(Boolean).join(", ");
  const text =
`Hi ${first},

The feature at ${where} is yours to film if you want it.

You have ${hoursToAccept} hours to accept it.

Leave it and it goes back to everyone else.

Accept it here:
${prettyLink(link)}

CONTYNT
San Francisco`;
  const html = emailShell({
    preheader: `Accept within ${hoursToAccept} hours to keep it.`,
    body:
`      <p style="margin:0 0 16px 0;font-size:21px;line-height:1.35;font-weight:700;color:#0a0a0a;">Your feature at ${esc(where)}</p>
      <p style="margin:0 0 14px 0;">Hi ${esc(first)},</p>
      <p style="margin:0 0 14px 0;">The feature at <strong>${esc(where)}</strong> is yours to film if you want it.</p>
      <p style="margin:0 0 14px 0;">You have ${hoursToAccept} hours to accept it.</p>
      <p style="margin:0;">Leave it and it goes back to everyone else.</p>
${emailButton(link, "Accept the feature")}
      <p style="margin:0 0 6px 0;font-size:13px;color:#8a8a8a;">Or paste this into your browser:</p>
      <p style="margin:0;font-size:13px;word-break:break-all;"><a href="${esc(link)}" style="color:#525252;">${esc(prettyLink(link))}</a></p>`,
  });
  return { text, html, subject: `Accept within ${hoursToAccept} hours: ${where}` };
}

// One template for both deadlines. What changes is what runs out and what the
// creator has to do about it, so those are the arguments.
function renderClaimExpiryEmail(row: any, feature: any, link: string, opts: {
  hoursLeft: number; kind: "accept" | "submit"; midpoint?: boolean;
}) {
  const first = greetingFor(row);
  const where = [feature?.business_name, cityLabel(feature?.city)].filter(Boolean).join(", ");
  // "You have 120 hours left" is a number nobody converts. Past two days it is
  // read in days, which is also how the window was described to them.
  const hrs = opts.hoursLeft >= 48
    ? `${Math.round(opts.hoursLeft / 24)} days`
    : opts.hoursLeft === 1 ? "1 hour" : `${opts.hoursLeft} hours`;
  // The verb and its preposition travel together, or the sentence reads
  // "accept it for Poop Cafe".
  //
  // The midpoint nudge is deliberately not written as a warning. Nothing is
  // wrong at the halfway mark and the deadline is days away; leading with
  // "about to expire" there spends the alarm early and makes the real warning
  // read as a repeat.
  const what = opts.kind === "accept"
    ? { head: "Your feature is about to expire", act: "accept the feature", prep: "at",
        lost: "it goes back to everyone else", cta: "Accept the feature" }
    : opts.midpoint
    ? { head: "Still time to film", act: "submit your Reel", prep: "for",
        lost: "the feature is released", cta: "Submit your Reel" }
    : { head: "Your feature is about to expire", act: "submit your Reel", prep: "for",
        lost: "the feature is released", cta: "Submit your Reel" };

  const text =
`Hi ${first},

You have ${hrs} left to ${what.act} ${what.prep} ${where}.

After that ${what.lost}.

${prettyLink(link)}

CONTYNT
San Francisco`;
  const html = emailShell({
    preheader: `${hrs} left to ${what.act}.`,
    body:
`      <p style="margin:0 0 16px 0;font-size:21px;line-height:1.35;font-weight:700;color:#0a0a0a;">${esc(what.head)}</p>
      <p style="margin:0 0 14px 0;">Hi ${esc(first)},</p>
      <p style="margin:0 0 14px 0;">You have <strong>${hrs}</strong> left to ${esc(what.act)} ${esc(what.prep)} ${esc(where)}.</p>
      <p style="margin:0;">After that ${esc(what.lost)}.</p>
${emailButton(link, what.cta)}
      <p style="margin:0 0 6px 0;font-size:13px;color:#8a8a8a;">Or paste this into your browser:</p>
      <p style="margin:0;font-size:13px;word-break:break-all;"><a href="${esc(link)}" style="color:#525252;">${esc(prettyLink(link))}</a></p>`,
  });
  return { text, html, subject: `${hrs} left: ${where}` };
}

// Resolves the creator behind a claim and sends, or says why it did not. Shared
// so selection and both reminders cannot drift on who is skipped: a suppressed
// address, or a creator who turned email off, is skipped in all three.
// Who a claim's token belongs to, as opposed to who is currently signed in on
// it. Those are different questions and this file already says so: ctokenref_
// is the record of identity and ctoken_ the record of a live session, and only
// the second is disposable.
//
// Everything that mails a claimant was asking the second question. A creator
// who signed out had their ctoken_ deleted -- the claim rows keyed to the same
// string survive, which is the whole point of the split -- so resolving them
// returned null and they were silently not mailed. Not an edge case: it hit
// selection and both expiry reminders, and it singled out exactly the people
// who most need an email, since a creator sitting in the portal can see the
// Feature turn up without one and a signed-out creator cannot.
//
// The session is still tried first because it is one indexed read. The
// fallback is a scan of ctokenref_, which is keyed by creator id and so cannot
// be looked up by token -- creators number in the hundreds and this runs once
// per message, not once per request.
async function creatorIdForClaimToken(token: string): Promise<string> {
  if (!token) return "";
  const session = await creatorFromToken(token);
  if (session?.creatorId) return String(session.creatorId);
  const refs = await kv.getByPrefix("ctokenref_").catch(() => []);
  const owner = (refs ?? []).find((r: any) => r?.token === token);
  return owner?.creatorId ? String(owner.creatorId) : "";
}

async function mailClaimCreator(opts: {
  creatorToken: string; featureId: string;
  build: (creator: any, feature: any, link: string) => { subject: string; html: string; text: string };
}): Promise<{ ok: true; messageId: string | null } | { ok: false; reason: string }> {
  const creatorId = await creatorIdForClaimToken(opts.creatorToken);
  if (!creatorId) return { ok: false, reason: "no creator owns that claim token" };

  const [{ data: creator }, { data: feature }] = await Promise.all([
    db().from("creator_signups_f5961d0c").select("*").eq("id", creatorId).maybeSingle(),
    db().from("features_f5961d0c").select("id, business_name, city").eq("id", opts.featureId).maybeSingle(),
  ]);
  if (!creator) return { ok: false, reason: "creator not found" };
  const to = String(creator.email ?? "").trim();
  if (!to) return { ok: false, reason: "no email" };
  if (creator.email_bounced_at || creator.email_complained_at) return { ok: false, reason: "suppressed" };
  if (creator.notify_email === false) return { ok: false, reason: "email notifications off" };
  if (!POSTMARK_SERVER_TOKEN) return { ok: false, reason: "POSTMARK_SERVER_TOKEN not set" };

  const link = `${SITE_ORIGIN}/app?creator=${encodeURIComponent(opts.creatorToken)}`;
  const sent = await postmarkSend({ to, ...opts.build(creator, feature, link), stream: POSTMARK_TRANSACTIONAL_STREAM });
  if (!sent.ok) return { ok: false, reason: sent.error || "Postmark rejected the message" };
  return { ok: true, messageId: sent.payload?.MessageID ?? null };
}

// Postmark separates broadcast and transactional streams, and sending on the
// wrong one is not cosmetic: broadcast messages carry unsubscribe headers and
// are rate shaped for bulk. A login code is transactional and must not go out
// on the same stream as the announcement email.
const POSTMARK_TRANSACTIONAL_STREAM = Deno.env.get("POSTMARK_TRANSACTIONAL_STREAM") || "outbound";

async function postmarkSend(opts: { to: string; subject: string; html: string; text: string; stream: string; headers?: Record<string, string> }) {
  if (!POSTMARK_SERVER_TOKEN) return { ok: false, error: "POSTMARK_SERVER_TOKEN not set", payload: {} as any };
  try {
    const res = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json", "Accept": "application/json",
        "X-Postmark-Server-Token": POSTMARK_SERVER_TOKEN,
      },
      body: JSON.stringify({
        From: POSTMARK_FROM_HEADER, To: opts.to, Subject: opts.subject,
        HtmlBody: opts.html, TextBody: opts.text, MessageStream: opts.stream,
        ...(opts.headers && Object.keys(opts.headers).length
          ? { Headers: Object.entries(opts.headers).map(([Name, Value]) => ({ Name, Value })) }
          : {}),
      }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: payload?.Message || `Postmark ${res.status}`, payload };
    return { ok: true, error: "", payload };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e), payload: {} as any };
  }
}

// Shared by the admin bulk actions and scripts/send-verification.sh, so a fix to
// the idempotency guard cannot land in one path and miss the other.
async function sendVerificationBatch(opts: {
  creatorIds?: string[]; reminderOnly?: boolean; dryRun?: boolean; limit?: number;
}) {
  const supabase = db();
  let q = supabase.from("creator_signups_f5961d0c").select("*");
  if (opts.creatorIds?.length) q = q.in("id", opts.creatorIds);
  // A reminder is for people who opened nothing or stalled, never for the
  // already-confirmed.
  if (opts.reminderOnly) q = q.neq("verification_status", "confirmed");
  const { data: rows, error } = await q;
  if (error) throw error;

  const results: any[] = [];
  const cutoff = Date.now() - SEND_COOLDOWN_HOURS * 3600e3;

  for (const r of (rows ?? []).slice(0, opts.limit ?? 500)) {
    const email = (r.email || "").trim();
    if (!email) { results.push({ id: r.id, skipped: "no email" }); continue; }
    if (r.email_bounced_at || r.email_complained_at) { results.push({ id: r.id, email, skipped: "suppressed" }); continue; }
    // Never twice within 24 hours. This is the guard that makes re-running the
    // script after a partial failure safe.
    if (r.verify_email_sent_at && new Date(r.verify_email_sent_at).getTime() > cutoff) {
      results.push({ id: r.id, email, skipped: "sent within 24h" });
      continue;
    }

    // A fresh token invalidates the previous one: one live link per creator.
    const token = secureToken(32);
    const link = verifyLinkFor(token);
    const rendered = renderVerificationEmail(r, link);

    if (opts.dryRun) {
      results.push({ id: r.id, email, link, subject: rendered.subject, dryRun: true });
      continue;
    }

    if (!POSTMARK_SERVER_TOKEN) {
      results.push({ id: r.id, email, link, skipped: "POSTMARK_SERVER_TOKEN not set" });
      continue;
    }

    try {
      // Sent BEFORE the new token is stored. The other order is what ran here
      // until now, and it is the same bug the resend form was fixed for: a new
      // token retires the link the creator already has, so a send that failed
      // left them holding a dead link and no replacement. Failing this way
      // round costs nothing -- their existing link keeps working and the next
      // sweep tries again.
      const sent = await postmarkSend({ to: email, ...rendered, stream: POSTMARK_TRANSACTIONAL_STREAM });
      const payload = sent.payload;
      if (!sent.ok) { results.push({ id: r.id, email, error: sent.error }); continue; }

      await must("send: issue token", supabase.from("creator_signups_f5961d0c").update({
        verify_token: token,
        verify_token_expires_at: new Date(Date.now() + VERIFY_DAYS * 864e5).toISOString(),
      }).eq("id", r.id));

      // Stamped only after Postmark accepted it, so a failed send does not burn
      // the 24 hour cooldown.
      await supabase.from("creator_signups_f5961d0c")
        .update({ verify_email_sent_at: new Date().toISOString() }).eq("id", r.id);
      await logCreatorEvent(r.id, "verify_email_sent", { messageId: payload?.MessageID ?? null, reminder: !!opts.reminderOnly });
      results.push({ id: r.id, email, sent: true, messageId: payload?.MessageID ?? null });
    } catch (e: any) {
      results.push({ id: r.id, email, error: e?.message ?? String(e) });
    }
  }

  return {
    dryRun: !!opts.dryRun,
    considered: rows?.length ?? 0,
    sent: results.filter(r => r.sent).length,
    skipped: results.filter(r => r.skipped).length,
    failed: results.filter(r => r.error).length,
    results,
  };
}

app.post("/make-server-f5961d0c/admin/verification/send", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const out = await sendVerificationBatch({
      creatorIds: Array.isArray(body.creatorIds) ? body.creatorIds : undefined,
      reminderOnly: !!body.reminderOnly,
      dryRun: !!body.dryRun,
      limit: Number(body.limit) || undefined,
    });
    return c.json({ success: true, ...out });
  } catch (e: any) { return c.json({ error: "Send failed", details: e.message }, 500); }
});

// Feature drop announcement. Deliberately narrower than the verification batch:
// that one is how a stranger becomes a creator, this one is a broadcast to
// people already on board, so it only ever goes to a confirmed creator who
// asked for email. Sending it to anyone else would be marketing to someone who
// never agreed to hear from us this way.
async function sendFeatureDropBatch(opts: { creatorIds?: string[]; dryRun?: boolean; limit?: number; featureCount?: number }) {
  const supabase = db();

  // The number in the email is the admin's to state. A Feature can be published
  // moments after this goes out, or live somewhere this query does not see, so
  // the row count is read only as a cross check and to name the cities -- it
  // neither gates the send nor overrides what was typed.
  const { data: openFeatures } = await supabase.from("features_f5961d0c")
    .select("id, city, status, early_access_until").eq("status", "available");
  const liveCount = (openFeatures ?? []).length;
  const supplied = Number(opts.featureCount);
  const count = Number.isInteger(supplied) && supplied >= 0 ? supplied : liveCount;
  const cities = [...new Set((openFeatures ?? []).map((f: any) => cityLabel(f.city)).filter(Boolean))].sort();

  let q = supabase.from("creator_signups_f5961d0c").select("*");
  if (opts.creatorIds?.length) q = q.in("id", opts.creatorIds);
  const { data: rows, error } = await q;
  if (error) throw error;

  const results: any[] = [];
  const cutoff = Date.now() - SEND_COOLDOWN_HOURS * 3600e3;

  for (const r of (rows ?? []).slice(0, opts.limit ?? 500)) {
    const email = (r.email || "").trim();
    if (!email) { results.push({ id: r.id, skipped: "no email" }); continue; }
    if (r.email_bounced_at || r.email_complained_at) { results.push({ id: r.id, email, skipped: "suppressed" }); continue; }
    // Confirmation is deliberately not required. It gates the profile flow, not
    // consent: the verification email goes to unconfirmed creators too, and
    // everyone here asked for early access. Requiring it made this button
    // unusable until somebody had confirmed, which is the wrong dependency for
    // an announcement. Consent is the two checks around this comment -- a
    // suppressed address, and the creator's own email preference.
    if (r.notify_email === false) { results.push({ id: r.id, email, skipped: "email notifications off" }); continue; }
    if (r.feature_drop_sent_at && new Date(r.feature_drop_sent_at).getTime() > cutoff) {
      results.push({ id: r.id, email, skipped: "sent within 24h" });
      continue;
    }

    // Reuses their live portal token, so this link does not invalidate the one
    // already sitting in their inbox.
    const portalToken = await ensureCreatorPortalToken(r);
    const link = `${SITE_ORIGIN}/app?creator=${encodeURIComponent(portalToken)}`;
    const unsubLink = await unsubLinkFor(r.id);
    const rendered = renderFeatureDropEmail(r, link, count, cities, unsubLink);

    if (opts.dryRun) {
      results.push({ id: r.id, email, link, subject: rendered.subject, dryRun: true });
      continue;
    }
    if (!POSTMARK_SERVER_TOKEN) {
      results.push({ id: r.id, email, link, skipped: "POSTMARK_SERVER_TOKEN not set" });
      continue;
    }

    try {
      // RFC 8058. Gmail and Yahoo check for both of these on bulk mail, and the
      // pair is what makes a mail client show its own Unsubscribe control next
      // to the sender -- the button that is not "report spam".
      const sent = await postmarkSend({
        to: email, ...rendered, stream: POSTMARK_STREAM,
        headers: {
          "List-Unsubscribe": `<${unsubLink}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      });
      if (!sent.ok) { results.push({ id: r.id, email, error: sent.error }); continue; }
      // Stamped only after Postmark accepted, so a failed send does not burn the
      // cooldown and the batch can simply be re-run.
      await supabase.from("creator_signups_f5961d0c")
        .update({ feature_drop_sent_at: new Date().toISOString() }).eq("id", r.id);
      await logCreatorEvent(r.id, "feature_drop_sent", {
        messageId: sent.payload?.MessageID ?? null, featureCount: count, cities,
      });
      results.push({ id: r.id, email, sent: true, messageId: sent.payload?.MessageID ?? null });
    } catch (e: any) {
      results.push({ id: r.id, email, error: e?.message ?? String(e) });
    }
  }

  const sentCount = results.filter(r => r.sent).length;
  return {
    dryRun: !!opts.dryRun,
    // Named once, at the top, when nothing went out. A reason repeated per
    // creator is a reason nobody reads.
    problem: !opts.dryRun && sentCount === 0
      ? (!POSTMARK_SERVER_TOKEN
          ? "POSTMARK_SERVER_TOKEN is not set on the server, so nothing can be sent."
          : rows?.length ? "Every selected creator was skipped." : "No creators were selected.")
      : null,
    // Both are reported so the caller can say when the number that went out
    // does not match what is actually open.
    featureCount: count, liveCount, cities,
    considered: rows?.length ?? 0,
    sent: results.filter(r => r.sent).length,
    skipped: results.filter(r => r.skipped).length,
    failed: results.filter(r => r.error).length,
    results,
  };
}

// The submit-window announcement, sent on the broadcast stream with the same
// guards the feature drop uses: no address, a hard suppression, or the
// creator's own email preference all stop it.
//
// Idempotency comes off the event log rather than a new stamp column. This is
// a one-off -- a column for it would outlive the announcement by years -- and
// the log already answers "has this person had it" durably, in one read for
// the whole batch.
const SUBMIT_WINDOW_EVENT = "submit_window_notice_sent";
// Declared up here beside its sibling rather than next to the batch that
// writes it: BROADCAST_EVENTS below names both, and a const read before its
// declaration is a ReferenceError at module load, which takes down every
// route in the function rather than just this one.
const PORTAL_NUDGE_EVENT = "portal_nudge_sent";

async function sendSubmitWindowBatch(opts: { creatorIds?: string[]; dryRun?: boolean; limit?: number }) {
  const supabase = db();
  let q = supabase.from("creator_signups_f5961d0c").select("*");
  if (opts.creatorIds?.length) q = q.in("id", opts.creatorIds);
  const { data: rows, error } = await q;
  if (error) throw error;

  const { data: already } = await supabase.from("creator_events_f5961d0c")
    .select("creator_id").eq("type", SUBMIT_WINDOW_EVENT);
  const alreadySent = new Set((already ?? []).map((e: any) => String(e.creator_id)));

  const results: any[] = [];
  for (const r of (rows ?? []).slice(0, opts.limit ?? 500)) {
    const email = (r.email || "").trim();
    if (!email) { results.push({ id: r.id, skipped: "no email" }); continue; }
    if (r.email_bounced_at || r.email_complained_at) { results.push({ id: r.id, email, skipped: "suppressed" }); continue; }
    if (r.notify_email === false) { results.push({ id: r.id, email, skipped: "email notifications off" }); continue; }
    if (alreadySent.has(String(r.id))) { results.push({ id: r.id, email, skipped: "already sent" }); continue; }

    const portalToken = await ensureCreatorPortalToken(r);
    const link = `${SITE_ORIGIN}/app?creator=${encodeURIComponent(portalToken)}`;
    const unsubLink = await unsubLinkFor(r.id);
    const rendered = renderSubmitWindowEmail(r, link, unsubLink);

    if (opts.dryRun) {
      results.push({ id: r.id, email, link, subject: rendered.subject, dryRun: true });
      continue;
    }

    try {
      const sent = await postmarkSend({
        to: email, ...rendered, stream: POSTMARK_STREAM,
        headers: {
          "List-Unsubscribe": `<${unsubLink}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      });
      if (!sent.ok) { results.push({ id: r.id, email, error: sent.error }); continue; }
      // Stamped only after Postmark accepts it, so a failure can be retried by
      // pressing the button again rather than being recorded as delivered.
      await logCreatorEvent(r.id, SUBMIT_WINDOW_EVENT, { messageId: sent.payload?.MessageID ?? null });
      results.push({ id: r.id, email, sent: true, messageId: sent.payload?.MessageID ?? null });
    } catch (e: any) {
      results.push({ id: r.id, email, error: e?.message ?? String(e) });
    }
  }

  const sentCount = results.filter(r => r.sent).length;
  return {
    dryRun: !!opts.dryRun,
    problem: !opts.dryRun && sentCount === 0
      ? (!POSTMARK_SERVER_TOKEN
          ? "POSTMARK_SERVER_TOKEN is not set on the server, so nothing can be sent."
          : rows?.length ? "Every selected creator was skipped." : "No creators were selected.")
      : null,
    considered: rows?.length ?? 0,
    sent: sentCount,
    skipped: results.filter(r => r.skipped).length,
    failed: results.filter(r => r.error).length,
    results,
  };
}

// Same shape as the feature-drop pair: prove the whole path on one address
// first, then point it at everybody.
// Who a test send should be addressed to.
//
// Both test routes used to hard-code the handle "there", so pressing "send to
// me only" produced "Hi there," -- the one greeting a real creator never sees,
// on the send whose whole purpose is showing what a real creator sees.
//
// The address is the admin's own, so looking it up leaks nothing: if it belongs
// to a creator the test renders exactly what that person would get, and
// otherwise the local part of their address stands in, which at least looks
// like a greeting rather than a placeholder.
async function testRecipientRow(to: string) {
  const { data } = await db().from("creator_signups_f5961d0c")
    .select("instagram, instagram_handle").ilike("email", to).maybeSingle();
  if (data) return data;
  return { instagram_handle: to.split("@")[0] || "there" };
}

app.post("/make-server-f5961d0c/admin/submit-window-notice/test", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const to = String(body.to ?? "").trim().toLowerCase();
    if (!to || !to.includes("@")) return c.json({ error: "Enter an address to send the test to." }, 400);
    if (!POSTMARK_SERVER_TOKEN) return c.json({ error: "POSTMARK_SERVER_TOKEN is not set, so nothing can be sent." }, 400);
    // Inert on both counts: the signed-out portal rather than somebody's token,
    // and an unsubscribe link that belongs to nobody.
    const exampleUnsub = `${VERIFY_ORIGIN}/portal/unsubscribe?c=example&s=example`;
    const rendered = renderSubmitWindowEmail(await testRecipientRow(to), `${SITE_ORIGIN}/app`, exampleUnsub);
    const sent = await postmarkSend({
      to, ...rendered, stream: POSTMARK_STREAM,
      headers: {
        "List-Unsubscribe": `<${exampleUnsub}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });
    if (!sent.ok) return c.json({ error: sent.error || "Postmark rejected the message." }, 502);
    return c.json({ success: true, to, subject: rendered.subject });
  } catch (e: any) { return c.json({ error: "Test send failed", details: e.message }, 500); }
});

app.post("/make-server-f5961d0c/admin/submit-window-notice/send", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const out = await sendSubmitWindowBatch({
      creatorIds: Array.isArray(body.creatorIds) ? body.creatorIds : undefined,
      dryRun: !!body.dryRun,
      limit: Number(body.limit) || undefined,
    });
    return c.json({ success: true, ...out });
  } catch (e: any) { return c.json({ error: "Send failed", details: e.message }, 500); }
});

// Sends the real drop email, rendered exactly as a creator would receive it, to
// one address of the admin's choosing. Nothing is stamped and no creator is
// touched, so the whole path -- template, Postmark, stream, sender signature --
// can be proven before it is pointed at anybody.
app.post("/make-server-f5961d0c/admin/feature-drop/test", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const to = String(body.to ?? "").trim().toLowerCase();
    if (!to || !to.includes("@")) return c.json({ error: "Enter an address to send the test to." }, 400);
    if (!POSTMARK_SERVER_TOKEN) return c.json({ error: "POSTMARK_SERVER_TOKEN is not set, so nothing can be sent." }, 400);

    const { data: openFeatures } = await db().from("features_f5961d0c")
      .select("id, city, status").eq("status", "available");
    const liveCount = (openFeatures ?? []).length;
    const supplied = Number(body.featureCount);
    const count = Number.isInteger(supplied) && supplied >= 0 ? supplied : liveCount;
    const cities = [...new Set((openFeatures ?? []).map((f: any) => cityLabel(f.city)).filter(Boolean))].sort();

    // A real portal link would sign the recipient in as whichever creator it
    // belonged to, so the test carries the signed-out portal instead.
    const exampleUnsub = `${VERIFY_ORIGIN}/portal/unsubscribe?c=example&s=example`;
    const rendered = renderFeatureDropEmail(await testRecipientRow(to), `${SITE_ORIGIN}/app`, count, cities, exampleUnsub);
    // Carries the real headers, not just the real body. Postmark rejecting a
    // custom List-Unsubscribe is the one failure this test can catch that
    // reading the message cannot, and it is better caught here than on a batch.
    // The link itself is deliberately inert: this goes to whoever pressed the
    // button, and a working one would unsubscribe a creator who is not them.
    const sent = await postmarkSend({
      to, ...rendered, stream: POSTMARK_STREAM,
      headers: {
        "List-Unsubscribe": `<${exampleUnsub}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });
    if (!sent.ok) return c.json({ error: sent.error || "Postmark rejected the message." }, 502);
    return c.json({ success: true, to, featureCount: count, liveCount, cities, subject: rendered.subject });
  } catch (e: any) { return c.json({ error: "Test send failed", details: e.message }, 500); }
});

app.post("/make-server-f5961d0c/admin/feature-drop/send", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const out = await sendFeatureDropBatch({
      creatorIds: Array.isArray(body.creatorIds) ? body.creatorIds : undefined,
      dryRun: !!body.dryRun,
      limit: Number(body.limit) || undefined,
      featureCount: body.featureCount === undefined ? undefined : Number(body.featureCount),
    });
    return c.json({ success: true, ...out });
  } catch (e: any) { return c.json({ error: "Send failed", details: e.message }, 500); }
});

// What has actually been mailed to creators, newest first. Every send already
// writes a creator event, so this is a read of the record rather than a second
// ledger that could disagree with it.
//
// Only the broadcast kinds. Login codes and selection notices are transactional
// and fire on their own; listing them here would bury the handful of sends an
// admin actually chose to make under hundreds they did not.
const BROADCAST_EVENTS = ["verify_email_sent", "feature_drop_sent", SUBMIT_WINDOW_EVENT, PORTAL_NUDGE_EVENT];

app.get("/make-server-f5961d0c/admin/email/history", async (c) => {
  try {
    const limit = Math.min(Math.max(Number(c.req.query("limit") || 100), 1), 500);
    // occurred_at, not created_at. This table has never had a created_at, and
    // asking for one fails the whole select rather than returning null for it,
    // so the panel could only ever say it could not load.
    const { data, error } = await db().from("creator_events_f5961d0c")
      .select("creator_id, type, payload, occurred_at")
      .in("type", BROADCAST_EVENTS)
      .order("occurred_at", { ascending: false }).limit(limit);
    if (error) throw error;

    // Resolved to handles here rather than in the dashboard: an id is not
    // something anybody recognises, and this is one query for the whole page.
    const ids = [...new Set((data ?? []).map((e: any) => String(e.creator_id)))];
    const handleById: Record<string, string> = {};
    if (ids.length) {
      const { data: creators } = await db().from("creator_signups_f5961d0c")
        .select("id, instagram, instagram_handle").in("id", ids);
      for (const r of (creators ?? [])) {
        handleById[String(r.id)] = r.instagram_handle || (r.instagram || "").replace(/^@+/, "") || "";
      }
    }
    return c.json({
      events: (data ?? []).map((e: any) => ({
        type: e.type, at: e.occurred_at,
        handle: handleById[String(e.creator_id)] || "",
        reminder: !!e.payload?.reminder,
      })),
    });
  } catch (e: any) { return c.json({ error: "Failed to fetch email history", details: e.message }, 500); }
});

// The webhook writes a record of every delivery to stripehook_last, including
// whether the signature verified. Nothing read it, so the one fact that would
// have explained a silent billing outage sat in the KV store while Stripe
// emailed about failures eleven days later.
//
// Read-only and derived entirely from that record. It deliberately does not
// call Stripe: the question here is what reached us and whether we accepted it,
// which is answerable without a round trip and stays answerable when the key
// itself is the thing that is wrong.
app.get("/make-server-f5961d0c/admin/stripe/webhook-status", async (c) => {
  try {
    const last = await kv.get("stripehook_last").catch(() => null);
    if (!last) {
      return c.json({
        everDelivered: false,
        secretConfigured: !!STRIPE_WEBHOOK_SECRET,
        problem: "Stripe has never reached this endpoint. Check the endpoint URL in Stripe.",
      });
    }
    const ageHours = last.at ? (Date.now() - new Date(last.at).getTime()) / 3600e3 : null;
    // Each of these is a different fix, so each gets its own sentence rather
    // than one "webhook broken" that sends you looking in the wrong place.
    const problem = !last.secretConfigured
      ? "STRIPE_WEBHOOK_SECRET is not set, so no delivery can ever verify."
      : !last.hadSignatureHeader
      ? "The last request arrived without a Stripe signature. Something other than Stripe is posting here."
      : !last.signatureValid
      ? "The last delivery failed its signature check. STRIPE_WEBHOOK_SECRET does not match the endpoint Stripe is posting from -- usually a live secret against a test endpoint, or an endpoint that was recreated."
      : null;
    return c.json({
      everDelivered: true,
      at: last.at ?? null,
      ageHours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
      signatureValid: !!last.signatureValid,
      hadSignatureHeader: !!last.hadSignatureHeader,
      secretConfigured: !!last.secretConfigured,
      eventType: last.type ?? null,
      problem,
    });
  } catch (e: any) { return c.json({ error: "Failed to read webhook status", details: e.message }, 500); }
});

// The portal nudge, on the broadcast stream with the drop's guards.
//
// Idempotency differs from the window notice on purpose. That one is a one-off
// announcement and must never reach the same creator twice, so it skips anyone
// who has ever had it. This is a recurring nudge -- re-engagement is the whole
// point -- so it is a cooldown instead: the same creator can have it again,
// just not twice in a day to a slipped double click.
async function sendPortalNudgeBatch(opts: { creatorIds?: string[]; dryRun?: boolean; limit?: number }) {
  const supabase = db();
  let q = supabase.from("creator_signups_f5961d0c").select("*");
  if (opts.creatorIds?.length) q = q.in("id", opts.creatorIds);
  const { data: rows, error } = await q;
  if (error) throw error;

  // One read for the batch, and only the recent ones matter, so the window is
  // in the query rather than filtered afterwards.
  const since = new Date(Date.now() - SEND_COOLDOWN_HOURS * 3600e3).toISOString();
  const { data: recent } = await supabase.from("creator_events_f5961d0c")
    .select("creator_id").eq("type", PORTAL_NUDGE_EVENT).gte("occurred_at", since);
  const sentRecently = new Set((recent ?? []).map((e: any) => String(e.creator_id)));

  const results: any[] = [];
  for (const r of (rows ?? []).slice(0, opts.limit ?? 500)) {
    const email = (r.email || "").trim();
    if (!email) { results.push({ id: r.id, skipped: "no email" }); continue; }
    if (r.email_bounced_at || r.email_complained_at) { results.push({ id: r.id, email, skipped: "suppressed" }); continue; }
    if (r.notify_email === false) { results.push({ id: r.id, email, skipped: "email notifications off" }); continue; }
    if (sentRecently.has(String(r.id))) { results.push({ id: r.id, email, skipped: "sent within 24h" }); continue; }

    const portalToken = await ensureCreatorPortalToken(r);
    const link = `${SITE_ORIGIN}/app?creator=${encodeURIComponent(portalToken)}`;
    const unsubLink = await unsubLinkFor(r.id);
    const rendered = renderPortalNudgeEmail(r, link, unsubLink);

    if (opts.dryRun) {
      results.push({ id: r.id, email, link, subject: rendered.subject, dryRun: true });
      continue;
    }
    try {
      const sent = await postmarkSend({
        to: email, ...rendered, stream: POSTMARK_STREAM,
        headers: {
          "List-Unsubscribe": `<${unsubLink}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      });
      if (!sent.ok) { results.push({ id: r.id, email, error: sent.error }); continue; }
      await logCreatorEvent(r.id, PORTAL_NUDGE_EVENT, { messageId: sent.payload?.MessageID ?? null });
      results.push({ id: r.id, email, sent: true, messageId: sent.payload?.MessageID ?? null });
    } catch (e: any) {
      results.push({ id: r.id, email, error: e?.message ?? String(e) });
    }
  }

  const sentCount = results.filter(r => r.sent).length;
  return {
    dryRun: !!opts.dryRun,
    problem: !opts.dryRun && sentCount === 0
      ? (!POSTMARK_SERVER_TOKEN
          ? "POSTMARK_SERVER_TOKEN is not set on the server, so nothing can be sent."
          : rows?.length ? "Every selected creator was skipped." : "No creators were selected.")
      : null,
    considered: rows?.length ?? 0,
    sent: sentCount,
    skipped: results.filter(r => r.skipped).length,
    failed: results.filter(r => r.error).length,
    results,
  };
}

app.post("/make-server-f5961d0c/admin/portal-nudge/test", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const to = String(body.to ?? "").trim().toLowerCase();
    if (!to || !to.includes("@")) return c.json({ error: "Enter an address to send the test to." }, 400);
    if (!POSTMARK_SERVER_TOKEN) return c.json({ error: "POSTMARK_SERVER_TOKEN is not set, so nothing can be sent." }, 400);
    const exampleUnsub = `${VERIFY_ORIGIN}/portal/unsubscribe?c=example&s=example`;
    const rendered = renderPortalNudgeEmail(await testRecipientRow(to), `${SITE_ORIGIN}/app`, exampleUnsub);
    const sent = await postmarkSend({
      to, ...rendered, stream: POSTMARK_STREAM,
      headers: {
        "List-Unsubscribe": `<${exampleUnsub}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });
    if (!sent.ok) return c.json({ error: sent.error || "Postmark rejected the message." }, 502);
    return c.json({ success: true, to, subject: rendered.subject });
  } catch (e: any) { return c.json({ error: "Test send failed", details: e.message }, 500); }
});

app.post("/make-server-f5961d0c/admin/portal-nudge/send", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const out = await sendPortalNudgeBatch({
      creatorIds: Array.isArray(body.creatorIds) ? body.creatorIds : undefined,
      dryRun: !!body.dryRun,
      limit: Number(body.limit) || undefined,
    });
    return c.json({ success: true, ...out });
  } catch (e: any) { return c.json({ error: "Send failed", details: e.message }, 500); }
});

// ─── Email health ─────────────────────────────────────────────────────────────
// Every send in this file fails quietly by design: the verification batch skips
// a creator when the token is missing, and the login routes answer "a code is on
// its way" whether or not one went. That is right for the callers but it means a
// misconfigured Postmark looks exactly like a working one from the outside. This
// route is the answer to "is email actually wired up", and it asks Postmark
// rather than trusting our own env vars.
const POSTMARK_API = "https://api.postmarkapp.com";

app.get("/make-server-f5961d0c/admin/email-health", async (c) => {
  const config = {
    serverToken: !!POSTMARK_SERVER_TOKEN,
    webhookSecret: !!POSTMARK_WEBHOOK_SECRET,
    loginCodeSalt: !!Deno.env.get("LOGIN_CODE_SALT"),
    from: POSTMARK_FROM_HEADER,
    broadcastStream: POSTMARK_STREAM,
    transactionalStream: POSTMARK_TRANSACTIONAL_STREAM,
    siteOrigin: SITE_ORIGIN,
    verifyLinkOrigin: VERIFY_ORIGIN,
    webhookUrl: `${Deno.env.get("SUPABASE_URL") || ""}/functions/v1/make-server-f5961d0c/webhooks/postmark`,
  };

  if (!POSTMARK_SERVER_TOKEN) {
    return c.json({ ok: false, config, problem: "POSTMARK_SERVER_TOKEN is not set, so nothing can be sent." });
  }

  const headers = { "Accept": "application/json", "X-Postmark-Server-Token": POSTMARK_SERVER_TOKEN };
  try {
    const [srvRes, msRes] = await Promise.all([
      fetch(`${POSTMARK_API}/server`, { headers }),
      fetch(`${POSTMARK_API}/message-streams`, { headers }),
    ]);
    const srv = await srvRes.json().catch(() => ({}));
    if (!srvRes.ok) {
      return c.json({ ok: false, config, problem: srv?.Message || `Postmark rejected the token (${srvRes.status}).` });
    }
    const ms = await msRes.json().catch(() => ({}));
    const ids: string[] = (ms?.MessageStreams ?? []).map((s: any) => String(s.ID));

    // A stream name that does not exist on the server is the failure mode that
    // looks most like success: the token is valid, the call is well formed, and
    // every send 422s. Naming the two we use makes that obvious here instead of
    // in a batch of 200 failures.
    const missing = [POSTMARK_STREAM, POSTMARK_TRANSACTIONAL_STREAM].filter(s => ids.length && !ids.includes(s));

    return c.json({
      ok: missing.length === 0,
      config,
      server: { name: srv?.Name ?? null, id: srv?.ID ?? null },
      streams: ids,
      problem: missing.length ? `These message streams do not exist on the Postmark server: ${missing.join(", ")}` : null,
    });
  } catch (e: any) {
    return c.json({ ok: false, config, problem: `Could not reach Postmark: ${e?.message ?? e}` });
  }
});

// Sends one real message to an address of the admin's choosing. The point is the
// error: "sender signature not confirmed" and "no such message stream" only ever
// show up on an actual send, so the raw Postmark message is passed straight
// through rather than flattened into a generic failure.
app.post("/make-server-f5961d0c/admin/email-test", async (c) => {
  try {
    const { to, stream } = await c.req.json();
    const addr = String(to ?? "").trim();
    if (!addr.includes("@")) return c.json({ error: "A valid address is required" }, 400);
    if (!POSTMARK_SERVER_TOKEN) return c.json({ error: "POSTMARK_SERVER_TOKEN is not set" }, 400);

    const which = stream === "broadcast" ? POSTMARK_STREAM : POSTMARK_TRANSACTIONAL_STREAM;
    // Rendered through the same shell as the real mail, so the test also answers
    // "does our branding survive this client" and not just "did it send".
    const sent = await postmarkSend({
      to: addr,
      subject: "Contynt email test",
      text: `This is a test from the Contynt admin panel.\n\nFrom: ${POSTMARK_FROM_HEADER}\nStream: ${which}\n\nIf you are reading this, sending works.`,
      html: emailShell({
        preheader: `Test send on the ${which} stream.`,
        body:
`      <p style="margin:0 0 16px 0;font-size:21px;line-height:1.35;font-weight:700;color:#0a0a0a;">Sending works</p>
      <p style="margin:0 0 22px 0;">This is a test from the Contynt admin panel. If you are reading it, the token, the sender signature and the message stream are all good.</p>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr><td bgcolor="#f7f7f8" style="background-color:#f7f7f8;border-radius:14px;padding:18px 20px;font-family:${EMAIL_FONT};font-size:13px;line-height:1.8;color:#525252;">
          From: ${esc(POSTMARK_FROM_HEADER)}<br>Stream: ${esc(which)}
        </td></tr>
      </table>`,
      }),
      stream: which,
    });
    if (!sent.ok) return c.json({ error: sent.error, postmark: sent.payload }, 502);
    return c.json({ success: true, stream: which, from: POSTMARK_FROM_HEADER, messageId: sent.payload?.MessageID ?? null });
  } catch (e: any) { return c.json({ error: e?.message ?? String(e) }, 500); }
});

// ─── Ambassador payout hook ───────────────────────────────────────────────────
const CARD_REWARD_DEFAULT = REFERRAL_REWARD;

// Deliberately NOT automatic. A scan attributes a card, but only an admin
// confirming a real business signup releases money, and only once per business
// for all time. business_signup_id on the attributed card is the ledger marker:
// it is set in the same call that writes the credit, so a double click cannot
// pay twice.
app.post("/make-server-f5961d0c/admin/cards/credit-attribution", async (c) => {
  try {
    const { businessId, amount } = await c.req.json();
    if (!businessId) return c.json({ error: "businessId required" }, 400);

    const { data: card } = await db().from("ambassador_cards_f5961d0c")
      .select("*").eq("business_id", businessId).eq("is_attributed", true).maybeSingle();
    if (!card) return c.json({ error: "No attributed card for this business" }, 404);
    if (card.business_signup_id) {
      return c.json({ error: "This business has already paid out once. One payout per business, ever." }, 409);
    }

    const ref = await kv.get(`ctokenref_${card.creator_id}`).catch(() => null);
    if (!ref?.token) return c.json({ error: "Creator has no portal token to credit" }, 404);

    const value = Number(amount) > 0 ? Number(amount) : CARD_REWARD_DEFAULT;
    await must("card payout: credit", db().from("creator_earnings_f5961d0c").insert({
      creator_token: ref.token, amount: value, source: "ambassador_card",
      note: `Ambassador card ${card.code}`,
    }));
    await must("card payout: mark", db().from("ambassador_cards_f5961d0c")
      .update({ business_signup_id: businessId }).eq("id", card.id));
    await logCreatorEvent(card.creator_id, "ambassador_card_credited", { code: card.code, amount: value, businessId });

    return c.json({ success: true, amount: value, code: card.code });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// Attribution can be wrong: two creators visit the same spot, the wrong card
// gets scanned first. Admin can move it, but not after it has paid.
app.post("/make-server-f5961d0c/admin/cards/reassign-attribution", async (c) => {
  try {
    const { businessId, cardId } = await c.req.json();
    if (!businessId || !cardId) return c.json({ error: "businessId and cardId required" }, 400);

    const { data: current } = await db().from("ambassador_cards_f5961d0c")
      .select("*").eq("business_id", businessId).eq("is_attributed", true).maybeSingle();
    if (current?.business_signup_id) {
      return c.json({ error: "This business already paid out. Reassigning would not move the money." }, 409);
    }
    // Cleared first: the unique partial index allows only one attributed card
    // per business, so the new one cannot be set while the old one holds it.
    if (current) {
      await must("reassign: clear", db().from("ambassador_cards_f5961d0c")
        .update({ is_attributed: false, attribution_locked_until: null }).eq("id", current.id));
    }
    await must("reassign: set", db().from("ambassador_cards_f5961d0c").update({
      is_attributed: true,
      attribution_locked_until: new Date(Date.now() + CARD_LIFETIME_DAYS * 864e5).toISOString(),
    }).eq("id", cardId).eq("business_id", businessId));

    return c.json({ success: true });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// ─── Email code login ─────────────────────────────────────────────────────────
// Replaces the unique-link model. Someone enters their email, gets a 6 digit
// code, and the verified session is what the portal runs on from then on. No
// password, and no long lived secret sitting in an email thread forever.
//
// Creators and businesses differ only in the row an address resolves to and the
// token they end up holding, so the machinery is written once here and the two
// pairs of routes below supply just those two things.
const LOGIN_CODE_TTL_MIN = 10;
const LOGIN_CODE_MAX_ATTEMPTS = 5;
const LOGIN_MAX_REQUESTS_PER_HOUR = 5;

type LoginAudience = "creator" | "business";

function sixDigitCode(): string {
  // 2^32 is not a multiple of 1e6, so a bare modulo would bias the low codes.
  // 4294000000 is the largest multiple of 1e6 below 2^32.
  const buf = new Uint32Array(1);
  let n = 0;
  do { crypto.getRandomValues(buf); n = buf[0]; } while (n >= 4294000000);
  return String(n % 1000000).padStart(6, "0");
}

// Codes are stored hashed. A KV dump should not hand someone a live login code.
// The audience is part of the hash input as well as the key, so a code minted
// for a creator cannot be replayed against the business route when the same
// person owns both addresses.
async function hashLoginCode(audience: LoginAudience, email: string, code: string): Promise<string> {
  const salt = Deno.env.get("LOGIN_CODE_SALT") || ADMIN_SECRET || "contynt";
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${audience}:${email}:${code}`));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

const loginCodeKey = (audience: LoginAudience, addr: string) => `logincode_${audience}_${addr}`;

function loginCodeEmail(code: string) {
  return {
    subject: `Your Contynt code: ${code}`,
    text: `Your Contynt login code is ${code}\n\nIt expires in ${LOGIN_CODE_TTL_MIN} minutes. If you did not ask for this, you can ignore it. The code is useless without your inbox.\n\nCONTYNT\nSan Francisco`,
    html: emailShell({
      preheader: `${code} is your login code. It expires in ${LOGIN_CODE_TTL_MIN} minutes.`,
      body:
`      <p style="margin:0 0 16px 0;font-size:21px;line-height:1.35;font-weight:700;color:#0a0a0a;">Your login code</p>
      <p style="margin:0 0 22px 0;">Enter this to finish signing in.</p>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr><td align="center" bgcolor="#f7f7f8" style="background-color:#f7f7f8;border-radius:14px;padding:22px 16px;">
          <!-- No spaces between the digits: the code has to survive being
               copied and pasted, which a prettier "09 73 19" would not. -->
          <div style="font-family:${EMAIL_FONT};font-size:36px;font-weight:700;letter-spacing:0.2em;color:#0a0a0a;line-height:1.1;">${esc(code)}</div>
        </td></tr>
      </table>
      <p style="margin:22px 0 0 0;font-size:13px;color:#8a8a8a;">It expires in ${LOGIN_CODE_TTL_MIN} minutes and can only be used once.</p>
      <p style="margin:8px 0 0 0;font-size:13px;color:#8a8a8a;">If you did not ask for this, you can ignore it. The code is useless without your inbox.</p>`,
    }),
  };
}

// Issues, stores and sends a code. Returns nothing the caller can branch on:
// every outcome has to be indistinguishable from outside, or the route becomes
// an oracle for which addresses are on file.
async function issueLoginCode(opts: {
  audience: LoginAudience;
  addr: string;            // normalised, and what the code is hashed against
  to: string;              // the address as stored, which is what we mail
  subjectId: string;
  log: (type: string, payload: any) => Promise<void>;
}): Promise<void> {
  const key = loginCodeKey(opts.audience, opts.addr);
  const prev = await kv.get(key).catch(() => null);

  // Rate limit per address, so this cannot be used to mail-bomb anyone.
  const windowStart = prev?.windowStart && (Date.now() - new Date(prev.windowStart).getTime() < 3600e3)
    ? prev.windowStart : new Date().toISOString();
  const sentInWindow = windowStart === prev?.windowStart ? (prev?.sentInWindow ?? 0) : 0;
  if (sentInWindow >= LOGIN_MAX_REQUESTS_PER_HOUR) {
    await opts.log("login_code_throttled", {});
    return;
  }

  const code = sixDigitCode();
  await kv.set(key, {
    subjectId: opts.subjectId,
    codeHash: await hashLoginCode(opts.audience, opts.addr, code),
    expiresAt: new Date(Date.now() + LOGIN_CODE_TTL_MIN * 60e3).toISOString(),
    attempts: 0,
    windowStart, sentInWindow: sentInWindow + 1,
  });

  const mail = loginCodeEmail(code);
  const sent = await postmarkSend({ to: opts.to, ...mail, stream: POSTMARK_TRANSACTIONAL_STREAM });
  // Logged without the code itself. The event trail should not be a way to read
  // someone's live login code.
  await opts.log("login_code_sent", { delivered: sent.ok, error: sent.error || null });
  if (!sent.ok) console.error(`[login:${opts.audience}] send failed:`, sent.error);
}

// Checks a supplied code and consumes it. The code is burned on success and on
// running out of tries, so a 6 digit space cannot be walked.
async function consumeLoginCode(audience: LoginAudience, addr: string, supplied: string):
  Promise<{ subjectId: string } | { error: string; status: number }> {
  const key = loginCodeKey(audience, addr);
  const rec = await kv.get(key).catch(() => null);
  if (!rec) return { error: "That code has expired. Ask for a new one.", status: 400 };

  if (new Date(rec.expiresAt) <= new Date()) {
    await kv.del(key).catch(() => {});
    return { error: "That code has expired. Ask for a new one.", status: 400 };
  }
  if ((rec.attempts ?? 0) >= LOGIN_CODE_MAX_ATTEMPTS) {
    await kv.del(key).catch(() => {});
    return { error: "Too many attempts. Ask for a new code.", status: 429 };
  }

  const ok = timingSafeEqual(await hashLoginCode(audience, addr, supplied), String(rec.codeHash ?? ""));
  if (!ok) {
    await kv.set(key, { ...rec, attempts: (rec.attempts ?? 0) + 1 });
    return { error: "That code is not right.", status: 400 };
  }

  // Single use.
  await kv.del(key).catch(() => {});
  return { subjectId: String(rec.subjectId ?? "") };
}

// ─── Creator login ────────────────────────────────────────────────────────────
app.post("/make-server-f5961d0c/creator-login/request", async (c) => {
  // One response shape whatever happens. Anything that varied with whether the
  // address is on file would turn this into a creator-list oracle.
  const done = () => c.json({ success: true, message: "If that email is on file, a code is on its way." });
  try {
    const { email } = await c.req.json();
    const addr = String(email ?? "").trim().toLowerCase();
    if (!addr || !addr.includes("@")) return done();

    const { data: creator } = await db().from("creator_signups_f5961d0c")
      .select("id, email, email_bounced_at, email_complained_at").ilike("email", addr).maybeSingle();

    // An owner who followed "Log In" from the marketing site lands on the
    // creator screen, because that is where the button now points. Rather than
    // telling them they are in the wrong place -- or worse, telling them
    // nothing -- a business address gets a business code, and verify below
    // hands back a business token. The reply is byte-identical either way, so
    // this stays useless as an oracle: nothing here reveals which of the two an
    // address is, or whether it is on file at all.
    if (!creator) {
      const { data: biz } = await db().from("business_signups_f5961d0c")
        .select("id, email, email_bounced_at, email_complained_at").ilike("email", addr).maybeSingle();
      if (!biz) return done();
      if (biz.email_bounced_at || biz.email_complained_at) return done();
      await issueLoginCode({
        audience: "business", addr, to: biz.email, subjectId: biz.id,
        log: (type, payload) => logBusinessEvent(biz.id, type, payload),
      });
      return done();
    }
    if (creator.email_bounced_at || creator.email_complained_at) return done();

    await issueLoginCode({
      audience: "creator", addr, to: creator.email, subjectId: creator.id,
      log: (type, payload) => logCreatorEvent(creator.id, type, payload),
    });
    return done();
  } catch (e: any) {
    console.error("[login request]", e?.message ?? e);
    return done();
  }
});

app.post("/make-server-f5961d0c/creator-login/verify", async (c) => {
  try {
    const { email, code } = await c.req.json();
    const addr = String(email ?? "").trim().toLowerCase();
    const supplied = String(code ?? "").replace(/\D/g, "");
    if (!addr || !supplied) return c.json({ error: "Enter the code we emailed you." }, 400);

    const checked = await consumeLoginCode("creator", addr, supplied);
    if ("error" in checked) {
      // No creator code matched. The address may have been issued a business
      // one by the request route above, in which case this is an owner who
      // arrived at the wrong door -- sign them in and say where to go. Only a
      // correct code gets that answer, so it tells an attacker nothing they
      // could not already learn by guessing a six digit code.
      const asBiz = await consumeLoginCode("business", addr, supplied);
      if (!("error" in asBiz)) {
        const { data: biz } = await db().from("business_signups_f5961d0c")
          .select("id, business_name, city").eq("id", asBiz.subjectId).maybeSingle();
        if (biz) {
          const bizToken = await ensureBusinessPortalToken(biz);
          await logBusinessEvent(biz.id, "login_succeeded", { via: "creator_screen" });
          return c.json({
            success: true, portal: "business", token: bizToken,
            businessName: biz.business_name || "",
          });
        }
      }
      return c.json({ error: checked.error }, checked.status as any);
    }

    const { data: creator } = await db().from("creator_signups_f5961d0c")
      .select("*").eq("id", checked.subjectId).maybeSingle();
    if (!creator) return c.json({ error: "Account not found." }, 404);

    // Reuses the creator's existing token when there is one. Claims and earnings
    // are keyed by creator_token, so minting a fresh token on every login would
    // orphan a creator's own history.
    const token = await ensureCreatorPortalToken(creator);
    await logCreatorEvent(creator.id, "login_succeeded", {});

    return c.json({
      success: true, portal: "creator", token,
      needsConfirm: creator.verification_status !== "confirmed",
    });
  } catch (e: any) { return c.json({ error: "Could not sign you in", details: e.message }, 500); }
});

// ─── Business login ───────────────────────────────────────────────────────────
// Same flow, same guarantees. The owner of a business no longer needs to keep
// the ?biz= link we mailed them once: their email address is the credential and
// the code proves they still read it.
app.post("/make-server-f5961d0c/business-login/request", async (c) => {
  const done = () => c.json({ success: true, message: "If that email is on file, a code is on its way." });
  try {
    const { email } = await c.req.json();
    const addr = String(email ?? "").trim().toLowerCase();
    if (!addr || !addr.includes("@")) return done();

    // limit(1) rather than maybeSingle(): nothing stops two signups sharing an
    // address, and maybeSingle() would throw on that instead of signing the
    // owner in. Oldest first, so a duplicate row created later never takes over
    // the account the owner has been using.
    const { data: rows } = await db().from("business_signups_f5961d0c")
      .select("id, email, business_name, city, email_bounced_at, email_complained_at")
      .ilike("email", addr).order("created_at", { ascending: true }).limit(1);
    const biz = rows?.[0];
    if (!biz) return done();
    if (biz.email_bounced_at || biz.email_complained_at) return done();

    await issueLoginCode({
      audience: "business", addr, to: biz.email, subjectId: biz.id,
      log: (type, payload) => logBusinessEvent(biz.id, type, payload),
    });
    return done();
  } catch (e: any) {
    console.error("[biz login request]", e?.message ?? e);
    return done();
  }
});

app.post("/make-server-f5961d0c/business-login/verify", async (c) => {
  try {
    const { email, code } = await c.req.json();
    const addr = String(email ?? "").trim().toLowerCase();
    const supplied = String(code ?? "").replace(/\D/g, "");
    if (!addr || !supplied) return c.json({ error: "Enter the code we emailed you." }, 400);

    const checked = await consumeLoginCode("business", addr, supplied);
    if ("error" in checked) return c.json({ error: checked.error }, checked.status as any);

    const { data: biz } = await db().from("business_signups_f5961d0c")
      .select("id, business_name, city").eq("id", checked.subjectId).maybeSingle();
    if (!biz) return c.json({ error: "Account not found." }, 404);

    // Reuses the live portal token for the same reason the creator side does:
    // features, claims and submissions hang off the business id behind it, and
    // a link already in the owner's inbox should keep working after they sign in
    // here.
    const token = await ensureBusinessPortalToken(biz);
    await logBusinessEvent(biz.id, "login_succeeded", {});

    return c.json({ success: true, token, businessName: biz.business_name || "" });
  } catch (e: any) { return c.json({ error: "Could not sign you in", details: e.message }, 500); }
});

// ─── Admin: impersonate a creator ─────────────────────────────────────────────
// Deliberately NOT the same thing as /creator-links. That route rotates the
// creator's own token, which would sign them out of their session the moment an
// admin looked at their portal. This mints a separate, short lived token and
// leaves the creator's session completely alone.
const IMPERSONATE_MINUTES = 60;

app.post("/make-server-f5961d0c/admin/impersonate-creator", async (c) => {
  try {
    const { creatorId } = await c.req.json();
    if (!creatorId) return c.json({ error: "creatorId required" }, 400);

    const { data: creator } = await db().from("creator_signups_f5961d0c")
      .select("id, instagram, email, city").eq("id", creatorId).maybeSingle();
    if (!creator) return c.json({ error: "Creator not found" }, 404);

    // Every claim, submission and earning row is keyed by the creator's token
    // STRING, not their id. So a standalone impersonation token would render a
    // completely empty portal. The impersonation token therefore carries the
    // creator's real token and reads follow that alias.
    const realToken = await ensureCreatorPortalToken(creator);

    const token = secureToken(24);
    const expiresAt = new Date(Date.now() + IMPERSONATE_MINUTES * 60e3).toISOString();
    await kv.set(`ctoken_${token}`, {
      creatorId: creator.id, instagram: creator.instagram, email: creator.email, city: creator.city,
      createdAt: new Date().toISOString(),
      // Read by creatorFromToken to expire it, and by the portal to show a banner.
      impersonated: true, expiresAt, realToken,
    });
    // Not written to ctokenref_ on purpose: that key is how the creator's real
    // session is found, and an impersonation token must never become it.
    await logCreatorEvent(creator.id, "admin_impersonated", { expiresAt });

    return c.json({ success: true, token, expiresAt, minutes: IMPERSONATE_MINUTES });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// ─── Admin: impersonate a business ────────────────────────────────────────────
app.post("/make-server-f5961d0c/admin/impersonate-business", async (c) => {
  try {
    const { businessId } = await c.req.json();
    if (!businessId) return c.json({ error: "businessId required" }, 400);

    const { data: biz, error } = await db().from("business_signups_f5961d0c")
      .select("id, business_name, city").eq("id", businessId).maybeSingle();
    if (error || !biz) return c.json({ error: "Business not found" }, 404);

    // Create a short-lived impersonation token similar to creator impersonation
    const token = secureToken(24);
    const expiresAt = new Date(Date.now() + IMPERSONATE_MINUTES * 60e3).toISOString();
    await kv.set(`biztoken_${token}`, {
      businessId: biz.id, businessName: biz.business_name, city: biz.city,
      createdAt: new Date().toISOString(),
      impersonated: true, expiresAt,
    });
    // Not written to biztokenref_ on purpose: that's the business's real session

    return c.json({ success: true, token, expiresAt, minutes: IMPERSONATE_MINUTES });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// ─── Sign out ─────────────────────────────────────────────────────────────────
// Clearing localStorage was the whole of "Sign out" until now, which meant the
// token stayed valid for ever: creator and business tokens carry no expiry, so
// anyone holding a copy -- a shared browser, a screenshot, the ?creator= link
// still sitting in the address bar -- kept full access after the owner thought
// they had left. These revoke the session server-side.
//
// The token STRING survives on purpose. Every claim, submission and earning is
// keyed by it, so signing back in with an emailed code restores the same string
// and nothing is orphaned. The consequence, stated plainly: this revokes the
// live session, it does not rotate the credential. A leaked token is dead until
// the owner signs in again and live again after. Real rotation needs those
// tables re-keyed to creator_id / business_id first.
async function revokeSession(kind: "ctoken" | "biztoken", token: string) {
  if (!token) return false;
  const existing = await kv.get(`${kind}_${token}`).catch(() => null);
  if (!existing) return false;
  await kv.del(`${kind}_${token}`).catch(() => {});
  return true;
}

app.post("/make-server-f5961d0c/creator-portal/logout", async (c) => {
  try {
    const { token } = await c.req.json().catch(() => ({} as any));
    const session = await creatorFromToken(String(token ?? ""));
    // Answered the same either way: whether a token was live is not something
    // this route should confirm to whoever is holding it.
    if (session?.creatorId) {
      await revokeSession("ctoken", String(token));
      await logCreatorEvent(session.creatorId, "signed_out", {});
    }
    return c.json({ success: true });
  } catch { return c.json({ success: true }); }
});

app.post("/make-server-f5961d0c/business-portal/logout", async (c) => {
  try {
    const { token } = await c.req.json().catch(() => ({} as any));
    const session = await businessFromToken(String(token ?? ""));
    if (session?.businessId) {
      await revokeSession("biztoken", String(token));
      await logBusinessEvent(session.businessId, "signed_out", {});
    }
    return c.json({ success: true });
  } catch { return c.json({ success: true }); }
});

// ─── Health ───────────────────────────────────────────────────────────────────
app.get("/make-server-f5961d0c/health", (c) => c.json({ status: "ok" }));

// ─── Creator signup ───────────────────────────────────────────────────────────
app.post("/make-server-f5961d0c/signup", async (c) => {
  try {
    const { instagram, email, city: rawCity } = await c.req.json();
    const city = String(rawCity ?? "").trim().slice(0, 80);
    if (!city) return c.json({ error: "City is required" }, 400);

    // Validated rather than stored as typed. This route accepted an empty email
    // and an empty handle, which produced rows nothing downstream could ever
    // reach: no verification link, no login code, no way to identify the person.
    const addr = normalizeEmail(email);
    if (!addr) return c.json({ error: "Enter a valid email address." }, 400);
    const handle = normalizeHandle(instagram);
    if (!handle) return c.json({ error: "Enter a valid Instagram handle." }, 400);

    // One row per address. Two creator rows on one email break every lookup
    // that resolves an address back to a creator with maybeSingle() -- the
    // resend form and the login code among them -- so a repeat signup updates
    // what is on file instead of minting a twin.
    const { data: existing } = await db().from("creator_signups_f5961d0c")
      .select("id, instagram, city").ilike("email", addr)
      .order("created_at", { ascending: true }).limit(1);
    const found = existing?.[0];
    if (found) {
      // Gaps filled, answers never overwritten -- the same rule the business
      // and referral forms follow.
      const patch: Record<string, unknown> = {};
      if (!String(found.instagram ?? "").trim()) patch.instagram = handle;
      if (!String(found.city ?? "").trim()) patch.city = city;
      if (Object.keys(patch).length) {
        await db().from("creator_signups_f5961d0c").update(patch).eq("id", found.id);
      }
      return c.json({ success: true, message: "Successfully signed up for early access!", id: found.id, matched: true });
    }

    const { data, error } = await db().from("creator_signups_f5961d0c")
      .insert({ instagram: handle, email: addr, city }).select("id").single();
    if (error) throw error;
    return c.json({ success: true, message: "Successfully signed up for early access!", id: data.id, matched: false });
  } catch (e: any) { return c.json({ error: "Failed to process signup.", details: e.message }, 500); }
});

// ─── Business signup ──────────────────────────────────────────────────────────
// The form no longer asks for a business name: the Instagram handle is the one
// identifier a business always has and the one already shown beside every row in
// the Businesses tab. A handle that is already there attaches to that business
// rather than minting a twin, so signing up twice updates the details on file
// instead of splitting a business across two rows -- which would split its
// Features, its quota and its portal with it.
// The browser key for Places, for forms that are not behind a referral code or
// a scan. Public by nature: it ships inside whichever page uses it either way,
// and what protects it is the HTTP referrer restriction on the key itself, not
// the obscurity of the endpoint handing it over. Two other routes already
// return this same value to anonymous callers.
app.get("/make-server-f5961d0c/public-config", (c) =>
  c.json({ placesKey: Deno.env.get("GOOGLE_PLACES_KEY") || "" }));

app.post("/make-server-f5961d0c/business-signup", async (c) => {
  try {
    const { businessName, instagram, email, city, address, preferredContact,
            placeId: placeIdRaw, placeAddress: placeAddressRaw } = await c.req.json();
    const handle = normalizeHandle(instagram);
    if (!handle) return c.json({ error: "Enter a valid Instagram handle." }, 400);
    if (!email || !city) return c.json({ error: "Email and city are required." }, 400);

    // The form no longer asks for an address in its own field -- picking the
    // business from Places supplies it. Kept as a fallback rather than replaced
    // outright, because a business whose name has no Places match still types
    // a name and still has to be able to sign up.
    const placeId = String(placeIdRaw ?? "").trim().slice(0, 200) || null;
    const placeAddress = String(placeAddressRaw ?? "").trim().slice(0, 300) || null;
    const finalAddress = String(address ?? "").trim() || placeAddress || "";

    // Compared normalised in memory rather than with ilike: rows predating this
    // hold "@name" and full profile URLs as well as bare handles, and none of
    // those match a bare handle in SQL. The table is small enough that reading
    // it is cheaper than the migration that would make an index correct.
    const { data: existingRows } = await db().from("business_signups_f5961d0c")
      .select("id, instagram, business_name, address");
    // Lowercased for the comparison only. Instagram handles are case
    // insensitive, so "JoesDiner" and "joesdiner" are one account and must not
    // become two rows -- but the casing a business typed is still what gets
    // stored and shown back to them.
    const key = (v: any) => (normalizeHandle(String(v ?? "")) ?? "").toLowerCase();
    const wanted = handle.toLowerCase();
    const match = (existingRows ?? []).find((r: any) => key(r.instagram) === wanted);

    if (match) {
      // Only what the form actually carried, so a re-signup cannot blank a
      // detail an admin filled in. business_name is left alone when the row
      // already has one: a real name beats a handle.
      const patch: Record<string, unknown> = { instagram: handle, email, city };
      if (finalAddress) patch.address = finalAddress;
      // Written even on a re-signup: an existing row created before this form
      // had Places has no place_id, and this is the moment one arrives.
      if (placeId) patch.place_id = placeId;
      if (placeAddress) patch.place_address = placeAddress;
      if (preferredContact) patch.preferred_contact = preferredContact;
      if (!String(match.business_name ?? "").trim()) patch.business_name = `@${handle}`;
      await must("business signup: attach to existing", db()
        .from("business_signups_f5961d0c").update(patch).eq("id", match.id));
      await logBusinessEvent(match.id, "signup_reattached", { handle });
      return c.json({ success: true, message: "Thank you! We'll be in touch.", id: match.id, matched: true });
    }

    const { data, error } = await db().from("business_signups_f5961d0c").insert({
      // The handle stands in for the name everywhere downstream -- the admin
      // card heading, the Features creators see, the portal -- so it is written
      // to both columns rather than leaving business_name empty and letting
      // every one of those read blank.
      business_name: businessName?.trim() || `@${handle}`,
      instagram: handle,
      email, city, address: finalAddress, preferred_contact: preferredContact || "",
      place_id: placeId, place_address: placeAddress,
    }).select("id").single();
    if (error) throw error;
    return c.json({ success: true, message: "Thank you! We'll be in touch.", id: data.id, matched: false });
  } catch (e: any) { return c.json({ error: "Failed to process signup.", details: e.message }, 500); }
});

// ─── Page view ────────────────────────────────────────────────────────────────
// An unauthenticated insert on a public route, so it is bounded in both
// directions: every field is capped, and one address cannot write more than
// this many rows in the window. Without either, anyone could grow the visitors
// table without limit and take the analytics figures with it.
const PAGEVIEW_MAX_PER_WINDOW = 60;
const PAGEVIEW_WINDOW_MIN = 10;

app.post("/make-server-f5961d0c/analytics/pageview", async (c) => {
  try {
    const { visitorId, userAgent, referrer } = await c.req.json();
    const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "";
    if (ip) {
      const key = `pvrl_${await hashIp(ip)}`;
      const rec = await kv.get(key).catch(() => null);
      const now = Date.now();
      const fresh = !rec?.windowStart || now - new Date(rec.windowStart).getTime() > PAGEVIEW_WINDOW_MIN * 60e3;
      const count = fresh ? 0 : (rec?.count ?? 0);
      // Silently accepted and dropped. Analytics must never surface an error to
      // a visitor, and a 429 here would say more than it is worth.
      if (count >= PAGEVIEW_MAX_PER_WINDOW) return c.json({ success: true });
      await kv.set(key, {
        windowStart: fresh ? new Date(now).toISOString() : rec.windowStart,
        count: count + 1,
      }).catch(() => {});
    }
    const country = c.req.header("cf-ipcountry") || c.req.header("x-vercel-ip-country") || "";
    const city = c.req.header("cf-ipcity") || "";
    const { error } = await db().from("visitors_f5961d0c").insert({
      visitor_id: String(visitorId ?? "").trim().slice(0, 120),
      user_agent: String(userAgent ?? "").slice(0, 400),
      referrer: String(referrer ?? "").slice(0, 500),
      country: country.slice(0, 8) || null,
      city: city.slice(0, 80) || null,
    });
    if (error) throw error;
    return c.json({ success: true });
  } catch (e: any) { return c.json({ error: "Failed to track page view", details: e.message }, 500); }
});

// ─── Analytics stats ──────────────────────────────────────────────────────────
app.get("/make-server-f5961d0c/analytics/stats", async (c) => {
  try {
    const supabase = db();
    const [pvRes, visRes, csRes, bsRes, recentRes] = await Promise.all([
      supabase.from("visitors_f5961d0c").select("*", { count: "exact", head: true }),
      supabase.from("visitors_f5961d0c").select("visitor_id"),
      supabase.from("creator_signups_f5961d0c").select("*", { count: "exact", head: true }),
      supabase.from("business_signups_f5961d0c").select("*", { count: "exact", head: true }),
      supabase.from("visitors_f5961d0c").select("visitor_id, user_agent, referrer, created_at").order("created_at", { ascending: false }).limit(50),
    ]);
    const uniqueVisitors = new Set(visRes.data?.map((r: any) => r.visitor_id)).size;
    return c.json({
      totalPageViews: pvRes.count ?? 0,
      uniqueVisitors,
      totalSignups: csRes.count ?? 0,
      totalBusinessSignups: bsRes.count ?? 0,
      recentPageviews: (recentRes.data ?? []).map((r: any) => ({ visitorId: r.visitor_id, userAgent: r.user_agent, referrer: r.referrer, timestamp: r.created_at, country: r.country || null, city: r.city || null })),
    });
  } catch (e: any) { return c.json({ error: "Failed to fetch analytics", details: e.message }, 500); }
});

// ─── Get creator signups ──────────────────────────────────────────────────────
app.get("/make-server-f5961d0c/signups", async (c) => {
  try {
    // ambassador_opted_in rather than a join on ambassadors_f5961d0c: the two
    // are written together by setAmbassadorOptIn and can only disagree if that
    // writer is bypassed, so the column already on this row is the same answer
    // for none of the cost. The code comes with it because an admin holding a
    // printed card wants to match it to a creator without opening a second tab.
    const { data, error } = await db().from("creator_signups_f5961d0c").select("id, instagram, email, city, created_at, ambassador_opted_in, ambassador_code").order("created_at", { ascending: false });
    if (error) throw error;
    // Balances live against the portal token, so map creator id -> token first.
    const [balances, refs] = await Promise.all([allCreatorBalances(), kv.getByPrefix("ctokenref_")]);
    const tokenFor: Record<string, string> = {};
    for (const ref of refs) if (ref?.creatorId && ref?.token) tokenFor[ref.creatorId] = ref.token;
    const zero = { totalEarned: 0, pendingEarnings: 0, availableEarnings: 0 };
    return c.json({
      signups: (data ?? []).map((r: any) => ({
        id: r.id, instagram: r.instagram, email: r.email, city: r.city, createdAt: r.created_at,
        isAmbassador: !!r.ambassador_opted_in, ambassadorCode: r.ambassador_code || null,
        ...(balances[tokenFor[r.id]] ?? zero),
      })),
      total: data?.length ?? 0,
    });
  } catch (e: any) { return c.json({ error: "Failed to fetch signups", details: e.message }, 500); }
});

// ─── Get business signups ─────────────────────────────────────────────────────
app.get("/make-server-f5961d0c/business-signups", async (c) => {
  try {
    const { data, error } = await db().from("business_signups_f5961d0c")
      .select("id, business_name, instagram, email, city, address, preferred_contact, created_at, subscription_tier, subscription_ends_at, feature_status, plan_clicks, referral_source, referral_code, referred_by_creator")
      .order("created_at", { ascending: false });
    if (error) throw error;
    const rows = data ?? [];

    // Who brought this business in. The row stores the creator's id; an id is
    // not something anyone recognises, so it is resolved to the handle here
    // rather than leaving the dashboard to look it up per card. One query for
    // the whole page, and only for the ids actually referenced.
    const creatorIds = [...new Set(rows.map((r: any) => r.referred_by_creator).filter(Boolean))];
    const handleById: Record<string, string> = {};
    if (creatorIds.length) {
      const { data: creators } = await db().from("creator_signups_f5961d0c")
        .select("id, instagram, instagram_handle").in("id", creatorIds);
      for (const cr of (creators ?? [])) {
        handleById[cr.id] = cr.instagram_handle || (cr.instagram || "").replace(/^@+/, "") || "";
      }
    }

    // Some rows carry a referral code but no creator id -- older attributions,
    // and anything written before the two were saved together. The code names
    // the ambassador on its own, so it is resolved rather than leaving the card
    // to say "an Ambassador" about someone we can identify.
    const codesNeedingCreator = [...new Set(rows
      .filter((r: any) => !r.referred_by_creator && r.referral_code)
      .map((r: any) => r.referral_code))];
    const handleByCode: Record<string, string> = {};
    if (codesNeedingCreator.length) {
      const { data: ambs } = await db().from("ambassadors_f5961d0c")
        .select("referral_code, creator_instagram").in("referral_code", codesNeedingCreator);
      for (const a of (ambs ?? [])) {
        handleByCode[a.referral_code] = (a.creator_instagram || "").replace(/^@+/, "");
      }
    }

    return c.json({
      signups: rows.map((r: any) => ({
        id: r.id, businessName: r.business_name, instagram: r.instagram, email: r.email,
        city: r.city, address: r.address, preferredContact: r.preferred_contact,
        createdAt: r.created_at, subscriptionTier: r.subscription_tier || null,
        subscriptionEndsAt: r.subscription_ends_at || null,
        featureStatus: r.feature_status || null, planClicks: r.plan_clicks || 0,
        referralSource: r.referral_source || null,
        referralCode: r.referral_code || null,
        // Empty when the creator row is gone but the attribution is not, so the
        // card can still say it came from an Ambassador without naming one.
        referredByHandle: r.referred_by_creator
          ? (handleById[r.referred_by_creator] ?? "")
          : (r.referral_code ? (handleByCode[r.referral_code] ?? "") : null),
      })),
      total: rows.length,
    });
  } catch (e: any) { return c.json({ error: "Failed to fetch business signups", details: e.message }, 500); }
});

// ─── Creator access links ─────────────────────────────────────────────────────
app.post("/make-server-f5961d0c/creator-links/:creatorId", async (c) => {
  try {
    const creatorId = c.req.param("creatorId");
    const { data: creator, error } = await db().from("creator_signups_f5961d0c").select("id, instagram, email, city").eq("id", creatorId).single();
    if (error || !creator) return c.json({ error: "Creator not found" }, 404);
    // Deliberately no longer a rotation. This used to mint a fresh token32 and
    // delete the old one -- and because claims, submissions, earnings and
    // payout requests are all keyed by the token STRING, that silently orphaned
    // every row the creator had. Their balance read zero and their history was
    // gone, from a button labelled "generate link".
    //
    // It now hands back the creator's durable token, creating one only if they
    // have never had one.
    const token = await ensureCreatorPortalToken(creator);
    return c.json({ success: true, token });
  } catch (e: any) { return c.json({ error: "Failed to generate link", details: e.message }, 500); }
});

app.get("/make-server-f5961d0c/creator-links", async (c) => {
  try {
    const refs = await kv.getByPrefix("ctokenref_");
    const links: Record<string, string> = {};
    for (const ref of refs) { if (ref?.creatorId && ref?.token) links[ref.creatorId] = ref.token; }
    return c.json({ links });
  } catch (e: any) { return c.json({ error: "Failed to fetch creator links", details: e.message }, 500); }
});

// ─── Business portal links ────────────────────────────────────────────────────
app.post("/make-server-f5961d0c/business-links/:businessId", async (c) => {
  try {
    const businessId = c.req.param("businessId");
    const { data: biz, error } = await db().from("business_signups_f5961d0c").select("id, business_name, city").eq("id", businessId).single();
    if (error || !biz) return c.json({ error: "Business not found" }, 404);
    // Same reasoning as the creator route above: rotating here killed the link
    // already in the owner's inbox for no gain. Durable token, created once.
    const token = await ensureBusinessPortalToken(biz);
    return c.json({ success: true, token });
  } catch (e: any) { return c.json({ error: "Failed to generate business link", details: e.message }, 500); }
});

app.get("/make-server-f5961d0c/business-links", async (c) => {
  try {
    const refs = await kv.getByPrefix("biztokenref_");
    const links: Record<string, string> = {};
    for (const ref of refs) { if (ref?.businessId && ref?.token) links[ref.businessId] = ref.token; }
    return c.json({ links });
  } catch (e: any) { return c.json({ error: "Failed to fetch business links", details: e.message }, 500); }
});

// ─── Admin: private link ──────────────────────────────────────────────────────
app.post("/make-server-f5961d0c/admin/generate-link", async (c) => {
  try {
    const token = secureToken(24);
    await kv.set("admin_private_token", { token, createdAt: new Date().toISOString() });
    return c.json({ success: true, token });
  } catch (e: any) { return c.json({ error: "Failed to generate admin link", details: e.message }, 500); }
});

app.get("/make-server-f5961d0c/admin/verify", async (c) => {
  try {
    const token = c.req.query("token");
    if (!token) return c.json({ valid: false }, 400);
    // Unauthenticated by necessity -- it is half the handshake -- which makes it
    // the one place the private admin link can be guessed at. Throttled, and
    // compared in constant time.
    if (await adminAttemptLimited(c, "verify")) {
      return c.json({ valid: false, error: "Too many attempts. Try again in a few minutes." }, 429);
    }
    const stored = await kv.get("admin_private_token");
    const valid = !!stored?.token && timingSafeEqual(String(stored.token), String(token));
    if (valid) await clearAdminAttempts(c, "verify");
    return c.json({ valid });
  } catch (e: any) { return c.json({ valid: false }, 500); }
});

// ─── Admin: set subscription tier ────────────────────────────────────────────
app.post("/make-server-f5961d0c/admin/set-tier", async (c) => {
  try {
    const { businessId, tier } = await c.req.json();
    if (!businessId) return c.json({ error: "businessId required" }, 400);
    // null clears the tier. Anything else has to be a plan that exists, or the
    // quota reads it as an unknown name and silently falls back to one Reel --
    // a typo here used to be indistinguishable from a Starter subscription.
    const next = tier === null || tier === "" ? null : String(tier);
    if (next !== null && !KNOWN_TIERS.includes(next)) {
      return c.json({ error: `Unknown tier. Expected one of: ${KNOWN_TIERS.join(", ")}` }, 400);
    }
    await must("set-tier", db().from("business_signups_f5961d0c")
      .update({ subscription_tier: next }).eq("id", businessId));
    return c.json({ success: true, tier: next });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// ─── Admin: offer a feature to a business (Enable Feature / Free Feature) ────
app.post("/make-server-f5961d0c/admin/offer-feature", async (c) => {
  try {
    const { businessId, isTrial, isOneOff } = await c.req.json();
    if (!businessId) return c.json({ error: "businessId required" }, 400);
    const { data: biz, error } = await db().from("business_signups_f5961d0c").select("id, business_name, address, city, instagram, subscription_tier").eq("id", businessId).single();
    if (error || !biz) return c.json({ error: "Business not found" }, 404);
    const featureId = uid("feat_");
    await db().from("features_f5961d0c").insert({
      id: featureId, business_id: businessId, business_name: biz.business_name,
      address: biz.address || "", city: biz.city || "",
      // The handle the creator is told to tag as a collaborator. Three of the
      // four routes that create a Feature used to leave it empty, and the
      // portal filled the gap by squashing the business name into something
      // handle-shaped -- so a Feature for Qua O La told creators to tag
      // @quaola, which is not their account.
      business_instagram: biz.instagram || "",
      status: "offered", is_trial: !!isTrial, is_one_off: !!isOneOff,
      offered_at: new Date().toISOString(),
      category: "", payout_range: "",
    });
    return c.json({ success: true, featureId });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// ─── Business Reel quota ──────────────────────────────────────────────────────
// Mirrors src/app/lib/featureQuota.ts, which is what the portal renders from.
// The two have to agree exactly: the client decides how many blank request
// slots to draw and this decides whether a request that arrives may be filled,
// so a rule in one and not the other either shows a business a slot it cannot
// use or -- as was the case until now -- refuses nothing at all. Quota lived
// only in the browser, which made the subscription decorative: a Starter
// business could POST unlimited Feature requests and take for free what the
// plan was supposed to meter.
//
// The allowance is per month, scoped the same way on both sides -- see the note
// in lib/featureQuota.ts for why the boundary is the UTC calendar month.
//
// Derived from STRIPE_PLANS so a plan cannot be sellable and unmetered. "Scale"
// has no Stripe price and is not sellable; it is kept only so a business
// carrying that tier from before keeps the allowance it was given rather than
// silently dropping to one Reel.
const TIER_REELS: Record<string, number> = {
  ...Object.fromEntries(STRIPE_PLANS.filter(p => p.tier).map(p => [p.tier as string, p.reels])),
  Scale: 8,
};

// Spent: the business accepted the offer, or requested the Reel outright.
const QUOTA_SPENT = ["pending", "available", "completed"];
// Exists at all, as opposed to withdrawn.
const QUOTA_LIVE = ["offered", ...QUOTA_SPENT];
// A Feature already in flight. Re-requesting one of these would be a second
// Reel off one slot, since the status it would move to is one it already counts
// as spent.
const QUOTA_REQUESTABLE = ["offered", "pending"];

// Which month a Feature was granted in. offered_at is stamped by every path
// that creates one; approved_at is the fallback for rows written before that
// was true. No usable date counts as current, so a missing timestamp cannot
// hand out a free Reel.
function inQuotaMonth(f: any, now: Date): boolean {
  const raw = f?.offered_at || f?.approved_at;
  if (!raw) return true;
  const d = new Date(raw);
  if (isNaN(d.getTime())) return true;
  return d.getUTCFullYear() === now.getUTCFullYear() && d.getUTCMonth() === now.getUTCMonth();
}

// Blank "request a Reel" slots left, matching openRequestSlots() on the client.
// Open offers are subtracted because each already holds one of the remaining
// Reels without having spent it.
function openRequestSlotsFor(tier: string | null, allFeatures: any[], now = new Date()): number {
  const status = (f: any) => String(f?.status ?? "");
  const features = allFeatures.filter((f: any) => inQuotaMonth(f, now));
  // Free (is_trial) and one-off (is_one_off) Features are granted on top of the
  // tier allowance rather than drawn from it.
  const grants = features.filter((f: any) =>
    (!!f.is_trial || !!f.is_one_off) && QUOTA_LIVE.includes(status(f))).length;
  const limit = (tier ? (TIER_REELS[tier] ?? 1) : 0) + grants;
  const used = features.filter((f: any) => QUOTA_SPENT.includes(status(f))).length;
  const offers = features.filter((f: any) => status(f) === "offered").length;
  return Math.max(0, Math.max(0, limit - used) - offers);
}

// ─── Business portal: submit feature request (notes + decrement reels) ────────
app.post("/make-server-f5961d0c/business-portal/submit-feature", async (c) => {
  try {
    const { bizToken, featureId, requestNotes, isNewRequest } = await c.req.json();
    const bizData = await businessFromToken(bizToken);
    if (!bizData) return c.json({ error: "Invalid token" }, 401);
    // Stored blank when it is blank. Substituting a sentence here made an empty
    // box indistinguishable from a business that had actually asked for the
    // creator's choice, in the admin dashboard and to the creator.
    const notes = String(requestNotes ?? "").trim();

    // Read once and used by both branches: the tier and the business's own
    // Features are what the quota is computed from, and the insert needs the
    // profile columns anyway.
    const [{ data: bizRow }, { data: ownFeatures }] = await Promise.all([
      db().from("business_signups_f5961d0c")
        .select("business_name, address, city, subscription_tier").eq("id", bizData.businessId).maybeSingle(),
      db().from("features_f5961d0c")
        .select("id, status, is_trial, is_one_off, offered_at, approved_at").eq("business_id", bizData.businessId),
    ]);
    const features = ownFeatures ?? [];
    const tier = (bizRow as any)?.subscription_tier ?? null;

    let resultFeatureId = featureId || "";
    if (isNewRequest || !featureId) {
      // 402 rather than 403: nothing is wrong with the request or the caller,
      // they have simply spent everything the plan grants.
      if (openRequestSlotsFor(tier, features) <= 0) {
        return c.json({
          error: tier
            ? "You have used every Reel on your plan. Upgrade, or buy a one-time Feature to request another."
            : "Choose a plan to request a Reel.",
        }, 402);
      }
      const newId = uid("feat_");
      resultFeatureId = newId;
      await must("submit-feature: create request", db().from("features_f5961d0c").insert({
        id: newId, business_id: bizData.businessId, business_name: (bizRow as any)?.business_name || "",
        address: (bizRow as any)?.address || "", city: (bizRow as any)?.city || "",
        business_instagram: (bizRow as any)?.instagram || "",
        status: "pending", request_notes: notes, submitted_by_business: true,
        submitted_at_biz: new Date().toISOString(), offered_at: new Date().toISOString(),
        category: "", payout_range: "",
      }));
    } else {
      // Accepting an offer, or editing the notes on a request an admin has not
      // picked up yet. Anything further along is refused: flipping a completed
      // Feature back to pending was a second Reel for a slot already spent,
      // which is the same free-work hole the quota check above closes.
      const target = features.find((f: any) => String(f.id) === String(featureId));
      if (!target) return c.json({ error: "Feature not found" }, 404);
      if (!QUOTA_REQUESTABLE.includes(String(target.status ?? ""))) {
        return c.json({ error: "That Reel is already underway and cannot be requested again." }, 409);
      }
      // business_id stays on the update as well as the lookup: two locks on a
      // write that names a row by an id the client supplied.
      await must("submit-feature: accept offer", db().from("features_f5961d0c").update({
        status: "pending", request_notes: notes,
        submitted_by_business: true, submitted_at_biz: new Date().toISOString(),
      }).eq("id", featureId).eq("business_id", bizData.businessId));
    }
    return c.json({ success: true, featureId: resultFeatureId });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// ─── Admin: approve business → creates Feature ───────────────────────────────
app.post("/make-server-f5961d0c/admin/approve-business", async (c) => {
  try {
    const { businessId, payoutRange, category } = await c.req.json();
    if (!businessId || !payoutRange) return c.json({ error: "businessId and payoutRange required" }, 400);
    const { data: biz, error } = await db().from("business_signups_f5961d0c").select("id, business_name, address, city, instagram").eq("id", businessId).single();
    if (error || !biz) return c.json({ error: "Business not found" }, 404);
    const featureId = uid("feat_");
    const { error: featErr } = await db().from("features_f5961d0c").insert({
      id: featureId,
      business_id: businessId,
      business_name: biz.business_name,
      address: biz.address || "",
      city: biz.city || "",
      category: category || "Business",
      payout_range: payoutRange,
      business_instagram: biz.instagram || "",
      status: "available",
      // The quota dates a Feature by offered_at. This path was the one creation
      // route that never set it, so a Feature approved here belonged to no
      // month and was counted against every one of them.
      offered_at: new Date().toISOString(),
    });
    if (featErr) throw featErr;
    return c.json({ success: true, featureId });
  } catch (e: any) { return c.json({ error: "Failed to approve business", details: e.message }, 500); }
});

// ─── Admin: edit a feature's category / payout / notes ───────────────────────
app.post("/make-server-f5961d0c/admin/update-feature", async (c) => {
  try {
    const { featureId, category, payoutRange, adminNotes } = await c.req.json();
    if (!featureId) return c.json({ error: "featureId required" }, 400);
    const patch: Record<string, any> = {};
    if (category !== undefined) patch.category = category;
    if (payoutRange !== undefined) patch.payout_range = payoutRange;
    // Trimmed on the way in, so a note of only whitespace is stored as
    // empty and the creator portal has nothing to render.
    if (adminNotes !== undefined) patch.admin_notes = String(adminNotes).trim();
    if (!Object.keys(patch).length) return c.json({ success: true });
    const { error } = await db().from("features_f5961d0c").update(patch).eq("id", featureId);
    if (error) throw error;
    return c.json({ success: true });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// ─── Admin: publish an existing feature (make it claimable) ──────────────────
app.post("/make-server-f5961d0c/admin/publish-feature", async (c) => {
  try {
    const { featureId, category, payoutRange, adminNotes, earlyAccess, earlyAccessHours } = await c.req.json();
    if (!featureId) return c.json({ error: "featureId required" }, 400);
    const patch: Record<string, any> = { status: "available", approved_at: new Date().toISOString() };
    if (category) patch.category = category;
    if (payoutRange) patch.payout_range = payoutRange;
    if (adminNotes) patch.admin_notes = String(adminNotes).trim();
    // Opt in per Feature. Confirmed creators see it now, everyone else after the
    // window. Omitting earlyAccess leaves the Feature visible to all, so this
    // stays off unless an admin asks for it.
    if (earlyAccess) {
      const hours = Number(earlyAccessHours) > 0 ? Number(earlyAccessHours) : EARLY_ACCESS_HOURS;
      patch.early_access_until = new Date(Date.now() + hours * 3600e3).toISOString();
    }
    const { error } = await db().from("features_f5961d0c").update(patch).eq("id", featureId);
    if (error) throw error;
    return c.json({ success: true });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// ─── Admin: remove a feature ─────────────────────────────────────────────────
app.post("/make-server-f5961d0c/admin/remove-feature", async (c) => {
  try {
    const { featureId } = await c.req.json();
    if (!featureId) return c.json({ error: "featureId required" }, 400);
    const { error } = await db().from("features_f5961d0c").delete().eq("id", featureId);
    if (error) throw error;
    return c.json({ success: true });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// ─── Admin: get all features ──────────────────────────────────────────────────
app.get("/make-server-f5961d0c/admin/features", async (c) => {
  try {
    const { data, error } = await db().from("features_f5961d0c").select("*").order("offered_at", { ascending: false });
    if (error) throw error;
    const features = (data ?? []).map((r: any) => ({
      id: r.id, businessId: r.business_id || "", businessName: r.business_name || "",
      address: r.address || "", city: r.city || "",
      category: r.category || "", payoutRange: r.payout_range || "",
      status: r.status || "", approvedAt: r.approved_at, offeredAt: r.offered_at || null,
      isTrial: r.is_trial || false, isOneOff: r.is_one_off || false,
      requestNotes: r.request_notes || "",
      submittedByBusiness: r.submitted_by_business || false,
      admin_notes: r.admin_notes || "", total_payout: r.total_payout || "",
      claimed_by: r.claimed_by || "", winner_instagram: r.winner_instagram || "",
      claimed_at: r.claimed_at || "",
    }));
    return c.json({ features });
  } catch (e: any) { return c.json({ error: "Failed to fetch features", details: e.message }, 500); }
});

// ─── Admin: get all claims (SQL only) ────────────────────────────────────────
app.get("/make-server-f5961d0c/admin/claims", async (c) => {
  try {
    const { data, error } = await db().from("creator_claims_f5961d0c").select("*").order("claimed_at", { ascending: false });
    if (error) throw error;
    const claims = (data ?? []).map((r: any) => ({
      featureId: r.feature_id, creatorToken: r.creator_token, creatorInstagram: r.creator_instagram || "",
      status: r.status, claimedAt: r.claimed_at || "", reelUrl: r.reel_url || "",
      approvedAt: r.approved_at || null, expiresAt: r.expires_at || null, acceptanceExpiresAt: r.acceptance_expires_at || null, lastViewed: r.last_viewed || null,
      // Kept even when the status has moved on: an unclaimed_at older than the
      // row's own interested_at is a creator who withdrew and then asked again,
      // which the status alone cannot say.
      unclaimedAt: r.unclaimed_at || null,
      // Stamped when the "you have been selected, accept within 24 hours" mail
      // goes out. Approving is what starts that clock, so whether the creator
      // was actually told is part of the claim's state, not a detail of the
      // request that approved it -- an admin coming back an hour later has to
      // be able to see that a creator is on a deadline nobody sent them.
      selectedNotifiedAt: r.selected_notified_at || null,
    }));
    return c.json({ claims });
  } catch (e: any) { return c.json({ error: "Failed to fetch claims", details: e.message }, 500); }
});

// ─── Admin: one creator's portal activity ────────────────────────────────────
// creator_events has been collecting since August and nothing ever read it:
// seventeen call sites write to it, no route returns it. So the record of a
// creator signing in, confirming their profile or opting in as an Ambassador
// existed and was unreachable, and the dashboard could only report the state
// those events left behind, never when any of it happened.
//
// Per creator and on demand rather than bundled into /signups. The dashboard
// loads every creator at once and almost none of them are being looked at; this
// is the detail behind one row, so it is fetched when that row is opened.
app.get("/make-server-f5961d0c/admin/creator-events", async (c) => {
  try {
    const creatorId = String(c.req.query("creatorId") || "");
    if (!creatorId) return c.json({ error: "creatorId required" }, 400);
    const limit = Math.min(Math.max(Number(c.req.query("limit") || 60), 1), 200);

    // Same column mistake as the email history had: the timestamp is
    // occurred_at. Renamed on the way out so the merge with feature views
    // below, and the dashboard reading it, keep one field name.
    const { data: rows, error } = await db().from("creator_events_f5961d0c")
      .select("type, payload, occurred_at").eq("creator_id", creatorId)
      .order("occurred_at", { ascending: false }).limit(limit);
    if (error) throw error;
    const events = (rows ?? []).map((e: any) => ({
      type: e.type, payload: e.payload, created_at: e.occurred_at,
    }));

    // Opening a Feature is the one thing a creator does in the portal that is
    // not in the event log -- view-feature stamps last_viewed on the claim
    // instead. It belongs in the same list, so it is folded in here rather
    // than left as a separate thing the reader has to merge by eye.
    //
    // One timestamp per Feature, not a history: the column is overwritten on
    // every view, so this says when they last opened it and cannot say how
    // often. Claims hang off the portal token, hence the ctokenref_ hop.
    const ref = await kv.get(`ctokenref_${creatorId}`).catch(() => null);
    let views: any[] = [];
    if (ref?.token) {
      const { data: claims } = await db().from("creator_claims_f5961d0c")
        .select("feature_id, last_viewed").eq("creator_token", ref.token).not("last_viewed", "is", null);
      const ids = [...new Set((claims ?? []).map((r: any) => r.feature_id))];
      const nameById: Record<string, string> = {};
      if (ids.length) {
        const { data: feats } = await db().from("features_f5961d0c").select("id, business_name").in("id", ids);
        for (const f of (feats ?? [])) nameById[f.id] = f.business_name || "";
      }
      views = (claims ?? []).map((r: any) => ({
        type: "feature_viewed", created_at: r.last_viewed,
        payload: { business: nameById[r.feature_id] || "" },
      }));
    }

    const all = [...(events ?? []), ...views]
      .filter(e => e.created_at)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, limit);
    return c.json({ events: all });
  } catch (e: any) { return c.json({ error: "Failed to fetch creator events", details: e.message }, 500); }
});

// ─── Admin: get all submissions ───────────────────────────────────────────────
app.get("/make-server-f5961d0c/admin/submissions", async (c) => {
  try {
    // SQL is the only writer now — the KV copy came from /store-submission,
    // which was removed, so the old KV/SQL merge no longer has a second source.
    const { data, error } = await db().from("submissions_f5961d0c").select("*").order("submitted_at", { ascending: false });
    if (error) throw error;
    // Same de-duplication the admin panel used to do client-side: one row per
    // (reel, feature), keeping the most recent submission.
    const newest = new Map<string, any>();
    for (const r of (data ?? [])) {
      const key = `${r.reel_url}|${r.feature_id}`;
      const prev = newest.get(key);
      if (!prev || new Date(r.submitted_at) > new Date(prev.submitted_at)) newest.set(key, r);
    }
    // The handoff answer lives on the ambassador card, keyed by (creator,
    // feature), so it is joined in here rather than left for the admin panel to
    // fetch separately.
    const rows = [...newest.values()];
    const handoffBy = new Map<string, { status: string; at: string | null }>();
    const featureIds = [...new Set(rows.map(r => r.feature_id).filter(Boolean))];
    if (featureIds.length) {
      const { data: cards } = await db().from("ambassador_cards_f5961d0c")
        .select("creator_id, feature_id, handoff_status, handed_off_at").in("feature_id", featureIds);
      for (const c2 of (cards ?? [])) {
        handoffBy.set(`${c2.creator_id}|${c2.feature_id}`, {
          status: c2.handoff_status, at: c2.handed_off_at ?? null,
        });
      }
    }

    const submissions = rows.map((r: any) => ({
      id: r.id, featureId: r.feature_id, token: r.token,
      creatorInstagram: r.creator_instagram || "", reelUrl: r.reel_url || "",
      status: r.status, metrics: r.metrics || {},
      businessFeedback: r.business_feedback || null, reportNote: r.report_note || "",
      submittedAt: r.submitted_at, approvedAt: r.approved_at || null,
      business_approved: r.business_approved ?? false,
      admin_payout_approved: r.admin_payout_approved ?? false,
      payout_amount: r.payout_amount || "", stripe_link: r.stripe_link || "",
      cashed_out_at: r.cashed_out_at || null, denied: r.denied ?? false,
      admin_report_note: r.admin_report_note || "",
      payment_method: r.payment_method || "", payment_info: r.payment_info || "",
      // null when the creator is not an ambassador on this Feature, so the
      // panel can tell "did not apply" from "has not answered yet".
      handoffStatus: handoffBy.get(`${r.creator_id}|${r.feature_id}`)?.status ?? null,
      handedOffAt: handoffBy.get(`${r.creator_id}|${r.feature_id}`)?.at ?? null,
    }));
    return c.json({ submissions });
  } catch (e: any) { return c.json({ error: "Failed to fetch submissions", details: e.message }, 500); }
});

// ─── Admin: approve reel ──────────────────────────────────────────────────────
app.post("/make-server-f5961d0c/admin/approve-reel", async (c) => {
  try {
    const { submissionId } = await c.req.json();
    const { data: sub, error: subErr } = await db().from("submissions_f5961d0c").select("*").eq("id", submissionId).single();
    if (subErr || !sub) return c.json({ error: "Submission not found" }, 404);
    await markReelLive(sub);
    return c.json({ success: true });
  } catch (e: any) { return c.json({ error: "Failed to approve reel", details: e.message }, 500); }
});

// ─── Admin: report issue ──────────────────────────────────────────────────────
app.post("/make-server-f5961d0c/admin/report-reel", async (c) => {
  try {
    const { submissionId, note } = await c.req.json();
    const { error } = await db().from("submissions_f5961d0c").update({ status: "reported", report_note: note || "", reported_at: new Date().toISOString() }).eq("id", submissionId);
    if (error) throw error;
    return c.json({ success: true });
  } catch (e: any) { return c.json({ error: "Failed to report reel", details: e.message }, 500); }
});

// ─── Admin: fetch reel metrics (oEmbed + placeholder) ────────────────────────
app.post("/make-server-f5961d0c/admin/fetch-metrics", async (c) => {
  try {
    const { submissionId, reelUrl: rawMetricsUrl } = await c.req.json();
    const reelUrl = normalizeReelUrl(rawMetricsUrl);
    if (!reelUrl) return c.json({ error: "That does not look like an Instagram Reel link." }, 400);
    let oembedData: any = {};
    let fetchError: string | null = null;
    try {
      const res = await fetch(`https://api.instagram.com/oembed/?url=${encodeURIComponent(reelUrl)}&maxwidth=400&omitscript=true`);
      if (res.ok) {
        oembedData = await res.json();
      } else {
        fetchError = `oEmbed returned ${res.status} — post may be private or URL is invalid.`;
      }
    } catch (e: any) {
      fetchError = e.message;
    }
    const metrics = {
      thumbnail: oembedData.thumbnail_url || null,
      thumbnailWidth: oembedData.thumbnail_width || null,
      thumbnailHeight: oembedData.thumbnail_height || null,
      author: oembedData.author_name || null,
      authorUrl: oembedData.author_url || null,
      embedHtml: oembedData.html || null,
      providerName: oembedData.provider_name || "Instagram",
      fetchError,
    };
    if (submissionId) {
      await db().from("submissions_f5961d0c").update({ metrics }).eq("id", submissionId);
    }
    return c.json({ success: true, metrics });
  } catch (e: any) { return c.json({ error: "Failed to fetch metrics", details: e.message }, 500); }
});

// ─── Reel preview (server-side oEmbed fetch to avoid CORS) ───────────────────
app.get("/make-server-f5961d0c/reel-preview", async (c) => {
  try {
    const url = normalizeReelUrl(c.req.query("url"));
    // Same rule as the submit route, so this cannot be pointed at an arbitrary
    // string and used as a general purpose fetcher.
    if (!url) return c.json({ error: "url required" }, 400);
    const res = await fetch(`https://api.instagram.com/oembed/?url=${encodeURIComponent(url)}&maxwidth=400&omitscript=true`);
    if (!res.ok) return c.json({ thumbnail: null, author: null });
    const data: any = await res.json();
    return c.json({ thumbnail: data.thumbnail_url || null, author: data.author_name || null, authorUrl: data.author_url || null });
  } catch { return c.json({ thumbnail: null, author: null }); }
});

// ─── Check approval status for a creator token (used by creator portal polling)
app.get("/make-server-f5961d0c/creator-portal/approval-status", async (c) => {
  try {
    const token = c.req.query("t");
    if (!token) return c.json({ approvals: [] });
    const kvClaims = await kv.getByPrefix(`creator_claim_${token}_`);
    const approvals = kvClaims
      .filter((cl: any) => cl?.status === "claimed" && cl?.approvedAt)
      .map((cl: any) => ({ featureId: cl.featureId, status: cl.status, approvedAt: cl.approvedAt, expiresAt: cl.expiresAt }));
    return c.json({ approvals });
  } catch { return c.json({ approvals: [] }); }
});

// ─── Admin: reset creator portal state ───────────────────────────────────────
app.post("/make-server-f5961d0c/admin/reset-creator", async (c) => {
  try {
    const { creatorId } = await c.req.json();
    if (!creatorId) return c.json({ error: "creatorId required" }, 400);
    const tokenRef = await kv.get(`ctokenref_${creatorId}`);
    if (!tokenRef?.token) return c.json({ error: "No token found for this creator" }, 404);
    const token = tokenRef.token;
    // Delete all KV claims for this token
    const allFeatures = await kv.getByPrefix("feature_");
    for (const f of allFeatures) {
      if (f?.id) await kv.del(`creator_claim_${token}_${f.id}`).catch(() => {});
    }
    // Delete all KV submissions for this token
    const allSubs = await kv.getByPrefix("submission_");
    for (const s of allSubs) {
      if (s?.token === token && s?.id) await kv.del(`submission_${s.id}`).catch(() => {});
    }
    // Clear SQL claims and submissions
    await db().from("creator_claims_f5961d0c").delete().eq("creator_token", token);
    await db().from("submissions_f5961d0c").delete().eq("token", token);
    // And the ledger they justified. creatorBalance() derives from these two
    // tables, so deleting the submissions and leaving the credits behind left
    // the creator holding a balance with nothing standing behind it -- money
    // owed for work the reset had just erased. Reward credits from the
    // ambassador programme are left alone: those are earned against referrals,
    // which this reset does not touch.
    await db().from("creator_earnings_f5961d0c")
      .delete().eq("creator_token", token).eq("source", "submission");
    await db().from("creator_payout_requests_f5961d0c")
      .delete().eq("creator_token", token).eq("status", "requested");
    // Store reset timestamp so the creator portal can clear localStorage
    await kv.set(`reset_${token}`, { resetAt: new Date().toISOString() });
    return c.json({ success: true });
  } catch (e: any) { return c.json({ error: "Failed to reset creator", details: e.message }, 500); }
});

// /features-status was an unauthenticated list of every Feature's status and
// winning handle, reachable with the anon key that ships inside the client
// bundle. Its comment said "other portals poll this"; nothing did -- the
// creator portal reads /creator-portal/sync and the business portal reads
// /business-portal, both scoped to the caller. Removed rather than guarded,
// because a guarded route with no callers is just a later liability.

// ─── Mark feature as completed (service role key — bypasses RLS) ─────────────
app.post("/make-server-f5961d0c/feature-complete", async (c) => {
  try {
    const { featureId, winnerInstagram, totalPayout, claimedBy } = await c.req.json();
    if (!featureId) return c.json({ error: "featureId required" }, 400);
    await db().from("features_f5961d0c").update({
      status: "completed",
      winner_instagram: winnerInstagram || "",
      completed_at: new Date().toISOString(),
      total_payout: totalPayout || "",
      claimed_by: claimedBy || winnerInstagram || "",
      claimed_at: new Date().toISOString(),
    }).eq("id", featureId);
    return c.json({ success: true });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// /store-submission was an unauthenticated write path that let any caller
// insert a submission under an arbitrary creator token. It had no callers left
// — /creator-portal/submit is the real path — so it is removed rather than
// guarded.

// ─── Creator portal ───────────────────────────────────────────────────────────
app.get("/make-server-f5961d0c/creator-portal", async (c) => {
  try {
    const rawToken = c.req.query("t");
    if (!rawToken) return c.json({ error: "Token required" }, 400);
    const creatorData = await creatorFromToken(rawToken);
    if (!creatorData) return c.json({ error: "Invalid or expired link" }, 401);
    // Liveness is recorded against the session actually in use. Spreading this
    // record onto the creator's own key would copy the impersonation expiry
    // across with it and expire the creator's real session inside the hour.
    await kv.set(`ctoken_${rawToken}`, { ...creatorData, lastActive: new Date().toISOString() });
    // Past this line, token means "the token that owns the data". For a normal
    // session that is the same string; for impersonation it is the alias target.
    const token = creatorData.realToken ?? rawToken;
    const resetRecord = await kv.get(`reset_${token}`);
    const resetAt = resetRecord?.resetAt || null;
    // Get all real features
    const [featRes, claimsRes, statsRes, placeRes] = await Promise.all([
      db().from("features_f5961d0c").select("*").order("approved_at", { ascending: false }),
      db().from("creator_claims_f5961d0c").select("*").eq("creator_token", token).neq("status", "unclaimed"),
      db().from("submissions_f5961d0c").select("id, feature_id, status").eq("token", token),
      // The Feature stores a formatted address and no coordinates. Turning that
      // string back into a point needs the Geocoding API, which is a separate
      // product and is not enabled on this key -- but the business it belongs
      // to already carries the place_id that Places picked when it signed up.
      // That is both exact and free of a second API to switch on.
      db().from("business_signups_f5961d0c").select("id, place_id").not("place_id", "is", null),
    ]);
    const placeById = new Map<string, string>(
      (placeRes.data ?? []).map((b: any) => [String(b.id), String(b.place_id)]));
    // Early-access gating. A creator who already claimed a Feature keeps seeing
    // it regardless, otherwise a gated Feature would vanish from under them.
    const confirmed = await creatorIsConfirmed(creatorData.creatorId);
    const claimedIds = new Set((claimsRes.data ?? []).map((cl: any) => cl.feature_id));
    // Market and early-access gates. Every Feature in the table used to be sent
    // to every creator, so somebody in Los Angeles was shown -- and could claim
    // -- a shoot in San Francisco. A Feature they already hold stays visible
    // regardless of either gate, or it would vanish from under them.
    const features = (featRes.data ?? [])
      .filter((r: any) => claimedIds.has(r.id)
        || (visibleToCreator(r, confirmed) && featureInCreatorCity(r, creatorData.city)))
      .map((r: any) => ({ id: r.id, businessId: r.business_id, businessName: r.business_name, address: r.address, city: r.city, placeId: placeById.get(String(r.business_id)) ?? null, category: r.category, payoutRange: r.payout_range, status: r.status, approvedAt: r.approved_at, winnerInstagram: r.winner_instagram || "", businessInstagram: r.business_instagram || "", adminNotes: r.admin_notes || "", earlyAccessUntil: r.early_access_until || null }));
    // SQL only — no KV merge needed
    const claimsMap: Record<string, any> = {};
    for (const cl of (claimsRes.data ?? [])) {
      if (cl.status === "unclaimed" || cl.status === "viewing") continue;
      claimsMap[cl.feature_id] = { featureId: cl.feature_id, status: cl.status, reelUrl: cl.reel_url, approvedAt: cl.approved_at || null, expiresAt: cl.expires_at || null, acceptanceExpiresAt: cl.acceptance_expires_at || null };
    }
    // Creator stats
    const completedCount = (statsRes.data ?? []).filter((s: any) => s.status === "approved").length;
    const activeClaimsCount = (claimsRes.data ?? []).filter((cl: any) => cl.status === "claimed" || cl.status === "submitted").length;
    // Balance comes from the earnings ledger. The old creator_payouts read that
    // stood here was never written to, so this stat was always zero.
    const balance = await creatorBalance(token);
    // Sent cash-outs, so the wallet can name the one a creator is reporting
    // rather than asking them to describe it. Capped: this is a recent history
    // for identifying a payment, not an accounting record.
    const { data: payoutRows } = await db().from("creator_payout_requests_f5961d0c")
      .select("id, amount, method, handle, status, requested_at, paid_at, not_received_at, issue_resolved_at")
      .eq("creator_token", token).order("requested_at", { ascending: false }).limit(12);
    const { data: ambRow } = await db().from("creator_signups_f5961d0c")
      .select("ambassador_opted_in, ambassador_code").eq("id", creatorData.creatorId).maybeSingle();
    const ambCode = ambRow?.ambassador_opted_in ? (ambRow.ambassador_code ?? null) : null;
    return c.json({
      creator: { instagram: creatorData.instagram, city: creatorData.city, email: creatorData.email || "" },
      features, claims: claimsMap,
      stats: {
        completed: completedCount,
        activeClaims: activeClaimsCount,
        totalPayout: balance.totalEarned,
        ...balance,
      },
      resetAt,
      payouts: (payoutRows ?? []).map((r: any) => ({
        id: r.id, amount: parseAmount(r.amount), method: r.method || "", handle: r.handle || "",
        status: r.status, requestedAt: r.requested_at, paidAt: r.paid_at || null,
        notReceivedAt: r.not_received_at || null,
        issueResolvedAt: r.issue_resolved_at || null,
      })),
      // The one ambassador code, so in-progress Features can offer Print and QR
      // without minting anything of their own. Null until they opt in.
      ambassadorCode: ambCode,
      cardUrl: ambCode ? cardUrlFor(ambCode) : null,
      // Comes from the session itself rather than a URL flag, so the read-only
      // banner cannot be dismissed by editing the address bar.
      impersonated: !!creatorData.impersonated,
      // Same key the referral and scan forms already get. Browser keys are
      // public by nature -- they ship in the page either way -- so the control
      // that matters is the HTTP referrer restriction on the key itself, not
      // whether this endpoint returns it.
      placesKey: Deno.env.get("GOOGLE_PLACES_KEY") || "",
      // When the Activity tab's seed entries start. Empty or unset means none
      // at all, which is the default: the tab then shows real completed
      // Features and nothing else.
      //
      // A date rather than a boolean, because it also sets the pace. The feed
      // is generated forward from this day, so switching it on does not drop
      // twenty backdated claims into an empty tab -- day one has two or three,
      // and it fills out over the following week. Set it as an env var, so
      // turning it on or moving it needs no deploy.
      activitySeedStart: Deno.env.get("ACTIVITY_SEED_START") || "",
    });
  } catch (e: any) { return c.json({ error: "Failed to load portal", details: e.message }, 500); }
});

// Interested — marks creator as interested, SQL only
app.post("/make-server-f5961d0c/creator-portal/claim", async (c) => {
  try {
    const { token: rawToken, featureId } = await c.req.json();
    if (!rawToken || !featureId) return c.json({ error: "Token and featureId required" }, 400);
    const creatorData = await creatorFromToken(rawToken);
    if (!creatorData) return c.json({ error: "Invalid or expired link" }, 401);
    // Impersonation writes must land on the creator's own rows, not on the
    // short lived admin token, which expires in an hour and is in no index.
    const token = creatorData.realToken ?? rawToken;

    // A featureId from the client is not evidence the Feature is open to this
    // creator. Unchecked, any id could be registered interest in: one already
    // completed, one still pending an admin, or one held back behind early
    // access -- which is the same gate /creator-portal applies when deciding
    // what to render, so the two would otherwise disagree about the same row.
    const { data: feature } = await db().from("features_f5961d0c")
      .select("id, status, city, early_access_until").eq("id", featureId).maybeSingle();
    if (!feature) return c.json({ error: "That feature is no longer available" }, 404);
    if (feature.status !== "available") return c.json({ error: "That feature is no longer available" }, 409);
    if (!visibleToCreator(feature, await creatorIsConfirmed(creatorData.creatorId))) {
      return c.json({ error: "That feature is not open yet. Confirm your profile to get early access." }, 403);
    }
    if (!featureInCreatorCity(feature, creatorData.city)) {
      return c.json({ error: "That feature is not in your city." }, 403);
    }

    const instagram = creatorData.instagram || "";
    const now = new Date().toISOString();
    await db().from("creator_claims_f5961d0c").upsert({ feature_id: featureId, creator_token: token, creator_instagram: instagram, status: "interested", claimed_at: now, interested_at: now }, { onConflict: "feature_id,creator_token" });
    return c.json({ success: true });
  } catch (e: any) { return c.json({ error: "Failed", details: e.message }, 500); }
});

// Admin approves a creator — sets to "approved" state, creator must accept within 24hrs
app.post("/make-server-f5961d0c/admin/approve-creator-claim", async (c) => {
  try {
    const { featureId, creatorToken } = await c.req.json();
    if (!featureId || !creatorToken) return c.json({ error: "featureId and creatorToken required" }, 400);
    const now = new Date();
    const approvedAt = now.toISOString();
    const acceptanceExpiresAt = new Date(now.getTime() + ACCEPTANCE_HOURS * 60 * 60 * 1000).toISOString();
    const { error } = await db().from("creator_claims_f5961d0c").update({ status: "approved", approved_at: approvedAt, acceptance_expires_at: acceptanceExpiresAt }).eq("feature_id", featureId).eq("creator_token", creatorToken);
    if (error) throw error;
    // Approval, not claiming, is what mints the card. A card handed out for a
    // shoot that never got approved would point at a Reel that never arrives.
    const card = await ensureCardForApprovedClaim(featureId, creatorToken);

    // Being selected is the one moment a creator has to act on a clock, and
    // until now nothing told them: it appeared in the portal and the 24 hours
    // ran whether or not they opened it. Sent after the approval is stored, so
    // a mail failure cannot leave a creator told about a Feature that is not
    // theirs. Stamped, so re-approving does not mail them again.
    let notified: any = null;
    const { data: claimRow } = await db().from("creator_claims_f5961d0c")
      .select("selected_notified_at").eq("feature_id", featureId).eq("creator_token", creatorToken).maybeSingle();
    if (!claimRow?.selected_notified_at) {
      notified = await mailClaimCreator({
        creatorToken, featureId,
        build: (creator, feature, link) => renderSelectedEmail(creator, feature, link, ACCEPTANCE_HOURS),
      });
      if (notified.ok) {
        await db().from("creator_claims_f5961d0c")
          .update({ selected_notified_at: new Date().toISOString() })
          .eq("feature_id", featureId).eq("creator_token", creatorToken);
      } else {
        console.error("[selected] not mailed:", notified.reason);
      }
    }

    return c.json({
      success: true, approvedAt, acceptanceExpiresAt, cardCode: card?.code ?? null,
      notified: notified ? (notified.ok ? "sent" : notified.reason) : "already notified",
    });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// Creator accepts the feature → starts the CLAIM_DAYS in-progress countdown
app.post("/make-server-f5961d0c/creator-portal/accept-feature", async (c) => {
  try {
    const { token: rawToken, featureId } = await c.req.json();
    if (!rawToken || !featureId) return c.json({ error: "token and featureId required" }, 400);
    const creatorData = await creatorFromToken(rawToken);
    if (!creatorData) return c.json({ error: "Invalid or expired link" }, 401);
    // Impersonation writes must land on the creator's own rows, not on the
    // short lived admin token, which expires in an hour and is in no index.
    const token = creatorData.realToken ?? rawToken;

    // Accepting is only meaningful for a claim an admin has actually selected.
    // The update below matches on (token, feature) alone, so without this a
    // creator could mark themselves "interested" and then POST straight here,
    // promoting their own claim to "claimed" and skipping selection entirely.
    const { data: claim } = await db().from("creator_claims_f5961d0c")
      .select("status, acceptance_expires_at").eq("creator_token", token).eq("feature_id", featureId).maybeSingle();
    if (!claim) return c.json({ error: "You have not been selected for this feature." }, 404);
    // The selection email promises "accept within 24 hours and it is yours".
    // Nothing enforced that, so the window was decorative and a Feature could
    // be accepted a month late. Released here as well as by the sweep, so a
    // late accept does not depend on the sweep having already run.
    if (claim.acceptance_expires_at && new Date(claim.acceptance_expires_at) <= new Date()) {
      await releaseExpiredClaim(featureId, token, "accept");
      return c.json({ error: "That window has closed and the feature has gone back to everyone else." }, 410);
    }
    if (claim.status !== "approved") {
      // Re-accepting is a duplicate, not an attack -- a double tap on a slow
      // connection lands here -- so it gets its own answer rather than the one
      // written for somebody who was never selected.
      return c.json(
        claim.status === "claimed" || claim.status === "submitted"
          ? { error: "You have already accepted this feature." }
          : { error: "You have not been selected for this feature." },
        409,
      );
    }

    const now = new Date();
    // Creators get CLAIM_DAYS to film and submit once they accept a Feature.
    const expiresAt = new Date(now.getTime() + CLAIM_DAYS * 24 * 60 * 60 * 1000).toISOString();
    await db().from("creator_claims_f5961d0c").update({ status: "claimed", expires_at: expiresAt, claimed_at: now.toISOString() }).eq("creator_token", token).eq("feature_id", featureId);
    return c.json({ success: true, expiresAt });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// Admin resets a creator claim — SQL only
app.post("/make-server-f5961d0c/admin/reset-creator-claim", async (c) => {
  try {
    const { featureId, creatorToken } = await c.req.json();
    await db().from("creator_claims_f5961d0c").delete().eq("feature_id", featureId).eq("creator_token", creatorToken);
    return c.json({ success: true });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

app.post("/make-server-f5961d0c/creator-portal/unclaim", async (c) => {
  try {
    const { token: rawToken, featureId } = await c.req.json();
    if (!rawToken || !featureId) return c.json({ error: "Token and featureId required" }, 400);
    const creatorData = await creatorFromToken(rawToken);
    if (!creatorData) return c.json({ error: "Invalid or expired link" }, 401);
    // Impersonation writes must land on the creator's own rows, not on the
    // short lived admin token, which expires in an hour and is in no index.
    const token = creatorData.realToken ?? rawToken;
    await db().from("creator_claims_f5961d0c").update({ status: "unclaimed", unclaimed_at: new Date().toISOString() }).eq("creator_token", token).eq("feature_id", featureId);
    // Withdrawing left no record that survived the creator changing their mind
    // again. register-interest upserts on (feature, token), so re-requesting
    // flips the same row back to "interested" and the withdrawal disappears --
    // the status is gone and unclaimed_at is left stranded behind a newer
    // interested_at. A creator could leave and come back all day and the row
    // would read like a first request every time.
    //
    // The event log is append-only, so this is where that history belongs.
    // It also separates the two things "unclaimed" means: a creator who chose
    // to walk away, logged here, and a claim the sweep released when its
    // deadline passed, which logs claim_expired instead.
    if (creatorData.creatorId) {
      await logCreatorEvent(String(creatorData.creatorId), "claim_unclaimed", { featureId });
    }
    return c.json({ success: true });
  } catch (e: any) { return c.json({ error: "Failed to unclaim", details: e.message }, 500); }
});

app.post("/make-server-f5961d0c/creator-portal/submit", async (c) => {
  try {
    const { token: rawToken, featureId, reelUrl: rawReelUrl, instagram, handedOff, handoffReason } = await c.req.json();
    if (!rawToken || !featureId || !rawReelUrl) return c.json({ error: "token, featureId, and reelUrl required" }, 400);
    const reelUrl = normalizeReelUrl(rawReelUrl);
    if (!reelUrl) return c.json({ error: "That does not look like an Instagram Reel link." }, 400);
    const creatorData = await creatorFromToken(rawToken);
    if (!creatorData) return c.json({ error: "Invalid or expired link" }, 401);
    // Impersonation writes must land on the creator's own rows, not on the
    // short lived admin token, which expires in an hour and is in no index.
    const token = creatorData.realToken ?? rawToken;
    const creatorInstagram = creatorData.instagram || instagram || "";
    const creatorId = creatorData.creatorId || "";

    // The Reel has to be for a Feature this creator actually holds, and the
    // window to film it has to still be open. Neither was checked: any creator
    // could submit against any Feature id, and a claim a week stale was as
    // good as a fresh one.
    const { data: ownClaim } = await db().from("creator_claims_f5961d0c")
      .select("status, expires_at").eq("creator_token", token).eq("feature_id", featureId).maybeSingle();
    if (!ownClaim || !["claimed", "submitted"].includes(String(ownClaim.status))) {
      return c.json({ error: "You do not have this feature to submit for." }, 403);
    }
    if (ownClaim.expires_at && new Date(ownClaim.expires_at) <= new Date()) {
      await releaseExpiredClaim(featureId, token, "submit");
      return c.json({ error: "The window to submit this Reel has closed." }, 410);
    }

    // The handoff question is required only when a card actually exists for this
    // pair. Creators who never opted in have no card and must not be asked
    // whether they handed one off.
    const { data: card } = creatorId
      ? await db().from("ambassador_cards_f5961d0c").select("id, handoff_status, handed_off_at")
          .eq("creator_id", creatorId).eq("feature_id", featureId).maybeSingle()
      : { data: null };
    if (card) {
      if (typeof handedOff !== "boolean") {
        return c.json({ error: "Tell us whether you handed off the card." }, 400);
      }
      await must("submit: record handoff", db().from("ambassador_cards_f5961d0c").update({
        handoff_status: handedOff ? "handed_off" : "not_handed_off",
        handoff_failure_reason: handedOff ? null : (String(handoffReason ?? "").trim() || null),
        // A creator saying they handed it off is weaker evidence than a scan,
        // so it only fills the timestamp in when no scan has already set it.
        handed_off_at: handedOff ? (card.handed_off_at ?? new Date().toISOString()) : null,
      }).eq("id", card.id));
    }

    const submissionId = uid();
    // SQL only
    await db().from("submissions_f5961d0c").insert({ id: submissionId, feature_id: featureId, token, creator_id: creatorId, creator_instagram: creatorInstagram, reel_url: reelUrl, status: "pending" });
    await db().from("creator_claims_f5961d0c").update({ status: "submitted", reel_url: reelUrl, submitted_at: new Date().toISOString() }).eq("creator_token", token).eq("feature_id", featureId);
    return c.json({ success: true, submissionId });
  } catch (e: any) { return c.json({ error: "Failed to submit reel", details: e.message }, 500); }
});

// ─── Creator portal: record feature view — SQL only ──────────────────────────
app.post("/make-server-f5961d0c/creator-portal/view-feature", async (c) => {
  try {
    const { token: rawToken, featureId } = await c.req.json();
    if (!rawToken || !featureId) return c.json({ ok: true });
    const creatorData = await creatorFromToken(rawToken);
    if (!creatorData) return c.json({ error: "Invalid or expired link" }, 401);
    // Impersonation writes must land on the creator's own rows, not on the
    // short lived admin token, which expires in an hour and is in no index.
    const token = creatorData.realToken ?? rawToken;
    // Try updating last_viewed if row exists, otherwise insert a viewing record
    const { error } = await db().from("creator_claims_f5961d0c").update({ last_viewed: new Date().toISOString() }).eq("creator_token", token).eq("feature_id", featureId);
    if (error) {
      await db().from("creator_claims_f5961d0c").insert({ feature_id: featureId, creator_token: token, creator_instagram: creatorData?.instagram || "", status: "viewing", last_viewed: new Date().toISOString(), claimed_at: new Date().toISOString() });
    }
    return c.json({ ok: true });
  } catch { return c.json({ ok: true }); }
});

// ─── Creator portal: consolidated poll ───────────────────────────────────────
// Replaces five separate PostgREST polls the client used to run. Everything is
// filtered by the caller's own token server-side, so a creator can only ever
// see their own claims and submissions — no other creator's token is exposed.
app.get("/make-server-f5961d0c/creator-portal/sync", async (c) => {
  try {
    const rawToken = c.req.query("t");
    if (!rawToken) return c.json({ error: "Token required" }, 400);
    const creatorData = await creatorFromToken(rawToken);
    if (!creatorData) return c.json({ error: "Invalid or expired link" }, 401);
    // Same alias resolution as /creator-portal, or the poll would blank out a
    // portal that had just rendered correctly.
    const token = creatorData.realToken ?? rawToken;

    const [claimsRes, subsRes, featRes] = await Promise.all([
      db().from("creator_claims_f5961d0c")
        .select("feature_id, status, approved_at, expires_at, acceptance_expires_at")
        .eq("creator_token", token),
      db().from("submissions_f5961d0c")
        .select("id, feature_id, reel_url, admin_payout_approved, stripe_link, payout_amount, denied, admin_report_note, cashed_out_at")
        .eq("token", token),
      db().from("features_f5961d0c")
        .select("id, business_id, business_name, address, city, category, payout_range, status, approved_at, winner_instagram, business_instagram, admin_notes, early_access_until"),
    ]);

    const balance = await creatorBalance(token);
    // Same gate as /creator-portal. Without it the poll would re-add a Feature
    // the initial load correctly hid.
    const syncConfirmed = await creatorIsConfirmed(creatorData.creatorId);
    const syncClaimed = new Set((claimsRes.data ?? []).map((cl: any) => cl.feature_id));
    return c.json({
      balance,
      claims: (claimsRes.data ?? []).map((r: any) => ({
        featureId: r.feature_id, status: r.status,
        approvedAt: r.approved_at || null, expiresAt: r.expires_at || null,
        acceptanceExpiresAt: r.acceptance_expires_at || null,
      })),
      submissions: (subsRes.data ?? []).map((r: any) => ({
        id: r.id, featureId: r.feature_id, reelUrl: r.reel_url || "",
        adminPayoutApproved: !!r.admin_payout_approved, stripeLink: r.stripe_link || "",
        payoutAmount: r.payout_amount || "", denied: !!r.denied,
        adminReportNote: r.admin_report_note || "", cashedOutAt: r.cashed_out_at || null,
      })),
      // Same two gates as /creator-portal. Without them the poll would re-add a
      // Feature the initial load correctly withheld.
      features: (featRes.data ?? [])
        .filter((r: any) => syncClaimed.has(r.id)
          || (visibleToCreator(r, syncConfirmed) && featureInCreatorCity(r, creatorData.city)))
        .map((r: any) => ({
          id: r.id, businessId: r.business_id, businessName: r.business_name,
          address: r.address, city: r.city, category: r.category,
          payoutRange: r.payout_range, status: r.status, approvedAt: r.approved_at,
          winnerInstagram: r.winner_instagram || "", businessInstagram: r.business_instagram || "",
          adminNotes: r.admin_notes || "", earlyAccessUntil: r.early_access_until || null,
        })),
    });
  } catch (e: any) { return c.json({ error: "Failed to sync", details: e.message }, 500); }
});

// ─── Creator portal: cash out (record payment details) ───────────────────────
app.post("/make-server-f5961d0c/creator-portal/cash-out", async (c) => {
  try {
    const { token: rawToken, featureId, paymentMethod, paymentInfo } = await c.req.json();
    if (!rawToken || !featureId || !paymentMethod || !paymentInfo) {
      return c.json({ error: "token, featureId, paymentMethod, and paymentInfo required" }, 400);
    }
    const creatorData = await creatorFromToken(rawToken);
    if (!creatorData) return c.json({ error: "Invalid token" }, 401);
    // Impersonation writes must land on the creator's own rows, not on the
    // short lived admin token, which expires in an hour and is in no index.
    const token = creatorData.realToken ?? rawToken;
    // Scoped by token so a creator can only cash out their own submission.
    const { error } = await db().from("submissions_f5961d0c")
      .update({ payment_method: paymentMethod, payment_info: paymentInfo, cashed_out_at: new Date().toISOString() })
      .eq("token", token).eq("feature_id", featureId);
    if (error) throw error;
    return c.json({ success: true });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// ─── Creator portal: finish cashing out ──────────────────────────────────────
app.post("/make-server-f5961d0c/creator-portal/complete-payout", async (c) => {
  try {
    const { token: rawToken, featureId, payoutAmount, instagram } = await c.req.json();
    if (!rawToken || !featureId) return c.json({ error: "token and featureId required" }, 400);
    const creatorData = await creatorFromToken(rawToken);
    if (!creatorData) return c.json({ error: "Invalid token" }, 401);
    // Impersonation writes must land on the creator's own rows, not on the
    // short lived admin token, which expires in an hour and is in no index.
    const token = creatorData.realToken ?? rawToken;
    const ig = creatorData.instagram || instagram || "";

    // The feature update below cannot be scoped by token -- features_f5961d0c
    // carries no creator column -- so ownership is proved here instead. Without
    // it any creator could close any Feature by id, write themselves in as its
    // winner and set its payout, none of which is scoped by the submission
    // update that follows.
    const { data: mine } = await db().from("submissions_f5961d0c")
      .select("id").eq("token", token).eq("feature_id", featureId).limit(1);
    if (!mine?.length) return c.json({ error: "That feature is not yours to close" }, 403);

    const now = new Date().toISOString();
    await db().from("submissions_f5961d0c")
      .update({ cashed_out_at: now })
      .eq("token", token).eq("feature_id", featureId);
    await must("complete-payout: close feature", db().from("features_f5961d0c").update({
      status: "completed", winner_instagram: ig,
      total_payout: payoutAmount || "", claimed_by: ig, claimed_at: now,
    }).eq("id", featureId));
    return c.json({ success: true });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// Expiry reminders for both claim deadlines. Not a cron: nothing in this
// project schedules anything, so this is a route that does one sweep and can be
// called by a button, a scheduler, or curl. Idempotent -- a claim already
// reminded for a given deadline is skipped -- so calling it more often than
// necessary costs nothing and calling it late still catches people.
async function sendClaimExpiryReminders(opts: { dryRun?: boolean } = {}) {
  const now = Date.now();
  const horizon = REMIND_WITHIN_HOURS * 3600e3;

  const { data: claims } = await db().from("creator_claims_f5961d0c")
    .select("feature_id, creator_token, status, claimed_at, acceptance_expires_at, expires_at, acceptance_reminded_at, expiry_reminded_at, expiry_midpoint_reminded_at")
    .in("status", ["approved", "claimed"]);

  const results: any[] = [];
  for (const cl of (claims ?? [])) {
    // Which clock is running depends on where the claim is: an approved claim
    // is waiting to be accepted, a claimed one is waiting for a Reel.
    const kind: "accept" | "submit" = cl.status === "approved" ? "accept" : "submit";
    const dueAt = kind === "accept" ? cl.acceptance_expires_at : cl.expires_at;
    if (!dueAt) continue;

    const msLeft = new Date(dueAt).getTime() - now;
    // Past the deadline there is nothing to save, and the sweep that reclaims
    // expired claims is a separate concern from telling anyone about it.
    if (msLeft <= 0) continue;
    const hoursLeft = Math.max(1, Math.ceil(msLeft / 3600e3));

    // Two sends on the submit clock, one on the acceptance clock.
    //
    // The 24 hours to accept needs no midpoint: the final warning lands with
    // 6 hours to go, which is most of the window and plenty to click a button.
    // Filming is different. On a ten day window the only nudge used to arrive
    // with six hours left, which is not enough notice to arrange a shoot, so
    // the halfway point gets its own -- far enough out to still be actionable.
    //
    // Measured off the window the claim was actually given rather than
    // CLAIM_DAYS, so a claim stamped under an older rule is reminded halfway
    // through its own window and not somebody else's.
    const windowMs = kind === "submit" && cl.claimed_at
      ? new Date(dueAt).getTime() - new Date(cl.claimed_at).getTime()
      : 0;
    const midpointDue = kind === "submit" && windowMs > 0
      && !cl.expiry_midpoint_reminded_at
      && msLeft <= windowMs / 2
      && msLeft > horizon;          // inside the last stretch the warning takes over
    const finalDue = msLeft <= horizon
      && !(kind === "accept" ? cl.acceptance_reminded_at : cl.expiry_reminded_at);
    if (!midpointDue && !finalDue) continue;
    const midpoint = midpointDue;

    if (opts.dryRun) {
      results.push({ featureId: cl.feature_id, kind, hoursLeft, midpoint, wouldSend: true });
      continue;
    }
    const out = await mailClaimCreator({
      creatorToken: cl.creator_token, featureId: cl.feature_id,
      build: (creator, feature, link) => renderClaimExpiryEmail(creator, feature, link, { hoursLeft, kind, midpoint }),
    });
    if (!out.ok) { results.push({ featureId: cl.feature_id, kind, midpoint, skipped: out.reason }); continue; }

    // Stamped only after Postmark accepted, so a failed send is retried by the
    // next sweep rather than silently counted as done.
    await db().from("creator_claims_f5961d0c")
      .update(midpoint
        ? { expiry_midpoint_reminded_at: new Date().toISOString() }
        : kind === "accept"
          ? { acceptance_reminded_at: new Date().toISOString() }
          : { expiry_reminded_at: new Date().toISOString() })
      .eq("feature_id", cl.feature_id).eq("creator_token", cl.creator_token);
    results.push({ featureId: cl.feature_id, kind, hoursLeft, midpoint, sent: true });
  }

  return {
    dryRun: !!opts.dryRun,
    considered: (claims ?? []).length,
    sent: results.filter(r => r.sent).length,
    wouldSend: results.filter(r => r.wouldSend).length,
    skipped: results.filter(r => r.skipped).length,
    results,
  };
}

// Reclaiming an expired claim. The reminder sweep above says a deadline is
// coming; this is what happens when one passes, and until now nothing did --
// so "accept within 24 hours or it goes back to everyone else" was a sentence
// in an email with no code behind it, and a creator could sit on a Feature
// indefinitely while it showed as taken to everybody else.
//
// The Feature goes back on the board only when nobody else is further along
// with it: a claim that was already submitted is left alone, and so is a
// Feature that has since been completed.
async function releaseExpiredClaim(featureId: string, creatorToken: string, reason: "accept" | "submit") {
  try {
    // "unclaimed", not a new "expired": creator_claims lives in the untracked
    // baseline schema, so whether its status column carries a CHECK -- and what
    // is in it -- cannot be read from this repo. Every status written here is
    // one the codebase already writes, and the portal already filters
    // "unclaimed" out of the claims it renders. The reason it ended is kept in
    // the event log rather than smuggled into a column that might reject it.
    await must("release: unclaim", db().from("creator_claims_f5961d0c").update({
      status: "unclaimed", unclaimed_at: new Date().toISOString(),
    }).eq("feature_id", featureId).eq("creator_token", creatorToken));
    const { data: who } = await db().from("creator_signups_f5961d0c")
      .select("id").eq("id", (await creatorFromToken(creatorToken))?.creatorId ?? "").maybeSingle();
    if (who?.id) await logCreatorEvent(who.id, "claim_expired", { featureId, reason });

    // Anyone else still holding it means the Feature is not free.
    const { data: others } = await db().from("creator_claims_f5961d0c")
      .select("creator_token").eq("feature_id", featureId)
      .in("status", ["approved", "claimed", "submitted"]);
    if (others?.length) return { featureId, creatorToken, reason, released: false, held: others.length };

    const { data: feature } = await db().from("features_f5961d0c")
      .select("status").eq("id", featureId).maybeSingle();
    // A completed Feature is finished business; putting it back would reopen
    // work somebody has already been paid for.
    if (!feature || feature.status === "completed") {
      return { featureId, creatorToken, reason, released: false, held: 0 };
    }
    await must("release: reopen feature", db().from("features_f5961d0c").update({
      status: "available", winner_instagram: "", claimed_by: "", claimed_at: null,
    }).eq("id", featureId));
    return { featureId, creatorToken, reason, released: true };
  } catch (e: any) {
    console.error("[claims] release failed:", e?.message ?? e);
    return { featureId, creatorToken, reason, error: e?.message ?? String(e) };
  }
}

async function sweepExpiredClaims(opts: { dryRun?: boolean } = {}) {
  const now = new Date();
  const { data: claims } = await db().from("creator_claims_f5961d0c")
    .select("feature_id, creator_token, status, acceptance_expires_at, expires_at")
    .in("status", ["approved", "claimed"]);

  const results: any[] = [];
  for (const cl of (claims ?? [])) {
    // Which clock applies depends on where the claim is: an approved claim is
    // waiting to be accepted, a claimed one is waiting for a Reel.
    const kind: "accept" | "submit" = cl.status === "approved" ? "accept" : "submit";
    const dueAt = kind === "accept" ? cl.acceptance_expires_at : cl.expires_at;
    if (!dueAt || new Date(dueAt) > now) continue;
    if (opts.dryRun) {
      results.push({ featureId: cl.feature_id, kind, dueAt, wouldRelease: true });
      continue;
    }
    results.push(await releaseExpiredClaim(cl.feature_id, cl.creator_token, kind));
  }
  return {
    dryRun: !!opts.dryRun,
    considered: (claims ?? []).length,
    expired: results.length,
    released: results.filter(r => r.released).length,
    wouldRelease: results.filter(r => r.wouldRelease).length,
    failed: results.filter(r => r.error).length,
    results,
  };
}

// ─── KV housekeeping ──────────────────────────────────────────────────────────
// Nothing in this store has ever been cleaned up. Admin sessions expire after
// twelve hours and stay as rows; login codes expire after ten minutes and stay
// unless somebody used them; and the rate-limit buckets are keyed by hashed IP,
// so without this they would grow by one row per visitor for ever -- an
// unbounded table written by an unauthenticated public route, which is a slower
// version of the problem the limiter exists to prevent.
//
// Prefix-scanned rather than queried by expiry: kv_store has one jsonb column
// and no index inside it, so a scan is what is available. The prefixes below
// are small by design; the pageview buckets are the only large one and they are
// exactly what most needs clearing.
const KV_PRUNE = [
  // { prefix, staleAfterMs } -- how long past its window a row is dead weight.
  { prefix: "adminrl_", ms: ADMIN_WINDOW_MIN * 60e3 },
  { prefix: "pvrl_", ms: PAGEVIEW_WINDOW_MIN * 60e3 },
  { prefix: "logincode_", ms: LOGIN_CODE_TTL_MIN * 60e3 },
  { prefix: "admin_session_", ms: SESSION_HOURS * 3600e3 },
];

// The table is read directly rather than through kv_store.tsx: getByPrefix()
// fetches `key, value` and then returns only the values, so the keys a delete
// needs never come back -- and that file is marked autogenerated, so the fix is
// here rather than in it.
async function pruneKv(opts: { dryRun?: boolean } = {}) {
  const now = Date.now();
  const results: any[] = [];

  for (const { prefix, ms } of KV_PRUNE) {
    const { data, error } = await db().from("kv_store_f5961d0c")
      .select("key, value").like("key", `${prefix}%`);
    if (error) { results.push({ prefix, error: error.message }); continue; }

    const stale: string[] = [];
    for (const row of (data ?? [])) {
      const v: any = (row as any).value ?? {};
      // A row that cannot say how old it is stays. Deleting something we cannot
      // date is how a live admin session or an unspent login code disappears
      // out from under somebody.
      const stamp = v.expiresAt || v.windowStart || v.createdAt;
      if (!stamp) continue;
      const age = now - new Date(stamp).getTime();
      if (isNaN(age) || age <= ms) continue;
      stale.push((row as any).key);
    }

    if (opts.dryRun || !stale.length) {
      results.push({ prefix, total: (data ?? []).length, stale: stale.length, deleted: 0 });
      continue;
    }
    // Chunked, because a delete filter naming every key at once becomes a URL
    // long enough for PostgREST to refuse it.
    let deleted = 0;
    for (let i = 0; i < stale.length; i += 200) {
      const chunk = stale.slice(i, i + 200);
      const { error: delErr } = await db().from("kv_store_f5961d0c").delete().in("key", chunk);
      if (delErr) { results.push({ prefix, error: delErr.message }); break; }
      deleted += chunk.length;
    }
    results.push({ prefix, total: (data ?? []).length, stale: stale.length, deleted });
  }

  return {
    dryRun: !!opts.dryRun,
    deleted: results.reduce((n, r) => n + (r.deleted ?? 0), 0),
    stale: results.reduce((n, r) => n + (r.stale ?? 0), 0),
    failed: results.filter(r => r.error).length,
    results,
  };
}

app.post("/make-server-f5961d0c/admin/kv/prune", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const out = await pruneKv({ dryRun: !!body.dryRun });
    return c.json({ success: true, ...out });
  } catch (e: any) { return c.json({ error: "KV prune failed", details: e.message }, 500); }
});

app.post("/make-server-f5961d0c/admin/claims/sweep-expired", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const out = await sweepExpiredClaims({ dryRun: !!body.dryRun });
    return c.json({ success: true, ...out });
  } catch (e: any) { return c.json({ error: "Expiry sweep failed", details: e.message }, 500); }
});

app.post("/make-server-f5961d0c/admin/claims/expiry-reminders", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const out = await sendClaimExpiryReminders({ dryRun: !!body.dryRun });
    return c.json({ success: true, ...out });
  } catch (e: any) { return c.json({ error: "Reminder sweep failed", details: e.message }, 500); }
});

// ─── Admin: ambassador management ────────────────────────────────────────────
app.get("/make-server-f5961d0c/admin/ambassadors", async (c) => {
  try {
    const [ambRes, refRes, creatorRes, bizRes, viewRes] = await Promise.all([
      db().from("ambassadors_f5961d0c").select("*").order("created_at", { ascending: false }),
      db().from("ambassador_referrals_f5961d0c").select("*").order("created_at", { ascending: false }),
      db().from("creator_signups_f5961d0c").select("id, instagram, email, city"),
      db().from("business_signups_f5961d0c")
        .select("id, business_name, email, referred_by_creator, referral_code, referral_source, created_at")
        .not("referred_by_creator", "is", null),
      // Counted here rather than per row: one read of a narrow table beats a
      // count query per ambassador, and the table only grows with opens.
      db().from("ambassador_link_views_f5961d0c").select("referral_code, is_self_view"),
    ]);
    const ambassadors = ambRes.data ?? [];
    const stored = refRes.data ?? [];

    // An ambassador checking their own link is logged but never counted -- the
    // number is meant to say how much other people opened it.
    const linkViews: Record<string, number> = {};
    for (const v of (viewRes.data ?? [])) {
      if (v.is_self_view) continue;
      const k = canonicalCode(String(v.referral_code || ""));
      linkViews[k] = (linkViews[k] || 0) + 1;
    }

    // Card scans wrote attribution onto the business and no referral row, so
    // every business signed up at the counter was missing from this screen. The
    // scan route records the row now, but the ones already taken never will, and
    // a creator should not have to be told their referral is real but invisible.
    //
    // Synthesised here rather than written: this is a read, and inventing rows
    // in a GET would make the repair depend on somebody opening a page. They
    // carry no reward status, so nothing here can pay anybody -- they exist to
    // be seen and then worked by an admin.
    const ambByCreator: Record<string, any> = {};
    for (const a of ambassadors) if (a.creator_id) ambByCreator[a.creator_id] = a;
    const haveRow = new Set(stored.map((r: any) => `${r.ambassador_id}|${r.business_id}`));
    const synthesised = (bizRes.data ?? []).flatMap((b: any) => {
      const amb = ambByCreator[b.referred_by_creator];
      if (!amb?.ambassador_id) return [];
      if (haveRow.has(`${amb.ambassador_id}|${b.id}`)) return [];
      return [{
        id: `synth_${b.id}`,
        ambassador_id: amb.ambassador_id, creator_id: amb.creator_id,
        creator_instagram: amb.creator_instagram || "",
        referral_code: b.referral_code || amb.referral_code,
        business_id: b.id, business_name: b.business_name, business_email: b.email,
        referral_source: b.referral_source || "ambassador_scan",
        status: "business_created", reward_status: "pending", reward_amount: REFERRAL_REWARD,
        created_at: b.created_at,
        subscription_active_at: null, first_payment_at: null, retained_30d_at: null,
        reward_earned_at: null, reward_paid_at: null, business_created_at: b.created_at,
        unrecorded: true,
      }];
    });
    const referrals = [...stored, ...synthesised];
    const creators: Record<string, any> = {};
    for (const r of (creatorRes.data ?? [])) creators[r.id] = r;

    const byAmbassador: Record<string, any[]> = {};
    for (const r of referrals) (byAmbassador[r.ambassador_id] ??= []).push(r);

    const rows = ambassadors.map((a: any) => {
      const mine = byAmbassador[a.ambassador_id] ?? [];
      const converted = mine.filter((r: any) => !!r.first_payment_at).length;
      return {
        ambassadorId: a.ambassador_id, creatorId: a.creator_id,
        creatorInstagram: a.creator_instagram || creators[a.creator_id]?.instagram || "",
        creatorEmail: creators[a.creator_id]?.email || "",
        referralCode: a.referral_code, referralUrl: a.referral_url,
        enabled: !!a.enabled_status, createdAt: a.created_at,
        businessesReferred: mine.length,
        // How many times the link was opened, and how much of that turned into
        // a business. A conversion rate over referrals says how good the
        // referrals were; this says whether the link is being shared at all,
        // which is the half that was invisible.
        linkViews: linkViews[canonicalCode(String(a.referral_code || ""))] || 0,
        conversionRate: mine.length ? Math.round((converted / mine.length) * 100) : 0,
        rewardsEarned: mine.filter((r: any) => r.reward_status === "paid").reduce((s: number, r: any) => s + parseAmount(r.reward_amount), 0),
      };
    });

    return c.json({
      overview: {
        totalAmbassadors: ambassadors.length,
        activeAmbassadors: ambassadors.filter((a: any) => a.enabled_status).length,
        totalReferrals: referrals.length,
        linkViews: Object.values(linkViews).reduce((a, b) => a + b, 0),
        businessesCreated: referrals.filter((r: any) => !!r.business_created_at).length,
        businessesActivated: referrals.filter((r: any) => !!r.subscription_active_at).length,
        totalRewardsPaid: referrals.filter((r: any) => r.reward_status === "paid").reduce((s: number, r: any) => s + parseAmount(r.reward_amount), 0),
      },
      ambassadors: rows,
      referrals: referrals.map((r: any) => ({
        id: r.id, ambassadorId: r.ambassador_id,
        businessId: r.business_id, businessName: r.business_name, businessEmail: r.business_email,
        creatorInstagram: r.creator_instagram, referralCode: r.referral_code,
        status: r.status, rewardStatus: r.reward_status, rewardAmount: parseAmount(r.reward_amount),
        createdAt: r.created_at,
        // True for a referral this screen inferred from the business rather
        // than read from the referrals table, so the UI can say so.
        unrecorded: !!r.unrecorded,
        subscriptionActiveAt: r.subscription_active_at, firstPaymentAt: r.first_payment_at,
        retained30dAt: r.retained_30d_at, rewardEarnedAt: r.reward_earned_at, rewardPaidAt: r.reward_paid_at,
      })),
    });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// Turns the inferred referrals into real ones. The Ambassadors tab can show a
// business attributed to a creator that has no row, but a shown row cannot be
// advanced through Subscription, First payment or a reward -- those all key off
// ambassador_referrals.id. This writes the rows, once, on purpose.
//
// Idempotent: it only ever inserts where (ambassador, business) has nothing, so
// running it twice creates nothing the second time.
app.post("/make-server-f5961d0c/admin/ambassadors/backfill-referrals", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const dryRun = !!body.dryRun;

    const [ambRes, refRes, bizRes] = await Promise.all([
      db().from("ambassadors_f5961d0c").select("*"),
      db().from("ambassador_referrals_f5961d0c").select("ambassador_id, business_id"),
      db().from("business_signups_f5961d0c")
        .select("id, business_name, email, referred_by_creator, referral_code, referral_source, created_at")
        .not("referred_by_creator", "is", null),
    ]);

    const ambByCreator: Record<string, any> = {};
    for (const a of (ambRes.data ?? [])) if (a.creator_id) ambByCreator[a.creator_id] = a;
    const haveRow = new Set((refRes.data ?? []).map((r: any) => `${r.ambassador_id}|${r.business_id}`));

    const results: any[] = [];
    for (const b of (bizRes.data ?? [])) {
      const amb = ambByCreator[b.referred_by_creator];
      // A business attributed to somebody who is not an ambassador any more is
      // reported rather than skipped silently: it is a real gap, and inventing
      // an ambassador_id for it would be worse than saying so.
      if (!amb?.ambassador_id) {
        results.push({ businessId: b.id, businessName: b.business_name, skipped: "no ambassador for that creator" });
        continue;
      }
      if (haveRow.has(`${amb.ambassador_id}|${b.id}`)) {
        results.push({ businessId: b.id, businessName: b.business_name, skipped: "already recorded" });
        continue;
      }
      if (dryRun) {
        results.push({ businessId: b.id, businessName: b.business_name, creator: amb.creator_instagram || "", wouldCreate: true });
        continue;
      }
      try {
        await must("backfill: referral row", db().from("ambassador_referrals_f5961d0c").insert({
          ambassador_id: amb.ambassador_id,
          creator_id: amb.creator_id,
          creator_instagram: amb.creator_instagram || "",
          referral_code: b.referral_code || amb.referral_code,
          referral_url: amb.referral_url,
          business_id: b.id, business_name: b.business_name, business_email: b.email,
          referral_source: b.referral_source || "ambassador_scan",
          // Stage and reward are left where a fresh referral starts. Nothing is
          // marked converted or earned by a backfill: an admin works it from
          // here exactly as they would a referral taken today.
          status: "business_created",
          reward_amount: REFERRAL_REWARD,
          business_created_at: b.created_at,
        }));
        // Guards a second business attributed to the same pair inside one run.
        haveRow.add(`${amb.ambassador_id}|${b.id}`);
        results.push({ businessId: b.id, businessName: b.business_name, creator: amb.creator_instagram || "", created: true });
      } catch (e: any) {
        results.push({ businessId: b.id, businessName: b.business_name, error: e?.message ?? String(e) });
      }
    }

    return c.json({
      success: true, dryRun,
      considered: (bizRes.data ?? []).length,
      created: results.filter(r => r.created).length,
      wouldCreate: results.filter(r => r.wouldCreate).length,
      skipped: results.filter(r => r.skipped).length,
      failed: results.filter(r => r.error).length,
      results,
    });
  } catch (e: any) { return c.json({ error: "Backfill failed", details: e.message }, 500); }
});

app.post("/make-server-f5961d0c/admin/ambassadors/toggle", async (c) => {
  try {
    const { ambassadorId, enabled } = await c.req.json();
    if (!ambassadorId) return c.json({ error: "ambassadorId required" }, 400);
    await must("ambassador: toggle", db().from("ambassadors_f5961d0c")
      .update({ enabled_status: !!enabled }).eq("ambassador_id", ambassadorId));
    return c.json({ success: true });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// Advance a referral through the reward pipeline.
//
// These are billing facts (a subscription starting, a payment clearing, 30 days
// elapsing) and there is no payment integration wired up yet, so an admin
// records them. Each stage stamps its own timestamp, which keeps the pipeline
// reconstructible and lets a real billing webhook drive the same endpoint later.
const REFERRAL_STAGES: Record<string, string> = {
  onboarding_started: "onboarding_started_at",
  profile_completed: "profile_completed_at",
  subscription_activated: "subscription_active_at",
  first_payment: "first_payment_at",
  retained_30d: "retained_30d_at",
};

app.post("/make-server-f5961d0c/admin/referrals/advance", async (c) => {
  try {
    const { referralId, stage } = await c.req.json();
    if (!referralId || !stage) return c.json({ error: "referralId and stage required" }, 400);
    const column = REFERRAL_STAGES[stage];
    if (!column) return c.json({ error: `Unknown stage: ${stage}` }, 400);

    const { data: ref } = await db().from("ambassador_referrals_f5961d0c").select("*").eq("id", referralId).maybeSingle();
    if (!ref) return c.json({ error: "Referral not found" }, 404);

    const now = new Date().toISOString();
    const patch: Record<string, any> = { [column]: now, status: stage, updated_at: now };

    // The reward is earned only once both conditions in the programme rules are
    // met: a successful first payment and 30 days retained.
    const firstPayment = column === "first_payment_at" ? now : ref.first_payment_at;
    const retained = column === "retained_30d_at" ? now : ref.retained_30d_at;
    if (firstPayment && retained && ref.reward_status === "pending" && !ref.reward_earned_at) {
      patch.reward_earned_at = now;
      patch.reward_status = "earned";
      patch.status = "reward_earned";
    }
    await must("referral: advance", db().from("ambassador_referrals_f5961d0c").update(patch).eq("id", referralId));
    return c.json({ success: true, rewardEarned: !!patch.reward_earned_at });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// Paying the reward credits the same ledger the reel payouts use, so ambassador
// earnings and reel earnings share one balance and one cash-out path.
app.post("/make-server-f5961d0c/admin/referrals/pay-reward", async (c) => {
  try {
    const { referralId } = await c.req.json();
    if (!referralId) return c.json({ error: "referralId required" }, 400);
    const { data: ref } = await db().from("ambassador_referrals_f5961d0c").select("*").eq("id", referralId).maybeSingle();
    if (!ref) return c.json({ error: "Referral not found" }, 404);
    if (ref.reward_status === "paid") return c.json({ success: true, alreadyPaid: true });
    if (!ref.reward_earned_at) return c.json({ error: "Reward has not been earned yet" }, 400);

    const { data: amb } = await db().from("ambassadors_f5961d0c").select("creator_token, creator_id").eq("ambassador_id", ref.ambassador_id).maybeSingle();
    // Resolved from the creator, not from ambassadors.creator_token: that
    // column is a copy taken at opt-in, and crediting a stale string would put
    // the reward on a token no balance is read from. The creator's own record
    // is the authority, and ensureCreatorPortalToken returns exactly the token
    // creatorBalance() sums over.
    const { data: rewardCreator } = amb?.creator_id
      ? await db().from("creator_signups_f5961d0c")
          .select("id, instagram, email, city").eq("id", amb.creator_id).maybeSingle()
      : { data: null };
    const token = rewardCreator ? await ensureCreatorPortalToken(rewardCreator) : (amb?.creator_token || "");
    if (!token) return c.json({ error: "Ambassador has no active creator link" }, 400);
    // Kept in step, so the next read of the column is not wrong in the same way.
    if (amb?.creator_token !== token) {
      await db().from("ambassadors_f5961d0c")
        .update({ creator_token: token }).eq("ambassador_id", ref.ambassador_id);
    }

    const amount = parseAmount(ref.reward_amount) || REFERRAL_REWARD;
    // Guarded on referral_id so paying twice cannot double-credit.
    const { data: already } = await db().from("creator_earnings_f5961d0c")
      .select("id").eq("referral_id", referralId).limit(1);
    if (!already?.length) {
      await must("referral: credit reward", db().from("creator_earnings_f5961d0c").insert({
        creator_token: token, creator_id: amb?.creator_id || null,
        amount, source: "ambassador_referral", referral_id: referralId,
        note: `Ambassador referral reward — ${ref.business_name || "business"}`,
      }));
    }
    const now = new Date().toISOString();
    await must("referral: mark reward paid", db().from("ambassador_referrals_f5961d0c")
      .update({ reward_status: "paid", reward_paid_at: now, status: "reward_paid", updated_at: now })
      .eq("id", referralId));
    return c.json({ success: true, credited: amount, balance: await creatorBalance(token) });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// ─── Admin: mark a creator as paid ───────────────────────────────────────────
// Zeroes the creator's balance by settling what they are owed. Nothing is
// deleted — the credits stay in the ledger and the settlement is recorded as a
// paid payout row, so history survives the reset.
app.post("/make-server-f5961d0c/admin/mark-paid", async (c) => {
  try {
    const { creatorId, creatorToken, method, handle } = await c.req.json();
    let token = creatorToken || "";
    if (!token && creatorId) token = (await kv.get(`ctokenref_${creatorId}`).catch(() => null))?.token || "";
    if (!token) return c.json({ error: "creatorToken or a creatorId with an issued link is required" }, 400);

    const before = await creatorBalance(token);
    if (before.totalEarned <= 0) return c.json({ success: true, paid: 0, balance: before });

    const now = new Date().toISOString();
    // Settle anything the creator already requested.
    await must("mark-paid: settle requests", db().from("creator_payout_requests_f5961d0c")
      .update({ status: "paid", paid_at: now })
      .eq("creator_token", token).eq("status", "requested"));

    // Anything credited but never requested still needs a record to net off.
    if (before.availableEarnings > 0) {
      const creatorData = await creatorFromToken(token);
      await must("mark-paid: record direct payout", db().from("creator_payout_requests_f5961d0c").insert({
        creator_token: token,
        creator_id: creatorData?.creatorId || null,
        creator_instagram: creatorData?.instagram || "",
        amount: before.availableEarnings,
        method: method || "Manual",
        handle: handle || "paid outside Contynt",
        status: "paid",
        paid_at: now,
      }));
    }
    return c.json({ success: true, paid: before.totalEarned, balance: await creatorBalance(token) });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// ─── Admin: outstanding cash-out requests ────────────────────────────────────
// A creator saying the money never arrived.
//
// Scoped to their own payouts by the token, and only to ones already marked
// sent: a request still sitting in the queue has not been paid yet, so
// "didn't receive it" is not yet a meaningful thing to say about it.
app.post("/make-server-f5961d0c/creator-portal/report-payout-issue", async (c) => {
  try {
    const { token: rawToken, payoutId, note } = await c.req.json();
    const creatorData = await creatorFromToken(rawToken);
    if (!creatorData) return c.json({ error: "Invalid or expired link" }, 401);
    if (creatorData.impersonated) return c.json({ error: "Read-only session" }, 403);
    const token = creatorData.realToken ?? rawToken;
    if (!payoutId) return c.json({ error: "payoutId required" }, 400);

    // Matched on the token as well as the id, so a payout id belonging to
    // somebody else cannot be reported -- and cannot be probed for existence.
    const { data: row } = await db().from("creator_payout_requests_f5961d0c")
      .select("id, status, amount, not_received_at")
      .eq("id", payoutId).eq("creator_token", token).maybeSingle();
    if (!row) return c.json({ error: "That payout is not on your account." }, 404);
    if (row.status !== "paid") return c.json({ error: "That cash out has not been sent yet." }, 409);
    // Reporting twice is not an error. A creator who hears nothing back will
    // press it again, and answering with a failure would be both wrong and a
    // reason to give up on the channel.
    if (row.not_received_at) {
      return c.json({ success: true, alreadyReported: true, reportedAt: row.not_received_at });
    }

    const now = new Date().toISOString();
    await must("payout issue: report", db().from("creator_payout_requests_f5961d0c").update({
      not_received_at: now,
      not_received_note: String(note ?? "").trim().slice(0, 500) || null,
      // Cleared, so re-reporting a payout an admin previously closed reopens it
      // rather than arriving already resolved.
      issue_resolved_at: null,
      issue_resolution: null,
    }).eq("id", payoutId));
    await logCreatorEvent(creatorData.creatorId, "payout_not_received", {
      payoutId, amount: parseAmount(row.amount),
    });
    return c.json({ success: true, reportedAt: now });
  } catch (e: any) { return c.json({ error: "Could not send that report", details: e.message }, 500); }
});

// Closing a report. Deliberately does not touch the payout's own status: the
// money either went out or it did not, and that is what mark-paid records.
app.post("/make-server-f5961d0c/admin/payouts/resolve-issue", async (c) => {
  try {
    const { payoutId, resolution } = await c.req.json();
    if (!payoutId) return c.json({ error: "payoutId required" }, 400);
    await must("payout issue: resolve", db().from("creator_payout_requests_f5961d0c").update({
      issue_resolved_at: new Date().toISOString(),
      issue_resolution: String(resolution ?? "").trim().slice(0, 500) || null,
    }).eq("id", payoutId));
    return c.json({ success: true });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// The confirm-your-profile link for one creator, to be pasted into a DM.
//
// Reuses the live token rather than minting one. Issuing a new token retires
// whatever is already in that creator's inbox, so an admin fetching a link to
// DM would silently break the emailed one -- and the creator who eventually got
// round to the email would land on "this link is not valid". A fresh token is
// minted only when there is none, or the one on file has expired.
//
// No email is sent. This hands back the URL and nothing else; whether it
// reaches the creator by DM is the admin's business.
app.post("/make-server-f5961d0c/admin/creator-verify-link", async (c) => {
  try {
    const { creatorId } = await c.req.json();
    if (!creatorId) return c.json({ error: "creatorId required" }, 400);

    const { data: row } = await db().from("creator_signups_f5961d0c")
      .select("id, instagram, instagram_handle, verify_token, verify_token_expires_at, verification_status")
      .eq("id", creatorId).maybeSingle();
    if (!row) return c.json({ error: "No creator with that id." }, 404);

    const live = row.verify_token
      && (!row.verify_token_expires_at || new Date(row.verify_token_expires_at) > new Date());

    let token = String(row.verify_token ?? "");
    let expiresAt = row.verify_token_expires_at ?? null;
    if (!live) {
      token = secureToken(32);
      expiresAt = new Date(Date.now() + VERIFY_DAYS * 864e5).toISOString();
      await must("verify link: issue token", db().from("creator_signups_f5961d0c")
        .update({ verify_token: token, verify_token_expires_at: expiresAt }).eq("id", row.id));
    }

    // Logged either way. A link handed out by hand is still a link handed out,
    // and without this the funnel would show a creator confirming from an email
    // nobody sent.
    await logCreatorEvent(row.id, "verify_link_copied", { reused: !!live });

    return c.json({
      success: true,
      link: verifyLinkFor(token),
      reused: !!live,
      expiresAt,
      handle: row.instagram_handle || String(row.instagram ?? "").replace(/^@+/, ""),
      confirmed: row.verification_status === "confirmed",
    });
  } catch (e: any) { return c.json({ error: "Could not build that link", details: e.message }, 500); }
});

app.get("/make-server-f5961d0c/admin/payout-requests", async (c) => {
  try {
    const { data, error } = await db().from("creator_payout_requests_f5961d0c")
      .select("*").order("requested_at", { ascending: false });
    if (error) throw error;
    return c.json({
      requests: (data ?? []).map((r: any) => ({
        id: r.id, creatorToken: r.creator_token, creatorId: r.creator_id,
        creatorInstagram: r.creator_instagram || "", amount: parseAmount(r.amount),
        method: r.method, handle: r.handle, status: r.status,
        requestedAt: r.requested_at, paidAt: r.paid_at,
        notReceivedAt: r.not_received_at || null,
        notReceivedNote: r.not_received_note || "",
        issueResolvedAt: r.issue_resolved_at || null,
        issueResolution: r.issue_resolution || "",
      })),
    });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// ─── Admin: approve payout ───────────────────────────────────────────────────
// The client used to PATCH submissions and features directly for this. Doing it
// server-side also lets us close out the feature in the same call, so the
// creator portal no longer needs write access to mark features completed.
app.post("/make-server-f5961d0c/admin/approve-payout", async (c) => {
  try {
    const { submissionId, payoutAmount } = await c.req.json();
    if (!submissionId) return c.json({ error: "submissionId required" }, 400);
    const { data: sub, error: subErr } = await db().from("submissions_f5961d0c").select("*").eq("id", submissionId).single();
    if (subErr || !sub) return c.json({ error: "Submission not found" }, 404);

    const amount = parseAmount(payoutAmount ?? sub.payout_amount);
    if (amount <= 0) return c.json({ error: "A credit amount greater than zero is required" }, 400);

    // Crediting is the money-moving step, so make it idempotent: a second click
    // on Approve & Add to Balance must not pay the creator twice.
    const { data: already } = await db().from("creator_earnings_f5961d0c")
      .select("id").eq("submission_id", submissionId).eq("source", "submission").limit(1);
    if (!already?.length) {
      await must("approve-payout: credit creator", db().from("creator_earnings_f5961d0c").insert({
        creator_token: sub.token,
        creator_id: sub.creator_id || null,
        amount,
        source: "submission",
        submission_id: submissionId,
        feature_id: sub.feature_id,
        note: `Reel approved for ${sub.creator_instagram || "creator"}`,
      }));
    }

    await must("approve-payout: mark submission", db().from("submissions_f5961d0c")
      .update({ payout_amount: payoutAmount || String(amount), admin_payout_approved: true, cashed_out_at: new Date().toISOString() })
      .eq("id", submissionId));
    await must("approve-payout: close feature", db().from("features_f5961d0c").update({
      status: "completed",
      winner_instagram: sub.creator_instagram || "",
      completed_at: new Date().toISOString(),
      total_payout: payoutAmount || String(amount),
      claimed_by: sub.creator_instagram || "",
    }).eq("id", sub.feature_id));

    const balance = await creatorBalance(sub.token);
    return c.json({ success: true, credited: amount, balance });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// ─── Admin: deny/report a submission ─────────────────────────────────────────
app.post("/make-server-f5961d0c/admin/deny-submission", async (c) => {
  try {
    const { submissionId, note } = await c.req.json();
    if (!submissionId) return c.json({ error: "submissionId required" }, 400);
    const { data: sub } = await db().from("submissions_f5961d0c").select("feature_id, token").eq("id", submissionId).single();
    const { error } = await db().from("submissions_f5961d0c")
      .update({ admin_report_note: note || "", denied: true })
      .eq("id", submissionId);
    if (error) throw error;
    // Put the feature back on the board so another creator can claim it.
    if (sub?.feature_id) {
      await must("deny-submission: reopen feature", db().from("features_f5961d0c").update({
        status: "available", winner_instagram: "", total_payout: "",
        claimed_by: "", claimed_at: null,
      }).eq("id", sub.feature_id));
      // And release the claim behind it. Reopening the Feature while leaving
      // the claim at "submitted" left the creator's portal still showing it as
      // theirs, waiting on a decision that had already been made.
      if (sub.token) {
        await db().from("creator_claims_f5961d0c").update({
          status: "unclaimed", unclaimed_at: new Date().toISOString(),
        }).eq("feature_id", sub.feature_id).eq("creator_token", sub.token);
      }
    }
    return c.json({ success: true });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// ─── Creator portal: request a cash out ──────────────────────────────────────
app.post("/make-server-f5961d0c/creator-portal/request-payout", async (c) => {
  try {
    const { token: rawToken, method, handle } = await c.req.json();
    if (!rawToken || !method || !handle) return c.json({ error: "token, method, and handle required" }, 400);
    const creatorData = await creatorFromToken(rawToken);
    if (!creatorData) return c.json({ error: "Invalid or expired link" }, 401);
    // Impersonation writes must land on the creator's own rows, not on the
    // short lived admin token, which expires in an hour and is in no index.
    const token = creatorData.realToken ?? rawToken;
    if (!["PayPal", "Venmo", "Zelle"].includes(method)) return c.json({ error: "Unsupported payout method" }, 400);

    // The amount comes from the ledger, never from the client — otherwise a
    // creator could request more than they have earned.
    const balance = await creatorBalance(token);
    if (balance.availableEarnings <= 0) return c.json({ error: "No balance available to cash out" }, 400);

    await must("request-payout: create request", db().from("creator_payout_requests_f5961d0c").insert({
      creator_token: token,
      creator_id: creatorData.creatorId || null,
      creator_instagram: creatorData.instagram || "",
      amount: balance.availableEarnings,
      method,
      handle,
      status: "requested",
    }));
    return c.json({ success: true, amount: balance.availableEarnings, balance: await creatorBalance(token) });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// ─── Creator portal: update email ────────────────────────────────────────────
app.post("/make-server-f5961d0c/creator-portal/update-email", async (c) => {
  try {
    const { token: rawToken, email } = await c.req.json();
    if (!rawToken || !email) return c.json({ error: "token and email required" }, 400);
    const creatorData = await creatorFromToken(rawToken);
    if (!creatorData) return c.json({ error: "Invalid token" }, 401);
    // Impersonation writes must land on the creator's own rows, not on the
    // short lived admin token, which expires in an hour and is in no index.
    const token = creatorData.realToken ?? rawToken;
    await db().from("creator_signups_f5961d0c").update({ email }).eq("id", creatorData.creatorId);
    await kv.set(`ctoken_${token}`, { ...creatorData, email });
    return c.json({ success: true });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// /creator-portal/payout wrote to creator_payouts_f5961d0c, a table nothing
// reads: balances are derived from creator_earnings and
// creator_payout_requests, and have been since the ledger replaced it. The
// route had no callers either. Removed rather than left as a second, silently
// diverging record of what a creator is owed.

// ─── Business portal ──────────────────────────────────────────────────────────
app.get("/make-server-f5961d0c/business-portal", async (c) => {
  const token = c.req.query("t");
  if (!token) return c.json({ error: "Token required" }, 400);

  let bizData: any = null;
  try { bizData = await businessFromToken(token); } catch {}
  if (!bizData) return c.json({ error: "Invalid or expired link" }, 401);

  const result: any = { business: bizData, reels: [], requestingCreators: [], inProgressCreators: [], publishedFeatures: [] };

  try {
    const bizId = String(bizData.businessId || "");
    if (!bizId) return c.json(result);

    // Reels count
    const tierMap: Record<string, number> = { Starter: 1, Growth: 2, Pro: 4, Scale: 8 };
    const { data: bizInfo } = await db().from("business_signups_f5961d0c").select("subscription_tier, address, instagram, email, plan_clicks").eq("id", bizId).single();
    const tier = (bizInfo as any)?.subscription_tier || null;
    const tierLimit = tier ? (tierMap[tier] || 1) : 0;
    // reelsLimit is the tier allowance only. Usage is derived from the
    // features themselves client-side (lib/featureQuota), which is the single
    // source of truth; the old stored counter knew nothing about one-off
    // purchases or withdrawn features and has been dropped.
    result.reelsLimit = tierLimit;
    result.subscriptionTier = tier;
    // Profile fields the portal used to read straight from PostgREST.
    result.address = (bizInfo as any)?.address || "";
    result.instagram = (bizInfo as any)?.instagram || "";
    result.email = (bizInfo as any)?.email || "";
    result.planClicks = (bizInfo as any)?.plan_clicks || 0;
    const featRes = await db().from("features_f5961d0c").select("id, category, payout_range, status, approved_at, offered_at, business_notes, is_trial, is_one_off, request_notes, submitted_by_business").eq("business_id", bizId).order("offered_at", { ascending: false });
    const featureIds: string[] = (featRes.data ?? []).map((f: any) => String(f.id));
    // offeredAt goes over the wire because the quota is scoped to the current
    // month and the client computes the same rule -- without the grant date it
    // would count every Feature the business has ever had.
    result.publishedFeatures = (featRes.data ?? []).map((f: any) => ({ id: f.id, category: f.category, payoutRange: f.payout_range, status: f.status, approvedAt: f.approved_at || null, offeredAt: f.offered_at || null, businessNotes: f.business_notes || "", isTrial: f.is_trial || false, isOneOff: f.is_one_off || false, requestNotes: f.request_notes || "", submittedByBusiness: f.submitted_by_business || false }));
    if (featureIds.length === 0) return c.json(result);

    const [subsRes, claimsRes] = await Promise.allSettled([
      db().from("submissions_f5961d0c")
        .select("id, feature_id, token, creator_instagram, reel_url, status, metrics, business_feedback, approved_at, submitted_at")
        .eq("status", "approved").in("feature_id", featureIds).order("submitted_at", { ascending: false }),
      db().from("creator_claims_f5961d0c")
        .select("feature_id, creator_instagram, status, claimed_at")
        .in("feature_id", featureIds),
    ]);

    if (subsRes.status === "fulfilled") {
      result.reels = (subsRes.value.data ?? []).map((s: any) => ({
        id: s.id, featureId: s.feature_id, token: s.token,
        creatorInstagram: s.creator_instagram, reelUrl: s.reel_url, status: s.status,
        metrics: s.metrics || {}, businessFeedback: s.business_feedback,
        approvedAt: s.approved_at, submittedAt: s.submitted_at,
      }));
    }

    if (claimsRes.status === "fulfilled") {
      for (const cl of (claimsRes.value.data ?? [])) {
        if (cl.status === "interested") {
          result.requestingCreators.push({ featureId: cl.feature_id, instagram: cl.creator_instagram || "", requestedAt: cl.claimed_at || "" });
        } else if (cl.status === "claimed" || cl.status === "approved") {
          result.inProgressCreators.push({ featureId: cl.feature_id, instagram: cl.creator_instagram || "" });
        }
      }
    }
  } catch {}

  return c.json(result);
});

// ─── Business portal: update contact email ───────────────────────────────────
app.post("/make-server-f5961d0c/business-portal/update-email", async (c) => {
  try {
    const { bizToken, email } = await c.req.json();
    if (!bizToken || !email) return c.json({ error: "bizToken and email required" }, 400);
    const bizData = await businessFromToken(bizToken);
    if (!bizData) return c.json({ error: "Invalid token" }, 401);
    // Scoped to the token's own business — the id never comes from the client.
    const { error } = await db().from("business_signups_f5961d0c").update({ email }).eq("id", bizData.businessId);
    if (error) throw error;
    return c.json({ success: true });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// ─── Business portal: record a pricing-plan click ────────────────────────────
app.post("/make-server-f5961d0c/business-portal/track-plan-click", async (c) => {
  try {
    const { bizToken } = await c.req.json();
    if (!bizToken) return c.json({ error: "bizToken required" }, 400);
    const bizData = await businessFromToken(bizToken);
    if (!bizData) return c.json({ error: "Invalid token" }, 401);
    // Incremented in the database, not read-modify-written here: two clicks
    // landing together used to read the same value and write the same value,
    // so one of them vanished and the metric quietly undercounted.
    const { data: next, error } = await db()
      .rpc("increment_plan_clicks_f5961d0c", { p_business_id: bizData.businessId });
    if (error) throw error;
    return c.json({ success: true, planClicks: next ?? null });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// ─── Business portal: submit feedback on a reel ──────────────────────────────
app.post("/make-server-f5961d0c/business-portal/feedback", async (c) => {
  try {
    const { bizToken, submissionId, reaction, note } = await c.req.json();
    if (!bizToken || !submissionId || !reaction) return c.json({ error: "bizToken, submissionId, and reaction required" }, 400);
    const bizData = await businessFromToken(bizToken);
    if (!bizData) return c.json({ error: "Invalid token" }, 401);

    // The submission id arrives from the client, so it has to be proved to
    // belong to this business before anything is written. Without this, one
    // valid portal token was write access to every submission in the system --
    // and an "approve" here calls markReelLive(), which stamps a winner onto
    // somebody else's Feature and settles their creator's claim with it.
    //
    // Fetched once and reused below: re-reading after the update would be a
    // second round trip for a row already in hand.
    const { data: sub } = await db().from("submissions_f5961d0c")
      .select("*").eq("id", submissionId).maybeSingle();
    // 404 rather than 403 on both misses. Which submission ids exist is not
    // this business's to learn, and separating the two answers would say.
    if (!sub) return c.json({ error: "Submission not found" }, 404);
    const { data: owner } = await db().from("features_f5961d0c")
      .select("business_id").eq("id", sub.feature_id).maybeSingle();
    if (!owner || String(owner.business_id) !== String(bizData.businessId)) {
      return c.json({ error: "Submission not found" }, 404);
    }

    // Save feedback
    await db().from("submissions_f5961d0c").update({
      business_approved: reaction === "approve",
      business_feedback: { reaction, note: note || "", submittedAt: new Date().toISOString(), businessName: bizData.businessName },
    }).eq("id", submissionId);

    // 👍 Approve triggers the full approval flow — updates creator portal too
    if (reaction === "approve" && sub.status !== "approved") await markReelLive(sub);

    return c.json({ success: true });
  } catch (e: any) { return c.json({ error: "Failed to submit feedback", details: e.message }, 500); }
});

Deno.serve(app.fetch);
