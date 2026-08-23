import { Hono } from "npm:hono@4";
import { cors } from "npm:hono@4/cors";
import { logger } from "npm:hono@4/logger";
import { createClient } from "jsr:@supabase/supabase-js@2.49.8";
// Same package the creator portal already uses for QR codes, imported here so
// the printable is generated server-side and the code and its QR cannot disagree.
import QRCode from "npm:qrcode@1.5.4";
import * as kv from "./kv_store.tsx";

const app = new Hono();
app.use("*", logger(console.log));
app.use("/*", cors({ origin: "*", allowHeaders: ["Content-Type", "Authorization", "x-admin-token"], allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"], exposeHeaders: ["Content-Length"], maxAge: 600 }));

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

function uid(prefix = "") {
  return `${prefix}${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}
function token32() {
  const c = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  return Array.from({ length: 8 }, () => c[Math.floor(Math.random() * c.length)]).join("");
}

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

const adminGuard = async (c: any, next: any) => {
  if (ADMIN_OPEN.has(new URL(c.req.url).pathname)) return next();
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

app.post("/make-server-f5961d0c/admin/login", async (c) => {
  try {
    if (!ADMIN_SECRET) return c.json({ error: "Server is missing ADMIN_SECRET" }, 500);
    const { password } = await c.req.json();
    if (!password || password !== ADMIN_SECRET) return c.json({ error: "Incorrect password" }, 401);
    const token = `${token32()}${token32()}${token32()}${token32()}`;
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

    // Give the owner a way straight into their portal.
    const token = token32();
    await kv.set(`biztoken_${token}`, { businessId: biz.id, businessName: biz.business_name, city: biz.city || "", createdAt: new Date().toISOString() });
    await kv.set(`biztokenref_${biz.id}`, { token, businessId: biz.id, createdAt: new Date().toISOString() });

    return c.json({ success: true, businessId: biz.id, businessCreated: createdBusiness, portalToken: token });
  } catch (e: any) { return c.json({ error: "Could not complete signup", details: e.message }, 500); }
});

// ─── Crypto helpers ───────────────────────────────────────────────────────────
// token32() above is 8 characters of Math.random. That is the weakest link in
// creator auth, but the tokens it minted are live in the wild and KV looks them
// up by key, so nothing about their format is load bearing. New tokens are
// minted here instead; old ones keep working untouched.
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

// Reuses the creator's live portal token when there is one, so a verify link
// opened twice does not invalidate the link they already have.
async function ensureCreatorPortalToken(creator: any): Promise<string> {
  const ref = await kv.get(`ctokenref_${creator.id}`).catch(() => null);
  if (ref?.token && await kv.get(`ctoken_${ref.token}`).catch(() => null)) return ref.token;
  const token = secureToken(24);
  await kv.set(`ctoken_${token}`, {
    creatorId: creator.id, instagram: creator.instagram, email: creator.email,
    city: creator.city, createdAt: new Date().toISOString(),
  });
  await kv.set(`ctokenref_${creator.id}`, { token, creatorId: creator.id, createdAt: new Date().toISOString() });
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

// Same contract as ensureCreatorPortalToken: reuse the live token when there is
// one, so signing in through the code flow does not invalidate the ?biz= link
// already sitting in the owner's inbox. Impersonation tokens are deliberately
// absent from biztokenref_, so an admin session can never be handed back here.
async function ensureBusinessPortalToken(biz: any): Promise<string> {
  const ref = await kv.get(`biztokenref_${biz.id}`).catch(() => null);
  if (ref?.token && await kv.get(`biztoken_${ref.token}`).catch(() => null)) return ref.token;
  const token = secureToken(24);
  await kv.set(`biztoken_${token}`, {
    businessId: biz.id, businessName: biz.business_name, city: biz.city || "",
    createdAt: new Date().toISOString(),
  });
  await kv.set(`biztokenref_${biz.id}`, { token, businessId: biz.id, createdAt: new Date().toISOString() });
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
      const sent = await postmarkSend({ to: row.email, ...rendered, stream: POSTMARK_STREAM });
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

const POSTMARK_TYPES = new Set(["Delivery", "Bounce", "SpamComplaint", "Open", "Click"]);

async function recordEmailEvent(ev: any) {
  const type = String(ev?.RecordType ?? "");
  if (!POSTMARK_TYPES.has(type)) return { skipped: type || "unknown" };

  // Field naming varies by event type: Delivery/Open/Click carry Recipient,
  // Bounce and SpamComplaint carry Email.
  const email = String(ev.Recipient ?? ev.Email ?? "").trim().toLowerCase();
  const occurredAt = ev.DeliveredAt ?? ev.BouncedAt ?? ev.ReceivedAt ?? new Date().toISOString();

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
  await db().from("email_events_f5961d0c").insert({
    creator_id: creatorId,
    business_id: businessId,
    message_id: ev.MessageID ?? ev.MessageId ?? null,
    type,
    payload: ev,
    occurred_at: occurredAt,
  });

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
  // Delivery, Open and Click are logged and nothing more. Apple Mail Privacy
  // Protection prefetches images, so an Open means a mail client touched the
  // message, not that a human read it. Letting it advance verification_status
  // would mark creators confirmed who never saw the mail.
  return { recorded: type, matched: true };
}

app.post("/make-server-f5961d0c/webhooks/postmark", async (c) => {
  try {
    if (!POSTMARK_WEBHOOK_SECRET) return c.json({ error: "Server is missing POSTMARK_WEBHOOK_SECRET" }, 500);
    if (!postmarkAuthorized(c)) return c.json({ error: "Unauthorized" }, 401);

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
  try {
    const code = canonicalCode(c.req.param("code"));
    const body = await c.req.json().catch(() => ({} as any));
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
    let portalToken: string | null = null;
    if (business?.id) {
      try {
        portalToken = await ensureBusinessPortalToken({
          id: business.id,
          business_name: business.business_name ?? businessName,
          city: business.city ?? "",
        });
      } catch (e: any) {
        // The lead is already saved. Failing to mint a token is a worse portal
        // experience, not a lost signup, so the caller falls back to the
        // confirmation screen rather than seeing an error.
        console.error("[lead] could not mint portal token:", e?.message ?? e);
      }
    }
    return c.json({ ok: true, businessId: business?.id ?? null, portalToken });
  } catch (e: any) {
    console.error("[lead]", e?.message ?? e);
    // Never dead-end the person standing at the counter.
    return c.json({ ok: true });
  }
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
    const { data: cards } = await db().from("ambassador_cards_f5961d0c")
      .select("code").eq("feature_id", featureId);
    const codes = (cards ?? []).map((r: any) => r.code);
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


// A6 (105x148mm) centred on a letter sheet with crop marks. This is HTML rather
// than a generated PDF: adding a PDF toolchain to a Deno edge function to draw
// two rectangles and a QR would cost far more than it returns, and every browser
// prints this to PDF natively at the right trim size.
function buildCardSheet(code: string, qr: string): string {
  // Four identical cards, 2x2 on a letter sheet, so one print run gives the
  // creator a handful to leave behind. Identical because the code belongs to
  // the creator, not to a Feature -- any card works at any business.
  //
  // Deliberately anonymous: no handle, name, photo or id. A card left on a
  // counter should not tell a stranger who dropped it off.
  const card = `
    <div class="card">
      <div class="inner">
        <div class="brand">C O N T Y N T</div>
        <div class="lead">A creator filmed here.</div>
        <img class="qr" src="${qr}" alt="">
        <div class="code">${esc(code)}</div>
        <div class="sub">Scan the code, or go to<br>${esc(cardUrlFor(code))}</div>
      </div>
    </div>`;

  return `<!doctype html><html><head><meta charset="utf-8"><title>CONTYNT cards</title>
<meta name="robots" content="noindex,nofollow">
<style>
  /* Margin keeps the outer cut lines inside every printer's imageable area;
     letter is 8.5x11in, so 4 cards of 4in x 5in leave room for the guides. */
  @page { size: letter; margin: 10mm; }
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{background:#fff}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;color:#0a0a0a}

  .sheet{position:relative;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;
         width:190mm;height:240mm;margin:0 auto}
  .card{position:relative;page-break-inside:avoid;break-inside:avoid}
  .inner{position:absolute;inset:5mm;border:1pt solid #d4d4d4;border-radius:4mm;
         display:flex;flex-direction:column;align-items:center;justify-content:center;
         text-align:center;padding:6mm}
  .brand{font-size:9pt;font-weight:700;letter-spacing:.34em;color:#111}
  .lead{font-size:10pt;color:#525252;margin-top:2mm}
  .qr{width:46mm;height:46mm;margin:5mm 0 4mm;display:block}
  /* The code is the fallback when a camera will not focus, so it is set large
     and monospaced with wide tracking to survive being read across a counter. */
  .code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:26pt;font-weight:700;
        letter-spacing:.18em;color:#0a0a0a;line-height:1}
  .sub{font-size:7.5pt;color:#737373;margin-top:3mm;line-height:1.5}

  /* Perforation guides: dashed lines down the middle of the sheet in both
     directions, with a scissors at each midpoint so the cut is obvious. */
  .perf{position:absolute;background:none;color:#a3a3a3;pointer-events:none}
  .perf.v{left:50%;top:0;bottom:0;border-left:1pt dashed #bdbdbd;transform:translateX(-.5pt)}
  .perf.h{top:50%;left:0;right:0;border-top:1pt dashed #bdbdbd;transform:translateY(-.5pt)}
  .scissors{position:absolute;font-size:10pt;line-height:1;color:#9ca3af;background:#fff;padding:1mm}
  .scissors.top{left:50%;top:-1mm;transform:translateX(-50%)}
  .scissors.bottom{left:50%;bottom:-1mm;transform:translateX(-50%)}
  .scissors.left{top:50%;left:-1mm;transform:translateY(-50%)}
  .scissors.right{top:50%;right:-1mm;transform:translateY(-50%)}

  @media print{
    /* Keep the guide lines and any fill exactly as designed rather than letting
       the browser drop "background" ink to save toner. */
    html,body{-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .noprint{display:none !important}
  }
  .noprint{max-width:190mm;margin:6mm auto 0;font-size:11px;color:#737373;text-align:center}
</style></head><body>
  <div class="sheet">
    ${card}${card}${card}${card}
    <div class="perf v"><span class="scissors top">&#9986;</span><span class="scissors bottom">&#9986;</span></div>
    <div class="perf h"><span class="scissors left">&#9986;</span><span class="scissors right">&#9986;</span></div>
  </div>
  <p class="noprint">Print this page, then cut along the dashed lines. Every card carries the same code, so any one of them works at any business.</p>
</body></html>`;
}


// The printable sheet and the on-screen QR are rendered by the site, not here.
// Supabase rewrites any HTML an Edge Function returns to text/plain with
// `content-security-policy: default-src 'none'; sandbox`, so a page served from
// this origin opens as source text in a browser. Anything a person is meant to
// look at lives in the SPA: /app?view=cards and /app?view=qr, which read the
// code from the JSON route below.

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
      cards: (rows ?? []).map((r: any) => ({
        id: r.id, featureId: r.feature_id, code: r.code,
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

// There is no name column on creator_signups, so the handle is the only thing
// resembling a first name we have. Better than an empty greeting, and the
// template degrades to "there" when even that is missing.
const firstNameFor = (r: any) =>
  (r.instagram_handle || (r.instagram || "").replace(/^@+/, "").split(/[._]/)[0] || "there");

function renderVerificationEmail(row: any, link: string) {
  const first = firstNameFor(row);
  const text =
`Hi ${first},

The first wave of features in San Francisco is dropping soon. You are on the early access list, so you get first look before they open up to everyone.

Confirm your profile now and we will match you to the ones in your area the moment they go live:
${prettyLink(link)}

This link is good for 90 days and is just for you. Please do not forward it.

CONTYNT
San Francisco`;
  const html = emailShell({
    preheader: "The first wave of features in San Francisco is dropping soon. Early access gets first look.",
    footerNote: "You are receiving this because you signed up for Contynt early access.",
    body:
`      <p style="margin:0 0 16px 0;font-size:21px;line-height:1.35;font-weight:700;color:#0a0a0a;">The first wave of features is dropping soon</p>
      <p style="margin:0 0 14px 0;">Hi ${esc(first)},</p>
      <p style="margin:0 0 14px 0;">The first wave of features in San Francisco is dropping soon. You are on the early access list, so you get first look before they open up to everyone.</p>
      <p style="margin:0;">Confirm your profile now and we will match you to the ones in your area the moment they go live.</p>
${emailButton(link, "Confirm your profile")}
      <p style="margin:0 0 6px 0;font-size:13px;color:#8a8a8a;">Or paste this into your browser:</p>
      <p style="margin:0 0 18px 0;font-size:13px;word-break:break-all;"><a href="${esc(link)}" style="color:#525252;">${esc(prettyLink(link))}</a></p>
      <p style="margin:0;font-size:13px;color:#8a8a8a;">This link is good for 90 days and is just for you. Please do not forward it.</p>`,
  });
  return { text, html, subject: "Confirm your Contynt profile" };
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
function renderFeatureDropEmail(row: any, link: string, count: number, cities: string[]) {
  const first = firstNameFor(row);
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
San Francisco`;

  const html = emailShell({
    preheader: count > 0
      ? `${count} ${plural} ${isAre} open in your portal right now.`
      : `New features just landed in ${where}.`,
    footerNote: "You are receiving this because you asked to hear about features by email.",
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
function renderSelectedEmail(row: any, feature: any, link: string, hoursToAccept: number) {
  const first = firstNameFor(row);
  const where = [feature?.business_name, cityLabel(feature?.city)].filter(Boolean).join(", ");
  const text =
`Hi ${first},

You have been selected for the feature at ${where}.

Accept it within ${hoursToAccept} hours and it is yours to film.

Leave it and it goes back to everyone else.

Accept it here:
${prettyLink(link)}

CONTYNT
San Francisco`;
  const html = emailShell({
    preheader: `Accept within ${hoursToAccept} hours to keep it.`,
    body:
`      <p style="margin:0 0 16px 0;font-size:21px;line-height:1.35;font-weight:700;color:#0a0a0a;">You have been selected</p>
      <p style="margin:0 0 14px 0;">Hi ${esc(first)},</p>
      <p style="margin:0 0 14px 0;">You have been selected for the feature at <strong>${esc(where)}</strong>.</p>
      <p style="margin:0 0 14px 0;">Accept it within ${hoursToAccept} hours and it is yours to film.</p>
      <p style="margin:0;">Leave it and it goes back to everyone else.</p>
${emailButton(link, "Accept the feature")}
      <p style="margin:0 0 6px 0;font-size:13px;color:#8a8a8a;">Or paste this into your browser:</p>
      <p style="margin:0;font-size:13px;word-break:break-all;"><a href="${esc(link)}" style="color:#525252;">${esc(prettyLink(link))}</a></p>`,
  });
  return { text, html, subject: `You have been selected: ${where}` };
}

// One template for both deadlines. What changes is what runs out and what the
// creator has to do about it, so those are the arguments.
function renderClaimExpiryEmail(row: any, feature: any, link: string, opts: {
  hoursLeft: number; kind: "accept" | "submit";
}) {
  const first = firstNameFor(row);
  const where = [feature?.business_name, cityLabel(feature?.city)].filter(Boolean).join(", ");
  const hrs = opts.hoursLeft === 1 ? "1 hour" : `${opts.hoursLeft} hours`;
  // The verb and its preposition travel together, or the sentence reads
  // "accept it for Poop Cafe".
  const what = opts.kind === "accept"
    ? { head: "Your feature is about to expire", act: "accept the feature", prep: "at",
        lost: "it goes back to everyone else", cta: "Accept the feature" }
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
async function mailClaimCreator(opts: {
  creatorToken: string; featureId: string;
  build: (creator: any, feature: any, link: string) => { subject: string; html: string; text: string };
}): Promise<{ ok: true; messageId: string | null } | { ok: false; reason: string }> {
  const session = await creatorFromToken(opts.creatorToken);
  if (!session?.creatorId) return { ok: false, reason: "no creator for that token" };

  const [{ data: creator }, { data: feature }] = await Promise.all([
    db().from("creator_signups_f5961d0c").select("*").eq("id", session.creatorId).maybeSingle(),
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

async function postmarkSend(opts: { to: string; subject: string; html: string; text: string; stream: string }) {
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

    await must("send: issue token", supabase.from("creator_signups_f5961d0c").update({
      verify_token: token,
      verify_token_expires_at: new Date(Date.now() + VERIFY_DAYS * 864e5).toISOString(),
    }).eq("id", r.id));

    if (!POSTMARK_SERVER_TOKEN) {
      results.push({ id: r.id, email, link, skipped: "POSTMARK_SERVER_TOKEN not set" });
      continue;
    }

    try {
      const sent = await postmarkSend({ to: email, ...rendered, stream: POSTMARK_STREAM });
      const payload = sent.payload;
      if (!sent.ok) { results.push({ id: r.id, email, error: sent.error }); continue; }

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
    const rendered = renderFeatureDropEmail(r, link, count, cities);

    if (opts.dryRun) {
      results.push({ id: r.id, email, link, subject: rendered.subject, dryRun: true });
      continue;
    }
    if (!POSTMARK_SERVER_TOKEN) {
      results.push({ id: r.id, email, link, skipped: "POSTMARK_SERVER_TOKEN not set" });
      continue;
    }

    try {
      const sent = await postmarkSend({ to: email, ...rendered, stream: POSTMARK_STREAM });
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
    const rendered = renderFeatureDropEmail({ instagram_handle: "there" }, `${SITE_ORIGIN}/app`, count, cities);
    const sent = await postmarkSend({ to, ...rendered, stream: POSTMARK_STREAM });
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

// ─── Health ───────────────────────────────────────────────────────────────────
app.get("/make-server-f5961d0c/health", (c) => c.json({ status: "ok" }));

// ─── Creator signup ───────────────────────────────────────────────────────────
app.post("/make-server-f5961d0c/signup", async (c) => {
  try {
    const { instagram, email, city } = await c.req.json();
    if (!city) return c.json({ error: "City is required" }, 400);
    const { data, error } = await db().from("creator_signups_f5961d0c").insert({ instagram: instagram || "", email: email || "", city }).select("id").single();
    if (error) throw error;
    return c.json({ success: true, message: "Successfully signed up for early access!", id: data.id });
  } catch (e: any) { return c.json({ error: "Failed to process signup.", details: e.message }, 500); }
});

// ─── Business signup ──────────────────────────────────────────────────────────
// The form no longer asks for a business name: the Instagram handle is the one
// identifier a business always has and the one already shown beside every row in
// the Businesses tab. A handle that is already there attaches to that business
// rather than minting a twin, so signing up twice updates the details on file
// instead of splitting a business across two rows -- which would split its
// Features, its quota and its portal with it.
app.post("/make-server-f5961d0c/business-signup", async (c) => {
  try {
    const { businessName, instagram, email, city, address, preferredContact } = await c.req.json();
    const handle = normalizeHandle(instagram);
    if (!handle) return c.json({ error: "Enter a valid Instagram handle." }, 400);
    if (!email || !city) return c.json({ error: "Email and city are required." }, 400);

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
      if (address) patch.address = address;
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
      email, city, address: address || "", preferred_contact: preferredContact || "",
    }).select("id").single();
    if (error) throw error;
    return c.json({ success: true, message: "Thank you! We'll be in touch.", id: data.id, matched: false });
  } catch (e: any) { return c.json({ error: "Failed to process signup.", details: e.message }, 500); }
});

// ─── Page view ────────────────────────────────────────────────────────────────
app.post("/make-server-f5961d0c/analytics/pageview", async (c) => {
  try {
    const { visitorId, userAgent, referrer } = await c.req.json();
    const country = c.req.header("cf-ipcountry") || c.req.header("x-vercel-ip-country") || "";
    const city = c.req.header("cf-ipcity") || "";
    const { error } = await db().from("visitors_f5961d0c").insert({ visitor_id: visitorId, user_agent: userAgent || "", referrer: referrer || "", country: country || null, city: city || null });
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
    const { data, error } = await db().from("creator_signups_f5961d0c").select("id, instagram, email, city, created_at").order("created_at", { ascending: false });
    if (error) throw error;
    // Balances live against the portal token, so map creator id -> token first.
    const [balances, refs] = await Promise.all([allCreatorBalances(), kv.getByPrefix("ctokenref_")]);
    const tokenFor: Record<string, string> = {};
    for (const ref of refs) if (ref?.creatorId && ref?.token) tokenFor[ref.creatorId] = ref.token;
    const zero = { totalEarned: 0, pendingEarnings: 0, availableEarnings: 0 };
    return c.json({
      signups: (data ?? []).map((r: any) => ({
        id: r.id, instagram: r.instagram, email: r.email, city: r.city, createdAt: r.created_at,
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
      .select("id, business_name, instagram, email, city, address, preferred_contact, created_at, subscription_tier, feature_status, plan_clicks, referral_source, referral_code, referred_by_creator")
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
    const token = token32();
    const existing = await kv.get(`ctokenref_${creatorId}`);
    if (existing?.token) await kv.del(`ctoken_${existing.token}`);
    await kv.set(`ctoken_${token}`, { creatorId, instagram: creator.instagram, email: creator.email, city: creator.city, createdAt: new Date().toISOString() });
    await kv.set(`ctokenref_${creatorId}`, { token, creatorId, createdAt: new Date().toISOString() });
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
    const token = token32();
    const existing = await kv.get(`biztokenref_${businessId}`);
    if (existing?.token) await kv.del(`biztoken_${existing.token}`);
    await kv.set(`biztoken_${token}`, { businessId, businessName: biz.business_name, city: biz.city, createdAt: new Date().toISOString() });
    await kv.set(`biztokenref_${businessId}`, { token, businessId, createdAt: new Date().toISOString() });
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
    const token = token32();
    await kv.set("admin_private_token", { token, createdAt: new Date().toISOString() });
    return c.json({ success: true, token });
  } catch (e: any) { return c.json({ error: "Failed to generate admin link", details: e.message }, 500); }
});

app.get("/make-server-f5961d0c/admin/verify", async (c) => {
  try {
    const token = c.req.query("token");
    if (!token) return c.json({ valid: false }, 400);
    const stored = await kv.get("admin_private_token");
    return c.json({ valid: stored?.token === token });
  } catch (e: any) { return c.json({ valid: false }, 500); }
});

// ─── Admin: set subscription tier ────────────────────────────────────────────
app.post("/make-server-f5961d0c/admin/set-tier", async (c) => {
  try {
    const { businessId, tier } = await c.req.json();
    if (!businessId || !tier) return c.json({ error: "businessId and tier required" }, 400);
    await db().from("business_signups_f5961d0c").update({ subscription_tier: tier }).eq("id", businessId);
    return c.json({ success: true });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// ─── Admin: offer a feature to a business (Enable Feature / Free Feature) ────
app.post("/make-server-f5961d0c/admin/offer-feature", async (c) => {
  try {
    const { businessId, isTrial, isOneOff } = await c.req.json();
    if (!businessId) return c.json({ error: "businessId required" }, 400);
    const { data: biz, error } = await db().from("business_signups_f5961d0c").select("id, business_name, address, city, subscription_tier").eq("id", businessId).single();
    if (error || !biz) return c.json({ error: "Business not found" }, 404);
    const featureId = uid("feat_");
    await db().from("features_f5961d0c").insert({
      id: featureId, business_id: businessId, business_name: biz.business_name,
      address: biz.address || "", city: biz.city || "",
      status: "offered", is_trial: !!isTrial, is_one_off: !!isOneOff,
      offered_at: new Date().toISOString(),
      category: "", payout_range: "",
    });
    return c.json({ success: true, featureId });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// ─── Business portal: submit feature request (notes + decrement reels) ────────
app.post("/make-server-f5961d0c/business-portal/submit-feature", async (c) => {
  try {
    const { bizToken, featureId, requestNotes, isNewRequest } = await c.req.json();
    const bizData = await businessFromToken(bizToken);
    if (!bizData) return c.json({ error: "Invalid token" }, 401);
    const notes = requestNotes || "No specific requests, creator's choice";
    let resultFeatureId = featureId || "";
    if (isNewRequest || !featureId) {
      const bizInfoRes = await db().from("business_signups_f5961d0c").select("business_name, address, city").eq("id", bizData.businessId).single();
      const bizInfo2 = bizInfoRes.data as any;
      const newId = uid("feat_");
      resultFeatureId = newId;
      await db().from("features_f5961d0c").insert({
        id: newId, business_id: bizData.businessId, business_name: bizInfo2?.business_name || "",
        address: bizInfo2?.address || "", city: bizInfo2?.city || "",
        status: "pending", request_notes: notes, submitted_by_business: true,
        submitted_at_biz: new Date().toISOString(), offered_at: new Date().toISOString(),
        category: "", payout_range: "",
      });
    } else {
      await db().from("features_f5961d0c").update({
        status: "pending", request_notes: notes,
        submitted_by_business: true, submitted_at_biz: new Date().toISOString(),
      }).eq("id", featureId).eq("business_id", bizData.businessId);
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
      status: r.status || "", approvedAt: r.approved_at,
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
    }));
    return c.json({ claims });
  } catch (e: any) { return c.json({ error: "Failed to fetch claims", details: e.message }, 500); }
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
    const { submissionId, reelUrl } = await c.req.json();
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
    const url = c.req.query("url");
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
    // Store reset timestamp so the creator portal can clear localStorage
    await kv.set(`reset_${token}`, { resetAt: new Date().toISOString() });
    return c.json({ success: true });
  } catch (e: any) { return c.json({ error: "Failed to reset creator", details: e.message }, 500); }
});

// ─── Feature status list (service role key — other portals poll this) ────────
app.get("/make-server-f5961d0c/features-status", async (c) => {
  try {
    const { data } = await db().from("features_f5961d0c").select("id, status, winner_instagram, completed_at");
    return c.json({ features: data ?? [] });
  } catch { return c.json({ features: [] }); }
});

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
    const [featRes, claimsRes, statsRes] = await Promise.all([
      db().from("features_f5961d0c").select("*").order("approved_at", { ascending: false }),
      db().from("creator_claims_f5961d0c").select("*").eq("creator_token", token).neq("status", "unclaimed"),
      db().from("submissions_f5961d0c").select("id, feature_id, status").eq("token", token),
    ]);
    // Early-access gating. A creator who already claimed a Feature keeps seeing
    // it regardless, otherwise a gated Feature would vanish from under them.
    const confirmed = await creatorIsConfirmed(creatorData.creatorId);
    const claimedIds = new Set((claimsRes.data ?? []).map((cl: any) => cl.feature_id));
    const features = (featRes.data ?? [])
      .filter((r: any) => visibleToCreator(r, confirmed) || claimedIds.has(r.id))
      .map((r: any) => ({ id: r.id, businessId: r.business_id, businessName: r.business_name, address: r.address, city: r.city, category: r.category, payoutRange: r.payout_range, status: r.status, approvedAt: r.approved_at, winnerInstagram: r.winner_instagram || "", businessInstagram: r.business_instagram || "", adminNotes: r.admin_notes || "", earlyAccessUntil: r.early_access_until || null }));
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
      // The one ambassador code, so in-progress Features can offer Print and QR
      // without minting anything of their own. Null until they opt in.
      ambassadorCode: ambCode,
      cardUrl: ambCode ? cardUrlFor(ambCode) : null,
      // Comes from the session itself rather than a URL flag, so the read-only
      // banner cannot be dismissed by editing the address bar.
      impersonated: !!creatorData.impersonated,
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

// Creator accepts the feature → starts 7-day in-progress countdown
app.post("/make-server-f5961d0c/creator-portal/accept-feature", async (c) => {
  try {
    const { token: rawToken, featureId } = await c.req.json();
    if (!rawToken || !featureId) return c.json({ error: "token and featureId required" }, 400);
    const creatorData = await creatorFromToken(rawToken);
    if (!creatorData) return c.json({ error: "Invalid or expired link" }, 401);
    // Impersonation writes must land on the creator's own rows, not on the
    // short lived admin token, which expires in an hour and is in no index.
    const token = creatorData.realToken ?? rawToken;
    const now = new Date();
    // Creators get 5 days to film and submit once they accept a Feature.
    const CLAIM_DAYS = 5;
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
    return c.json({ success: true });
  } catch (e: any) { return c.json({ error: "Failed to unclaim", details: e.message }, 500); }
});

app.post("/make-server-f5961d0c/creator-portal/submit", async (c) => {
  try {
    const { token: rawToken, featureId, reelUrl, instagram, handedOff, handoffReason } = await c.req.json();
    if (!rawToken || !featureId || !reelUrl) return c.json({ error: "token, featureId, and reelUrl required" }, 400);
    const creatorData = await creatorFromToken(rawToken);
    if (!creatorData) return c.json({ error: "Invalid or expired link" }, 401);
    // Impersonation writes must land on the creator's own rows, not on the
    // short lived admin token, which expires in an hour and is in no index.
    const token = creatorData.realToken ?? rawToken;
    const creatorInstagram = creatorData.instagram || instagram || "";
    const creatorId = creatorData.creatorId || "";

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
      features: (featRes.data ?? [])
        .filter((r: any) => visibleToCreator(r, syncConfirmed) || syncClaimed.has(r.id))
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
    .select("feature_id, creator_token, status, acceptance_expires_at, expires_at, acceptance_reminded_at, expiry_reminded_at")
    .in("status", ["approved", "claimed"]);

  const results: any[] = [];
  for (const cl of (claims ?? [])) {
    // Which clock is running depends on where the claim is: an approved claim
    // is waiting to be accepted, a claimed one is waiting for a Reel.
    const kind: "accept" | "submit" = cl.status === "approved" ? "accept" : "submit";
    const dueAt = kind === "accept" ? cl.acceptance_expires_at : cl.expires_at;
    const alreadySent = kind === "accept" ? cl.acceptance_reminded_at : cl.expiry_reminded_at;
    if (!dueAt || alreadySent) continue;

    const msLeft = new Date(dueAt).getTime() - now;
    // Past the deadline there is nothing to save, and the sweep that reclaims
    // expired claims is a separate concern from telling anyone about it.
    if (msLeft <= 0 || msLeft > horizon) continue;
    const hoursLeft = Math.max(1, Math.ceil(msLeft / 3600e3));

    if (opts.dryRun) {
      results.push({ featureId: cl.feature_id, kind, hoursLeft, wouldSend: true });
      continue;
    }
    const out = await mailClaimCreator({
      creatorToken: cl.creator_token, featureId: cl.feature_id,
      build: (creator, feature, link) => renderClaimExpiryEmail(creator, feature, link, { hoursLeft, kind }),
    });
    if (!out.ok) { results.push({ featureId: cl.feature_id, kind, skipped: out.reason }); continue; }

    // Stamped only after Postmark accepted, so a failed send is retried by the
    // next sweep rather than silently counted as done.
    await db().from("creator_claims_f5961d0c")
      .update(kind === "accept"
        ? { acceptance_reminded_at: new Date().toISOString() }
        : { expiry_reminded_at: new Date().toISOString() })
      .eq("feature_id", cl.feature_id).eq("creator_token", cl.creator_token);
    results.push({ featureId: cl.feature_id, kind, hoursLeft, sent: true });
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
    const [ambRes, refRes, creatorRes, bizRes] = await Promise.all([
      db().from("ambassadors_f5961d0c").select("*").order("created_at", { ascending: false }),
      db().from("ambassador_referrals_f5961d0c").select("*").order("created_at", { ascending: false }),
      db().from("creator_signups_f5961d0c").select("id, instagram, email, city"),
      db().from("business_signups_f5961d0c")
        .select("id, business_name, email, referred_by_creator, referral_code, referral_source, created_at")
        .not("referred_by_creator", "is", null),
    ]);
    const ambassadors = ambRes.data ?? [];
    const stored = refRes.data ?? [];

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
        conversionRate: mine.length ? Math.round((converted / mine.length) * 100) : 0,
        rewardsEarned: mine.filter((r: any) => r.reward_status === "paid").reduce((s: number, r: any) => s + parseAmount(r.reward_amount), 0),
      };
    });

    return c.json({
      overview: {
        totalAmbassadors: ambassadors.length,
        activeAmbassadors: ambassadors.filter((a: any) => a.enabled_status).length,
        totalReferrals: referrals.length,
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
    const token = amb?.creator_token;
    if (!token) return c.json({ error: "Ambassador has no active creator link" }, 400);

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
    const { data: sub } = await db().from("submissions_f5961d0c").select("feature_id").eq("id", submissionId).single();
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

// ─── Creator portal: request payout ──────────────────────────────────────────
app.post("/make-server-f5961d0c/creator-portal/payout", async (c) => {
  try {
    const { token: rawToken, submissionId, featureId, payoutRange } = await c.req.json();
    if (!rawToken || !submissionId) return c.json({ error: "token and submissionId required" }, 400);
    const creatorData = await creatorFromToken(rawToken);
    if (!creatorData) return c.json({ error: "Invalid or expired link" }, 401);
    // Impersonation writes must land on the creator's own rows, not on the
    // short lived admin token, which expires in an hour and is in no index.
    const token = creatorData.realToken ?? rawToken;
    const { error } = await db().from("creator_payouts_f5961d0c").insert({ creator_token: token, submission_id: submissionId, feature_id: featureId, payout_range: payoutRange || "" });
    if (error) throw error;
    return c.json({ success: true });
  } catch (e: any) { return c.json({ error: "Failed to record payout", details: e.message }, 500); }
});

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
    const featRes = await db().from("features_f5961d0c").select("id, category, payout_range, status, approved_at, business_notes, is_trial, is_one_off, request_notes, submitted_by_business").eq("business_id", bizId).order("offered_at", { ascending: false });
    const featureIds: string[] = (featRes.data ?? []).map((f: any) => String(f.id));
    result.publishedFeatures = (featRes.data ?? []).map((f: any) => ({ id: f.id, category: f.category, payoutRange: f.payout_range, status: f.status, approvedAt: f.approved_at || null, businessNotes: f.business_notes || "", isTrial: f.is_trial || false, isOneOff: f.is_one_off || false, requestNotes: f.request_notes || "", submittedByBusiness: f.submitted_by_business || false }));
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
    // Read-then-write server-side so the client cannot set an arbitrary count.
    const { data: row } = await db().from("business_signups_f5961d0c").select("plan_clicks").eq("id", bizData.businessId).single();
    const next = ((row as any)?.plan_clicks || 0) + 1;
    await db().from("business_signups_f5961d0c").update({ plan_clicks: next }).eq("id", bizData.businessId);
    return c.json({ success: true, planClicks: next });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// ─── Business portal: submit feedback on a reel ──────────────────────────────
app.post("/make-server-f5961d0c/business-portal/feedback", async (c) => {
  try {
    const { bizToken, submissionId, reaction, note } = await c.req.json();
    if (!bizToken || !submissionId || !reaction) return c.json({ error: "bizToken, submissionId, and reaction required" }, 400);
    const bizData = await businessFromToken(bizToken);
    if (!bizData) return c.json({ error: "Invalid token" }, 401);

    // Save feedback
    await db().from("submissions_f5961d0c").update({
      business_approved: reaction === "approve",
      business_feedback: { reaction, note: note || "", submittedAt: new Date().toISOString(), businessName: bizData.businessName },
    }).eq("id", submissionId);

    // 👍 Approve triggers the full approval flow — updates creator portal too
    if (reaction === "approve") {
      const { data: sub } = await db().from("submissions_f5961d0c").select("*").eq("id", submissionId).single();
      if (sub && sub.status !== "approved") await markReelLive(sub);
    }

    return c.json({ success: true });
  } catch (e: any) { return c.json({ error: "Failed to submit feedback", details: e.message }, 500); }
});

Deno.serve(app.fetch);
