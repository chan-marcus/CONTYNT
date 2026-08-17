import { Hono } from "npm:hono@4";
import { cors } from "npm:hono@4/cors";
import { logger } from "npm:hono@4/logger";
import { createClient } from "jsr:@supabase/supabase-js@2.49.8";
import * as kv from "./kv_store.tsx";

const app = new Hono();
app.use("*", logger(console.log));
app.use("/*", cors({ origin: "*", allowHeaders: ["Content-Type", "Authorization", "x-admin-token"], allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"], exposeHeaders: ["Content-Length"], maxAge: 600 }));

const db = () => createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

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
async function creatorFromToken(token: string): Promise<any | null> {
  if (!token) return null;
  return await kv.get(`ctoken_${token}`).catch(() => null);
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
app.post("/make-server-f5961d0c/business-signup", async (c) => {
  try {
    const { businessName, instagram, email, city, address, preferredContact } = await c.req.json();
    if (!businessName || !instagram || !email || !city) return c.json({ error: "All fields are required" }, 400);
    const { data, error } = await db().from("business_signups_f5961d0c").insert({ business_name: businessName, instagram, email, city, address: address || "", preferred_contact: preferredContact || "" }).select("id").single();
    if (error) throw error;
    return c.json({ success: true, message: "Thank you! We'll be in touch.", id: data.id });
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
    return c.json({ signups: (data ?? []).map((r: any) => ({ id: r.id, instagram: r.instagram, email: r.email, city: r.city, createdAt: r.created_at })), total: data?.length ?? 0 });
  } catch (e: any) { return c.json({ error: "Failed to fetch signups", details: e.message }, 500); }
});

// ─── Get business signups ─────────────────────────────────────────────────────
app.get("/make-server-f5961d0c/business-signups", async (c) => {
  try {
    const { data, error } = await db().from("business_signups_f5961d0c").select("id, business_name, instagram, email, city, address, preferred_contact, created_at, subscription_tier, feature_status").order("created_at", { ascending: false });
    if (error) throw error;
    return c.json({ signups: (data ?? []).map((r: any) => ({ id: r.id, businessName: r.business_name, instagram: r.instagram, email: r.email, city: r.city, address: r.address, preferredContact: r.preferred_contact, createdAt: r.created_at, subscriptionTier: r.subscription_tier || null, featureStatus: r.feature_status || null })), total: data?.length ?? 0 });
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
    const { businessId, isTrial } = await c.req.json();
    if (!businessId) return c.json({ error: "businessId required" }, 400);
    const { data: biz, error } = await db().from("business_signups_f5961d0c").select("id, business_name, address, city, subscription_tier").eq("id", businessId).single();
    if (error || !biz) return c.json({ error: "Business not found" }, 404);
    const featureId = uid("feat_");
    await db().from("features_f5961d0c").insert({
      id: featureId, business_id: businessId, business_name: biz.business_name,
      address: biz.address || "", city: biz.city || "",
      status: "offered", is_trial: !!isTrial, offered_at: new Date().toISOString(),
      category: "", payout_range: "",
    });
    return c.json({ success: true, featureId });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// ─── Business portal: submit feature request (notes + decrement reels) ────────
app.post("/make-server-f5961d0c/business-portal/submit-feature", async (c) => {
  try {
    const { bizToken, featureId, requestNotes, isNewRequest } = await c.req.json();
    const bizData = await kv.get(`biztoken_${bizToken}`);
    if (!bizData) return c.json({ error: "Invalid token" }, 401);
    const now = new Date().toISOString().slice(0, 7); // YYYY-MM
    const notes = requestNotes || "No specific requests, creator's choice";
    if (isNewRequest || !featureId) {
      const bizInfoRes = await db().from("business_signups_f5961d0c").select("business_name, address, city").eq("id", bizData.businessId).single();
      const bizInfo2 = bizInfoRes.data as any;
      const newId = uid("feat_");
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
    const reelsRes = await db().from("business_signups_f5961d0c").select("reels_used_this_month, reels_reset_month").eq("id", bizData.businessId).single();
    const reelsBiz = reelsRes.data as any;
    const used = reelsBiz?.reels_reset_month === now ? (reelsBiz?.reels_used_this_month || 0) : 0;
    await db().from("business_signups_f5961d0c").update({ reels_used_this_month: used + 1, reels_reset_month: String(now) }).eq("id", bizData.businessId);
    return c.json({ success: true });
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

// ─── Admin: get all features ──────────────────────────────────────────────────
app.get("/make-server-f5961d0c/admin/features", async (c) => {
  try {
    const { data, error } = await db().from("features_f5961d0c").select("*").order("offered_at", { ascending: false });
    if (error) throw error;
    const features = (data ?? []).map((r: any) => ({ id: r.id, businessId: r.business_id, businessName: r.business_name, address: r.address, city: r.city, category: r.category, payoutRange: r.payout_range, status: r.status, approvedAt: r.approved_at, isTrial: r.is_trial || false, requestNotes: r.request_notes || "", submittedByBusiness: r.submitted_by_business || false }));
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
    // Read from KV (always works) — merge with SQL for approved/metrics data
    const kvSubs = await kv.getByPrefix("submission_");
    const { data: sqlSubs } = await db().from("submissions_f5961d0c").select("*").order("submitted_at", { ascending: false });

    // Build a map from SQL by id for merging
    const sqlMap: Record<string, any> = {};
    for (const r of (sqlSubs ?? [])) sqlMap[r.id] = r;

    // Merge: KV is source of truth, SQL fills in metrics/feedback/approval
    const merged = kvSubs.map((kv: any) => {
      const sql = sqlMap[kv.id];
      return {
        id: kv.id,
        featureId: kv.featureId,
        token: kv.token,
        creatorInstagram: kv.creatorInstagram || "",
        reelUrl: kv.reelUrl,
        status: sql?.status || kv.status,
        metrics: sql?.metrics || {},
        businessFeedback: sql?.business_feedback || null,
        reportNote: sql?.report_note || "",
        submittedAt: kv.submittedAt,
        approvedAt: sql?.approved_at || null,
      };
    });

    // Also include any SQL-only submissions (approved before KV migration)
    for (const r of (sqlSubs ?? [])) {
      if (!merged.find((m: any) => m.id === r.id)) {
        merged.push({ id: r.id, featureId: r.feature_id, token: r.token, creatorInstagram: r.creator_instagram, reelUrl: r.reel_url, status: r.status, metrics: r.metrics || {}, businessFeedback: r.business_feedback, reportNote: r.report_note, submittedAt: r.submitted_at, approvedAt: r.approved_at });
      }
    }

    merged.sort((a: any, b: any) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime());
    return c.json({ submissions: merged });
  } catch (e: any) { return c.json({ error: "Failed to fetch submissions", details: e.message }, 500); }
});

// ─── Admin: approve reel ──────────────────────────────────────────────────────
app.post("/make-server-f5961d0c/admin/approve-reel", async (c) => {
  try {
    const { submissionId } = await c.req.json();
    const { data: sub, error: subErr } = await db().from("submissions_f5961d0c").select("*").eq("id", submissionId).single();
    if (subErr || !sub) return c.json({ error: "Submission not found" }, 404);
    await db().from("submissions_f5961d0c").update({ status: "approved", approved_at: new Date().toISOString() }).eq("id", submissionId);
    await db().from("features_f5961d0c").update({ status: "completed", completed_at: new Date().toISOString(), winner_instagram: sub.creator_instagram || "" }).eq("id", sub.feature_id);
    await db().from("creator_claims_f5961d0c").update({ status: "approved" }).eq("feature_id", sub.feature_id).eq("creator_token", sub.token);
    // Also update KV so admin Feature Activity reflects approved state
    const kvKey = `creator_claim_${sub.token}_${sub.feature_id}`;
    const existing = await kv.get(kvKey);
    if (existing) await kv.set(kvKey, { ...existing, status: "approved" });
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
    const token = c.req.query("t");
    if (!token) return c.json({ error: "Token required" }, 400);
    const creatorData = await kv.get(`ctoken_${token}`);
    if (!creatorData) return c.json({ error: "Invalid or expired link" }, 401);
    await kv.set(`ctoken_${token}`, { ...creatorData, lastActive: new Date().toISOString() });
    const resetRecord = await kv.get(`reset_${token}`);
    const resetAt = resetRecord?.resetAt || null;
    // Get all real features
    const [featRes, claimsRes, statsRes] = await Promise.all([
      db().from("features_f5961d0c").select("*").order("approved_at", { ascending: false }),
      db().from("creator_claims_f5961d0c").select("*").eq("creator_token", token).neq("status", "unclaimed"),
      db().from("submissions_f5961d0c").select("id, feature_id, status").eq("token", token),
    ]);
    const features = (featRes.data ?? []).map((r: any) => ({ id: r.id, businessId: r.business_id, businessName: r.business_name, address: r.address, city: r.city, category: r.category, payoutRange: r.payout_range, status: r.status, approvedAt: r.approved_at, winnerInstagram: r.winner_instagram || "", businessInstagram: r.business_instagram || "", adminNotes: r.admin_notes || "" }));
    // SQL only — no KV merge needed
    const claimsMap: Record<string, any> = {};
    for (const cl of (claimsRes.data ?? [])) {
      if (cl.status === "unclaimed" || cl.status === "viewing") continue;
      claimsMap[cl.feature_id] = { featureId: cl.feature_id, status: cl.status, reelUrl: cl.reel_url, approvedAt: cl.approved_at || null, expiresAt: cl.expires_at || null, acceptanceExpiresAt: cl.acceptance_expires_at || null };
    }
    // Creator stats
    const completedCount = (statsRes.data ?? []).filter((s: any) => s.status === "approved").length;
    const activeClaimsCount = (claimsRes.data ?? []).filter((cl: any) => cl.status === "claimed" || cl.status === "submitted").length;
    const { data: payouts } = await db().from("creator_payouts_f5961d0c").select("payout_range").eq("creator_token", token);
    const totalPayout = (payouts ?? []).reduce((sum: number, p: any) => {
      const match = p.payout_range?.match(/\$(\d+)/);
      return sum + (match ? parseInt(match[1]) : 0);
    }, 0);
    return c.json({ creator: { instagram: creatorData.instagram, city: creatorData.city, email: creatorData.email || "" }, features, claims: claimsMap, stats: { completed: completedCount, activeClaims: activeClaimsCount, totalPayout }, resetAt });
  } catch (e: any) { return c.json({ error: "Failed to load portal", details: e.message }, 500); }
});

// Interested — marks creator as interested, SQL only
app.post("/make-server-f5961d0c/creator-portal/claim", async (c) => {
  try {
    const { token, featureId } = await c.req.json();
    if (!token || !featureId) return c.json({ error: "Token and featureId required" }, 400);
    const creatorData = await creatorFromToken(token);
    if (!creatorData) return c.json({ error: "Invalid or expired link" }, 401);
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
    const acceptanceExpiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
    const { error } = await db().from("creator_claims_f5961d0c").update({ status: "approved", approved_at: approvedAt, acceptance_expires_at: acceptanceExpiresAt }).eq("feature_id", featureId).eq("creator_token", creatorToken);
    if (error) throw error;
    return c.json({ success: true, approvedAt, acceptanceExpiresAt });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// Creator accepts the feature → starts 7-day in-progress countdown
app.post("/make-server-f5961d0c/creator-portal/accept-feature", async (c) => {
  try {
    const { token, featureId } = await c.req.json();
    if (!token || !featureId) return c.json({ error: "token and featureId required" }, 400);
    if (!(await creatorFromToken(token))) return c.json({ error: "Invalid or expired link" }, 401);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
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
    const { token, featureId } = await c.req.json();
    if (!token || !featureId) return c.json({ error: "Token and featureId required" }, 400);
    if (!(await creatorFromToken(token))) return c.json({ error: "Invalid or expired link" }, 401);
    await db().from("creator_claims_f5961d0c").update({ status: "unclaimed", unclaimed_at: new Date().toISOString() }).eq("creator_token", token).eq("feature_id", featureId);
    return c.json({ success: true });
  } catch (e: any) { return c.json({ error: "Failed to unclaim", details: e.message }, 500); }
});

app.post("/make-server-f5961d0c/creator-portal/submit", async (c) => {
  try {
    const { token, featureId, reelUrl, instagram } = await c.req.json();
    if (!token || !featureId || !reelUrl) return c.json({ error: "token, featureId, and reelUrl required" }, 400);
    const creatorData = await creatorFromToken(token);
    if (!creatorData) return c.json({ error: "Invalid or expired link" }, 401);
    const creatorInstagram = creatorData.instagram || instagram || "";
    const creatorId = creatorData.creatorId || "";
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
    const { token, featureId } = await c.req.json();
    if (!token || !featureId) return c.json({ ok: true });
    const creatorData = await creatorFromToken(token);
    if (!creatorData) return c.json({ error: "Invalid or expired link" }, 401);
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
    const token = c.req.query("t");
    if (!token) return c.json({ error: "Token required" }, 400);
    const creatorData = await kv.get(`ctoken_${token}`).catch(() => null);
    if (!creatorData) return c.json({ error: "Invalid or expired link" }, 401);

    const [claimsRes, subsRes, featRes] = await Promise.all([
      db().from("creator_claims_f5961d0c")
        .select("feature_id, status, approved_at, expires_at, acceptance_expires_at")
        .eq("creator_token", token),
      db().from("submissions_f5961d0c")
        .select("id, feature_id, reel_url, admin_payout_approved, stripe_link, payout_amount, denied, admin_report_note, cashed_out_at")
        .eq("token", token),
      db().from("features_f5961d0c")
        .select("id, business_id, business_name, address, city, category, payout_range, status, approved_at, winner_instagram, business_instagram, admin_notes"),
    ]);

    return c.json({
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
      features: (featRes.data ?? []).map((r: any) => ({
        id: r.id, businessId: r.business_id, businessName: r.business_name,
        address: r.address, city: r.city, category: r.category,
        payoutRange: r.payout_range, status: r.status, approvedAt: r.approved_at,
        winnerInstagram: r.winner_instagram || "", businessInstagram: r.business_instagram || "",
        adminNotes: r.admin_notes || "",
      })),
    });
  } catch (e: any) { return c.json({ error: "Failed to sync", details: e.message }, 500); }
});

// ─── Creator portal: cash out (record payment details) ───────────────────────
app.post("/make-server-f5961d0c/creator-portal/cash-out", async (c) => {
  try {
    const { token, featureId, paymentMethod, paymentInfo } = await c.req.json();
    if (!token || !featureId || !paymentMethod || !paymentInfo) {
      return c.json({ error: "token, featureId, paymentMethod, and paymentInfo required" }, 400);
    }
    const creatorData = await kv.get(`ctoken_${token}`).catch(() => null);
    if (!creatorData) return c.json({ error: "Invalid token" }, 401);
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
    const { token, featureId, payoutAmount, instagram } = await c.req.json();
    if (!token || !featureId) return c.json({ error: "token and featureId required" }, 400);
    const creatorData = await kv.get(`ctoken_${token}`).catch(() => null);
    if (!creatorData) return c.json({ error: "Invalid token" }, 401);
    const ig = creatorData.instagram || instagram || "";
    const now = new Date().toISOString();
    await db().from("submissions_f5961d0c")
      .update({ cashed_out_at: now })
      .eq("token", token).eq("feature_id", featureId);
    await db().from("features_f5961d0c").update({
      status: "completed", winner_instagram: ig,
      total_payout: payoutAmount || "", claimed_by: ig, claimed_at: now,
    }).eq("id", featureId);
    return c.json({ success: true });
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
    await db().from("submissions_f5961d0c")
      .update({ payout_amount: payoutAmount || "", admin_payout_approved: true })
      .eq("id", submissionId);
    await db().from("features_f5961d0c").update({
      status: "completed",
      winner_instagram: sub.creator_instagram || "",
      completed_at: new Date().toISOString(),
    }).eq("id", sub.feature_id);
    return c.json({ success: true });
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
      await db().from("features_f5961d0c").update({
        status: "available", winner_instagram: "", total_payout: "",
        claimed_by: "", claimed_at: null,
      }).eq("id", sub.feature_id);
    }
    return c.json({ success: true });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// ─── Creator portal: update email ────────────────────────────────────────────
app.post("/make-server-f5961d0c/creator-portal/update-email", async (c) => {
  try {
    const { token, email } = await c.req.json();
    if (!token || !email) return c.json({ error: "token and email required" }, 400);
    const creatorData = await kv.get(`ctoken_${token}`);
    if (!creatorData) return c.json({ error: "Invalid token" }, 401);
    await db().from("creator_signups_f5961d0c").update({ email }).eq("id", creatorData.creatorId);
    await kv.set(`ctoken_${token}`, { ...creatorData, email });
    return c.json({ success: true });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// ─── Creator portal: request payout ──────────────────────────────────────────
app.post("/make-server-f5961d0c/creator-portal/payout", async (c) => {
  try {
    const { token, submissionId, featureId, payoutRange } = await c.req.json();
    if (!token || !submissionId) return c.json({ error: "token and submissionId required" }, 400);
    if (!(await creatorFromToken(token))) return c.json({ error: "Invalid or expired link" }, 401);
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
  try { bizData = await kv.get(`biztoken_${token}`); } catch {}
  if (!bizData) return c.json({ error: "Invalid or expired link" }, 401);

  const result: any = { business: bizData, reels: [], requestingCreators: [], inProgressCreators: [], publishedFeatures: [] };

  try {
    const bizId = String(bizData.businessId || "");
    if (!bizId) return c.json(result);

    // Reels count
    const tierMap: Record<string, number> = { Starter: 1, Growth: 2, Pro: 4, Scale: 8 };
    const { data: bizInfo } = await db().from("business_signups_f5961d0c").select("subscription_tier, reels_used_this_month, reels_reset_month").eq("id", bizId).single();
    const tier = (bizInfo as any)?.subscription_tier || null;
    const tierLimit = tier ? (tierMap[tier] || 1) : 0;
    const currentMonth = new Date().toISOString().slice(0, 7);
    const reelsUsed = (bizInfo as any)?.reels_reset_month === currentMonth ? ((bizInfo as any)?.reels_used_this_month || 0) : 0;
    result.reelsLimit = tierLimit;
    result.reelsUsed = reelsUsed;
    result.subscriptionTier = tier;
    const featRes = await db().from("features_f5961d0c").select("id, category, payout_range, status, approved_at, business_notes, is_trial, request_notes, submitted_by_business").eq("business_id", bizId);
    const featureIds: string[] = (featRes.data ?? []).map((f: any) => String(f.id));
    result.publishedFeatures = (featRes.data ?? []).map((f: any) => ({ id: f.id, category: f.category, payoutRange: f.payout_range, status: f.status, approvedAt: f.approved_at || null, businessNotes: f.business_notes || "", isTrial: f.is_trial || false, requestNotes: f.request_notes || "", submittedByBusiness: f.submitted_by_business || false }));
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

// ─── Business portal: submit feedback on a reel ──────────────────────────────
app.post("/make-server-f5961d0c/business-portal/feedback", async (c) => {
  try {
    const { bizToken, submissionId, reaction, note } = await c.req.json();
    if (!bizToken || !submissionId || !reaction) return c.json({ error: "bizToken, submissionId, and reaction required" }, 400);
    const bizData = await kv.get(`biztoken_${bizToken}`);
    if (!bizData) return c.json({ error: "Invalid token" }, 401);

    // Save feedback
    await db().from("submissions_f5961d0c").update({
      business_feedback: { reaction, note: note || "", submittedAt: new Date().toISOString(), businessName: bizData.businessName },
    }).eq("id", submissionId);

    // 👍 Approve triggers the full approval flow — updates creator portal too
    if (reaction === "approve") {
      const { data: sub } = await db().from("submissions_f5961d0c").select("*").eq("id", submissionId).single();
      if (sub && sub.status !== "approved") {
        await db().from("submissions_f5961d0c").update({ status: "approved", approved_at: new Date().toISOString() }).eq("id", submissionId);
        await db().from("features_f5961d0c").update({ status: "completed", completed_at: new Date().toISOString(), winner_instagram: sub.creator_instagram || "" }).eq("id", sub.feature_id);
        await db().from("creator_claims_f5961d0c").update({ status: "approved" }).eq("feature_id", sub.feature_id).eq("creator_token", sub.token);
        const kvKey = `creator_claim_${sub.token}_${sub.feature_id}`;
        const existing = await kv.get(kvKey);
        if (existing) await kv.set(kvKey, { ...existing, status: "approved" });
      }
    }

    return c.json({ success: true });
  } catch (e: any) { return c.json({ error: "Failed to submit feedback", details: e.message }, 500); }
});

Deno.serve(app.fetch);
