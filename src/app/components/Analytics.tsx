import { useState, useEffect, useCallback } from "react";
import { CheckCircle, Copy, RefreshCw, ExternalLink, ThumbsUp, ThumbsDown, Link, ChevronDown, Award, Eye } from "lucide-react";
import { projectId, publicAnonKey } from "/utils/supabase/info";
import { AmbassadorAdmin, type AmbassadorAdminData } from "./AmbassadorAdmin";
import { CreatorReadiness, type ReadinessData, type EmailHealth } from "./CreatorReadiness";
import { countQuotaUsed, quotaLimit } from "../lib/featureQuota";

const BASE = `https://${projectId}.supabase.co/functions/v1/make-server-f5961d0c`;
const AUTH = { Authorization: `Bearer ${publicAnonKey}` };
// Admin session token from /admin/login (or an admin private link). Read per
// call so it picks up a fresh login without a reload.
const adminSession = () => sessionStorage.getItem("analytics_token") || "";

// Set by the component below. Sessions last 12 hours and nothing was watching
// them expire: isAuthenticated only ever asked whether a token exists, never
// whether it still works, so every guarded call 401'd into an `if (res.ok)`
// that quietly skipped its setState. The dashboard then showed empty tables
// beside a header still reporting counts, because /analytics/stats needs no
// token -- an empty table reads as "no data", which is a different and much
// worse thing than "signed out".
let onUnauthorized: (() => void) | null = null;

// The handshake routes answer 401 for a wrong password, which is not an expired
// session and must not bounce the operator out of a login they are mid-way
// through.
const HANDSHAKE = ["/admin/login", "/admin/verify"];

const apiFetch = async (path: string, opts?: RequestInit) => {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { ...AUTH, "Content-Type": "application/json", "x-admin-token": adminSession(), ...(opts?.headers ?? {}) },
  });
  if (res.status === 401 && !HANDSHAKE.some(h => path.startsWith(h))) onUnauthorized?.();
  return res;
};

type Tab = "creators" | "businesses" | "reels" | "pageviews" | "ambassadors" | "readiness" | "billing";

interface Signup { id: string; instagram: string; email: string; city: string; createdAt: string; totalEarned?: number; pendingEarnings?: number; availableEarnings?: number; }
interface BusinessSignup { id: string; businessName: string; instagram: string; email: string; city: string; address: string; preferredContact: string; createdAt: string; referralSource?: string | null; referralCode?: string | null; referredByHandle?: string | null; }
interface Submission { id: string; featureId: string; creatorInstagram: string; reelUrl: string; status: string; submittedAt: string; reportNote?: string; metrics?: any; businessFeedback?: { reaction: "approve" | "report"; note?: string; submittedAt: string; businessName?: string }; }
interface PageView { visitorId: string; referrer: string; timestamp: string; country?: string; city?: string; }
interface Feature { id: string; businessId: string; businessName: string; category: string; payoutRange: string; status: string; total_payout?: string; claimed_by?: string; winner_instagram?: string; claimed_at?: string; isTrial?: boolean; isOneOff?: boolean; requestNotes?: string; submittedByBusiness?: boolean; offeredAt?: string | null; approvedAt?: string | null; }
interface BusinessSignupExtended extends BusinessSignup { subscriptionTier?: string; subscriptionEndsAt?: string | null; }
interface Claim { featureId: string; creatorToken: string; creatorInstagram: string; status: string; claimedAt: string; reelUrl?: string; approvedAt?: string; expiresAt?: string; acceptanceExpiresAt?: string; lastViewed?: string; }

// Renders a subscription period end. Deliberately UTC: these timestamps sit on
// UTC midnight, and toLocaleDateString in any timezone behind Greenwich moves
// them to the previous day -- so a plan paid through the 23rd read as the 22nd
// on every screen in San Francisco.
const endsOn = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

// ─── Card wrappers for mobile-friendly layout ─────────────────────────────────
function igHandle(raw: string) {
  return raw ? `@${raw.replace(/^@+/, "")}` : "—";
}

function CreatorRow({ signup, token, onImpersonate, impersonating, claims, features, onMarkPaid, markingPaid }: {
  signup: Signup; token?: string; onImpersonate: () => void; impersonating: boolean;
  claims: Claim[]; features: Feature[];
  onMarkPaid: () => void; markingPaid: boolean;
}) {
  const money = (n?: number) => `$${(n ?? 0).toFixed(2).replace(/\.00$/, "")}`;
  const totalEarned = signup.totalEarned ?? 0;
  const owesMoney = totalEarned > 0;
  const [expanded, setExpanded] = useState(false);
  const activeClaims = claims.filter(c => c.status === "claimed");
  const submittedClaims = claims.filter(c => c.status === "submitted");
  const approvedClaims = claims.filter(c => c.status === "approved");
  const recentlyViewed = claims.filter(c => c.lastViewed && Date.now() - new Date(c.lastViewed).getTime() < 10 * 60 * 1000);
  const hasActive = activeClaims.length > 0;
  const showActivity = activeClaims.length > 0 || submittedClaims.length > 0 || approvedClaims.length > 0 || recentlyViewed.length > 0;

  const featureName = (featureId: string) =>
    features.find(f => f.id === featureId)?.businessName || "Unknown feature";

  return (
    <div className={`border rounded-xl overflow-hidden transition-all ${
      hasActive ? "bg-blue-500/5 border-blue-500/30" : "bg-white/5 border-white/10"
    }`}>
      <div className="px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-2">
        <div className="flex-1 min-w-0 flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4">
          <button onClick={() => setExpanded(v => !v)}
            className="flex items-center gap-2 shrink-0 text-left group">
            <a href={`https://instagram.com/${signup.instagram.replace(/^@+/,"")}`} target="_blank" rel="noopener noreferrer"
              className="font-semibold text-white group-hover:text-blue-300 transition-colors">{igHandle(signup.instagram)}</a>
            {hasActive && (
              <span className="flex items-center gap-1 text-xs text-blue-400 bg-blue-500/15 border border-blue-500/25 px-2 py-0.5 rounded-full">
                <span className="relative flex w-1.5 h-1.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                  <span className="relative inline-flex rounded-full w-1.5 h-1.5 bg-blue-400" />
                </span>
                In Progress
              </span>
            )}
            {showActivity && <ChevronDown className={`w-3 h-3 text-neutral-500 transition-transform ${expanded ? "rotate-180" : ""}`} />}
          </button>
          <p className="text-sm text-neutral-500 truncate">{signup.email || "—"}</p>
          <p className="text-xs text-neutral-500 shrink-0">{new Date(signup.createdAt).toLocaleDateString()}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {/* token presence is now just a signal that this creator has signed in
              at least once. Impersonation works either way. */}
          {token && (
            <span className="text-[10px] text-neutral-600 whitespace-nowrap" title="Has signed in">signed in</span>
          )}
          <button onClick={onImpersonate} disabled={impersonating}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-white/10 border border-white/15 text-neutral-200 text-xs rounded-lg hover:bg-white/15 hover:border-white/30 transition-all disabled:opacity-50 whitespace-nowrap">
            <Eye className="w-3 h-3" />{impersonating ? "Opening…" : "View as creator"}
          </button>
        </div>
      </div>

      {/* Earnings — total is what a Mark as Paid would settle */}
      <div className="px-4 pb-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 border-t border-white/10 pt-2.5">
        <span className="text-xs text-neutral-500">
          Total earned <span className={`font-semibold ${owesMoney ? "text-green-400" : "text-neutral-400"}`}>{money(totalEarned)}</span>
        </span>
        <span className="text-xs text-neutral-500">
          Pending <span className="font-semibold text-yellow-400">{money(signup.pendingEarnings)}</span>
        </span>
        <span className="text-xs text-neutral-500">
          Available <span className="font-semibold text-neutral-300">{money(signup.availableEarnings)}</span>
        </span>
        {owesMoney && (
          <button onClick={onMarkPaid} disabled={markingPaid}
            className="ml-auto px-3 py-1.5 text-xs bg-green-600 text-white rounded-lg hover:bg-green-500 transition-all disabled:opacity-50 whitespace-nowrap">
            {markingPaid ? "Marking…" : `Mark as Paid (${money(totalEarned)})`}
          </button>
        )}
      </div>

      {/* Feature Activity — active claims only */}
      {expanded && showActivity && (
        <div className="px-4 pb-3 border-t border-white/10">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-neutral-600 py-2">Feature Activity</p>
          <div className="flex flex-col gap-1.5">
            {activeClaims.map((c, i) => (
              <div key={i} className="flex items-center gap-2.5 bg-blue-500/10 border border-blue-500/20 rounded-lg px-3 py-2">
                <span className="relative flex w-2 h-2 shrink-0">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-60" />
                  <span className="relative inline-flex rounded-full w-2 h-2 bg-blue-400" />
                </span>
                <span className="text-xs text-blue-200 flex-1">In Progress — <span className="font-semibold">{featureName(c.featureId)}</span></span>
              </div>
            ))}
            {submittedClaims.map((c, i) => (
              <div key={i} className="flex items-center gap-2.5 bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-3 py-2">
                <span className="w-2 h-2 rounded-full bg-yellow-400 shrink-0" />
                <span className="text-xs text-yellow-200 flex-1">Reel submitted — <span className="font-semibold">{featureName(c.featureId)}</span></span>
              </div>
            ))}
            {approvedClaims.map((c, i) => (
              <div key={i} className="flex items-center gap-2.5 bg-green-500/10 border border-green-500/20 rounded-lg px-3 py-2">
                <span className="w-2 h-2 rounded-full bg-green-400 shrink-0" />
                <span className="text-xs text-green-200 flex-1">Approved — <span className="font-semibold">{featureName(c.featureId)}</span></span>
              </div>
            ))}
            {recentlyViewed.filter(c => !activeClaims.find(a => a.featureId === c.featureId)).map((c, i) => (
              <div key={i} className="flex items-center gap-2.5 bg-white/5 border border-white/10 rounded-lg px-3 py-2">
                <span className="relative flex w-2 h-2 shrink-0">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-neutral-400 opacity-40" />
                  <span className="relative inline-flex rounded-full w-2 h-2 bg-neutral-400" />
                </span>
                <span className="text-xs text-neutral-400 flex-1">
                  Viewed <span className="font-semibold text-neutral-300">{featureName(c.featureId)}</span>
                </span>
                <span className="text-[10px] text-neutral-600 shrink-0">
                  {c.lastViewed ? new Date(c.lastViewed).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const ts = (d?: string) => d ? new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";

function FeatureClaimRow({ claim, featureId, onApprove, onReset }: any) {
  const [approving, setApproving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const isExpired = (claim.expiresAt && new Date(claim.expiresAt).getTime() < Date.now()) ||
    (claim.acceptanceExpiresAt && new Date(claim.acceptanceExpiresAt).getTime() < Date.now() && claim.status === "approved");
  const isViewing = claim.lastViewed && Date.now() - new Date(claim.lastViewed).getTime() < 5 * 60 * 1000;
  const status = claim.status;

  const statusConfig: Record<string, { label: string; color: string; bg: string; border: string; dot?: string }> = {
    interested:  { label: "Requested",   color: "text-neutral-300", bg: "bg-white/5",          border: "border-white/10",        dot: "bg-neutral-400" },
    approved:    { label: "Approved",    color: "text-green-300",   bg: "bg-green-500/10",     border: "border-green-500/20",    dot: "bg-green-400" },
    claimed:     { label: "In Progress", color: "text-blue-300",    bg: "bg-blue-500/10",      border: "border-blue-500/20",     dot: "bg-blue-400" },
    submitted:   { label: "Submitted",   color: "text-yellow-300",  bg: "bg-yellow-500/10",    border: "border-yellow-500/20",   dot: "bg-yellow-400" },
    unclaimed:   { label: "Withdrew",    color: "text-neutral-500", bg: "bg-white/3",          border: "border-white/5" },
  };
  const cfg = statusConfig[status] || statusConfig.interested;
  const isExpiredDisplay = isExpired && status === "claimed";

  // Timestamps for each action
  const events = [
    claim.claimedAt   && { label: "Requested",    time: claim.claimedAt },
    claim.approvedAt  && status !== "interested" && { label: "Approved",     time: claim.approvedAt },
    status === "submitted" && { label: "Submitted", time: claim.claimedAt },
    status === "unclaimed" && { label: "Withdrew",  time: claim.claimedAt },
  ].filter(Boolean) as { label: string; time: string }[];

  return (
    <div className={`rounded px-3 py-2 border space-y-1.5 ${isExpiredDisplay ? "bg-red-500/10 border-red-500/20" : cfg.bg} border-${cfg.border.replace("border-","")}`}
      style={{ borderColor: isExpiredDisplay ? undefined : undefined }}>
      <div className={`rounded px-2 py-1.5 border ${isExpiredDisplay ? "bg-red-500/10 border-red-500/20" : cfg.bg} ${cfg.border}`}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            {cfg.dot && (
              <span className="relative flex w-2 h-2 shrink-0">
                {(status === "claimed" || isViewing) && <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${cfg.dot} opacity-60`} />}
                <span className={`relative inline-flex rounded-full w-2 h-2 ${isExpiredDisplay ? "bg-red-400" : cfg.dot}`} />
              </span>
            )}
            <span className={isExpiredDisplay ? "text-red-400" : cfg.color}>{igHandle(claim.creatorInstagram)}</span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${isExpiredDisplay ? "bg-red-500/15 text-red-400 border-red-500/25" : "bg-white/10 border-white/10 text-neutral-400"}`}>
              {isExpiredDisplay ? "Expired" : cfg.label}
            </span>
            {isViewing && status === "interested" && (
              <span className="text-[10px] text-yellow-500">· viewing now</span>
            )}
          </div>
          <div className="flex gap-1.5 shrink-0">
            {status === "interested" && (
              <button onClick={async () => { setApproving(true); await onApprove(featureId, claim.creatorToken); setApproving(false); }} disabled={approving}
                className="px-2 py-0.5 bg-green-600 text-white rounded hover:bg-green-500 transition-all disabled:opacity-50 text-[10px] font-medium">
                {approving ? "…" : "Approve"}
              </button>
            )}
            {(isExpiredDisplay || status === "claimed" || status === "approved") && (
              <button onClick={async () => { setResetting(true); await onReset(featureId, claim.creatorToken); setResetting(false); }} disabled={resetting}
                className="px-2 py-0.5 bg-white/10 text-neutral-400 rounded hover:bg-white/15 transition-all text-[10px]">
                {resetting ? "…" : isExpiredDisplay ? "Reset" : "Remove"}
              </button>
            )}
          </div>
        </div>
        {/* Timestamps */}
        {events.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
            {events.map((e, i) => (
              <span key={i} className="text-[10px] text-neutral-600">{e.label}: {ts(e.time)}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const TIER_LIMITS: Record<string, number> = { Starter: 1, Growth: 2, Pro: 4, Scale: 8 };
const TIERS = ["Starter", "Growth", "Pro", "Scale"];

function AdminNoteInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1.5">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-blue-400">Notes for Creator</p>
      <input value={value} onChange={e => onChange(e.target.value)}
        placeholder="Instructions visible to creator when in progress…"
        className="w-full px-2 py-1.5 text-xs bg-neutral-800 border border-blue-500/20 rounded-lg text-white placeholder:text-neutral-600 focus:outline-none focus:border-blue-500/40" />
    </div>
  );
}

function InlineFeatureEdit({ featureId, category, payoutRange, onSaved }: { featureId: string; category: string; payoutRange: string; onSaved: (cat: string, pay: string) => void }) {
  const [editing, setEditing] = useState(!category && !payoutRange);
  const [cat, setCat] = useState(category || "");
  const [pay, setPay] = useState(payoutRange || "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const save = async () => {
    setSaving(true);
    await apiFetch("/admin/update-feature", {
      method: "POST", body: JSON.stringify({ featureId, category: cat, payoutRange: pay }),
    }).catch(() => {});
    onSaved(cat, pay);
    setSaving(false);
    setSaved(true);
    setEditing(false);
    setTimeout(() => setSaved(false), 2000);
  };

  if (!editing) return (
    <button onClick={() => setEditing(true)} className="flex items-center gap-2 min-w-0 text-left group">
      <span className="text-xs text-neutral-300 truncate">{cat || <span className="text-neutral-600 italic">No category</span>}</span>
      {pay && <span className="text-xs font-medium text-green-400">{pay}</span>}
      {saved ? <span className="text-[10px] text-green-400">✓ Saved</span> : <span className="text-[10px] text-neutral-600 group-hover:text-neutral-400">edit</span>}
    </button>
  );

  return (
    <div className="flex gap-1.5 flex-1">
      <input value={cat} onChange={e => setCat(e.target.value)} placeholder="Category"
        className="flex-1 min-w-0 px-2 py-1 text-xs bg-neutral-800 border border-white/15 rounded text-white placeholder:text-neutral-600 focus:outline-none" />
      <input value={pay} onChange={e => setPay(e.target.value)} placeholder="Payout"
        className="w-24 px-2 py-1 text-xs bg-neutral-800 border border-white/15 rounded text-white placeholder:text-neutral-600 focus:outline-none" />
      <button onClick={save} disabled={saving}
        className="px-2 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-500 disabled:opacity-50 shrink-0">
        {saving ? "…" : "Save"}
      </button>
    </div>
  );
}

function BusinessCard({ signup, approved, onApprove, onImpersonate, impersonating, payoutRange, setPayoutRange, category, setCategory, approving, bizFeatures, allClaims, onApproveCreatorClaim, onResetCreatorClaim, onFeatureOffered, onRemoveFeature, planClicks = 0 }: any) {
  const [showAddAnother, setShowAddAnother] = useState(false);
  const [addCategory, setAddCategory] = useState("");
  const [addPayout, setAddPayout] = useState("");
  const [pendingCats, setPendingCats] = useState<Record<string, string>>({});
  const [pendingPayouts, setPendingPayouts] = useState<Record<string, string>>({});
  const [pendingNotes, setPendingNotes] = useState<Record<string, string>>({});
  const [tier, setTierLocal] = useState(signup.subscriptionTier || "");
  // Which offer is in flight, so only the clicked button shows "Sending…".
  const [offering, setOffering] = useState<null | "trial" | "oneoff">(null);

  const tierLimit = TIER_LIMITS[tier] || 0;
  // Both scoped to the current month by lib/featureQuota, so this card and the
  // business's own portal report the same allowance.
  const totalReels = quotaLimit(tierLimit, bizFeatures || []);
  const reelsUsed = countQuotaUsed(bizFeatures || []);

  const offerFeature = async (kind: "trial" | "oneoff") => {
    setOffering(kind);
    const now = new Date().toISOString();
    // The server builds the row from the business record and returns the id.
    const res = await apiFetch("/admin/offer-feature", {
      method: "POST", body: JSON.stringify({ businessId: signup.id, isTrial: kind === "trial", isOneOff: kind === "oneoff" }),
    }).catch(() => null);
    const newId = (await res?.json().catch(() => null))?.featureId || "";
    if (newId) {
      onFeatureOffered?.({ id: newId, businessId: signup.id, businessName: signup.businessName || "", category: "", payoutRange: "", status: "offered", isTrial: kind === "trial", isOneOff: kind === "oneoff", offeredAt: now });
    }
    setOffering(null);
  };

  const saveTier = async (newTier: string) => {
    setTierLocal(newTier);
    await apiFetch("/admin/set-tier", {
      method: "POST", body: JSON.stringify({ businessId: signup.id, tier: newTier }),
    }).catch(() => {});
  };

  return (
    <div className={`bg-neutral-900 border rounded-xl p-4 space-y-3 ${approved ? "border-green-500/20 bg-green-500/10" : "border-white/10"}`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          {/* Signups no longer carry a business name, so the handle stands in.
              Rows from before that still show whatever name they were given. */}
          <p className="font-semibold text-white">{signup.businessName || igHandle(signup.instagram)}</p>
          <p className="text-xs text-neutral-500">{new Date(signup.createdAt).toLocaleDateString()}</p>
        </div>
        {approved && <span className="text-xs bg-green-500/10 text-green-400 border border-green-500/20 px-2 py-0.5 rounded-full shrink-0">Approved</span>}
      </div>
      <div className="text-sm text-neutral-300 space-y-0.5">
        <p>{signup.address || "—"}</p>
        <p>{signup.city}</p>
        <p>{signup.email}</p>
        <a href={`https://instagram.com/${signup.instagram.replace(/^@/, "")}`} target="_blank" rel="noopener noreferrer"
          className="text-blue-400 hover:text-blue-300 transition-colors">{igHandle(signup.instagram)}</a>
        {/* Who brought them in. Only shown when there is an attribution, so a
            business that walked in on its own does not carry an empty row --
            and a referral whose creator record has gone still says so rather
            than silently reading as unreferred. */}
        {/* A cancelled plan still runs to the end of the period it paid for, so
            the tier alone does not say a business is leaving. */}
        {signup.subscriptionEndsAt && (
          <p className="text-xs text-yellow-300">
            Cancels {endsOn(signup.subscriptionEndsAt)} — plan runs until then
          </p>
        )}
        {(signup.referralSource || signup.referredByHandle) && (
          <p className="text-xs text-purple-300 flex items-center gap-1.5">
            <Award className="w-3 h-3 shrink-0" />
            {signup.referredByHandle
              ? <>Referred by {igHandle(signup.referredByHandle)}</>
              : <>Referred by an Ambassador{signup.referralCode ? ` \u00b7 ${signup.referralCode}` : ""}</>}
          </p>
        )}
        {signup.preferredContact && (
          <p className="text-xs">
            <span className="text-neutral-500">Preferred contact: </span>
            <span className="font-medium text-neutral-300">{signup.preferredContact}</span>
          </p>
        )}
        {planClicks > 0 && (
          <p className="text-xs flex items-center gap-1.5">
            <span className="text-neutral-500">Viewed pricing:</span>
            <span className="font-semibold text-blue-300 bg-blue-500/10 border border-blue-500/20 px-1.5 py-0.5 rounded-full">{planClicks}×</span>
          </p>
        )}
      </div>

      {/* Tier + reels counter */}
      <div className="flex items-center gap-2 pt-1 border-t border-white/10">
        <select value={tier} onChange={e => saveTier(e.target.value)}
          className="flex-1 px-2 py-1.5 text-xs bg-neutral-800 border border-white/15 rounded-lg text-white focus:outline-none">
          <option value="">No tier</option>
          {TIERS.map(t => <option key={t} value={t}>{t} ({TIER_LIMITS[t]} Reel{TIER_LIMITS[t] !== 1 ? "s" : ""}/mo)</option>)}
        </select>
        {tier && (
          <span className={`text-xs px-2 py-1 rounded-lg border shrink-0 ${reelsUsed >= totalReels ? "bg-red-500/10 text-red-400 border-red-500/20" : "bg-white/5 text-neutral-400 border-white/10"}`}>
            {reelsUsed} of {totalReels} used
          </span>
        )}
      </div>


      {/* Pending features (submitted by business — awaiting admin to set category/payout) */}
      {(bizFeatures || []).filter((f: any) => f.status === "pending" && f.submittedByBusiness).length > 0 && (
        <div className="border-t border-white/10 pt-2 space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-yellow-500">Pending — Business Submitted</p>
          {(bizFeatures || []).filter((f: any) => f.status === "pending" && f.submittedByBusiness).map((f: any) => (
            <div key={f.id} className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-3 space-y-2">
              {f.isTrial && <span className="text-[10px] bg-green-500/15 text-green-400 border border-green-500/25 px-1.5 py-0.5 rounded font-medium">🎁 Free</span>}
              {f.requestNotes && <p className="text-xs text-neutral-300 italic">"{f.requestNotes}"</p>}
              <AdminNoteInput value={pendingNotes[f.id] ?? ((f as any).admin_notes || "")} onChange={v => setPendingNotes(p => ({ ...p, [f.id]: v }))} />
              <div className="flex gap-2">
                <input value={pendingCats[f.id] || ""} onChange={e => setPendingCats(p => ({ ...p, [f.id]: e.target.value }))}
                  placeholder="Category (e.g. Coffee & Café)"
                  className="flex-1 px-2 py-1.5 text-xs bg-neutral-800 border border-white/15 rounded-lg text-white placeholder:text-neutral-600 focus:outline-none" />
                <input value={pendingPayouts[f.id] || ""} onChange={e => setPendingPayouts(p => ({ ...p, [f.id]: e.target.value }))}
                  placeholder="Payout (e.g. $15–$30)"
                  className="flex-1 px-2 py-1.5 text-xs bg-neutral-800 border border-white/15 rounded-lg text-white placeholder:text-neutral-600 focus:outline-none" />
              </div>
              <div className="flex gap-2">
                <button onClick={() => onApprove(pendingCats[f.id] || "", pendingPayouts[f.id] || "", f.id, pendingNotes[f.id] ?? ((f as any).admin_notes || ""))} disabled={approving}
                  className="flex-1 py-1.5 text-xs bg-green-600 text-white rounded-lg hover:bg-green-500 transition-all disabled:opacity-50 flex items-center justify-center gap-1">
                  <CheckCircle className="w-3 h-3" />{approving ? "Publishing…" : "Approve & Publish"}
                </button>
                <button onClick={() => onRemoveFeature?.(f.id)}
                  className="px-2.5 py-1.5 text-xs bg-red-500/15 text-red-400 border border-red-500/20 rounded-lg hover:bg-red-500/25 transition-all">
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Existing features */}
      {(bizFeatures || []).filter((f: any) => ["offered", "available", "completed"].includes(f.status)).length > 0 && (
        <div className="pt-2 border-t border-white/10 space-y-1.5">
          <p className="text-xs font-medium text-neutral-500">Features</p>
          {(bizFeatures || []).filter((f: any) => ["offered", "available", "completed"].includes(f.status)).map((f: any) => {
            const featureClaims = (allClaims || []).filter((c: any) => c.featureId === f.id);
            // markReelLive sets the claim to approved when the Reel is signed
            // off. The Feature is not finished until the creator is credited,
            // so it reads as Pending in between rather than Accepted.
            const awaitingCredit = f.status !== "completed" && featureClaims.some((c: any) => c.status === "approved");
            const allFeatureClaims = featureClaims.filter((c: any) => c.status !== "viewing");
            const interested = featureClaims.filter((c: any) => c.status === "interested");
            const adminApproved = featureClaims.filter((c: any) => c.status === "approved");
            const inProgress = featureClaims.filter((c: any) => c.status === "claimed");
            const submitted = featureClaims.filter((c: any) => c.status === "submitted");
            const unclaimed = featureClaims.filter((c: any) => c.status === "unclaimed");
            return (
              <div key={f.id} className={`rounded-lg px-3 py-2 border space-y-2 ${f.status === "completed" ? "bg-purple-500/10 border-purple-500/20" : f.status === "offered" ? "bg-white/5 border-white/10" : "bg-green-500/10 border-green-500/20"}`}>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    {f.isTrial && <span className="text-[10px] bg-green-500/15 text-green-400 border border-green-500/25 px-1.5 py-0.5 rounded font-medium shrink-0">🎁 Free</span>}
                    <span className="text-xs text-neutral-300 truncate">{f.category || <span className="text-neutral-600 italic">No category</span>}</span>
                    {f.payoutRange && <span className="text-xs font-medium text-green-400">{f.payoutRange}</span>}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                      f.status === "completed" ? "bg-purple-500/15 text-purple-400" :
                      awaitingCredit ? "bg-yellow-500/15 text-yellow-400" :
                      f.status === "offered" ? "bg-neutral-500/15 text-neutral-400" :
                      "bg-green-100/10 text-green-400"
                    }`}>
                      {f.status === "completed" ? "Completed" : awaitingCredit ? "Pending" : f.status === "offered" ? "Not Accepted Yet" : "Accepted"}
                    </span>
                    <button onClick={() => onRemoveFeature?.(f.id)}
                      className="text-[10px] px-1.5 py-0.5 text-red-400/70 hover:text-red-400 hover:bg-red-500/10 rounded transition-all">
                      ✕
                    </button>
                  </div>
                </div>
                {f.status === "completed" && (f.claimed_by || f.winner_instagram) && (
                  <div className="text-xs text-neutral-500">
                    Claimed by <span className="text-purple-300">{igHandle(f.claimed_by || f.winner_instagram)}</span>
                    {f.claimed_at && <span> · {new Date(f.claimed_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>}
                  </div>
                )}
                {/* Business notes */}
                {(f as any).business_notes && (
                  <div className="bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-neutral-400 italic">
                    <span className="text-neutral-500 not-italic font-medium">Business notes: </span>"{(f as any).business_notes}"
                  </div>
                )}
                {/* All claim rows — persist after each action */}
                {[...interested, ...adminApproved, ...inProgress, ...submitted, ...unclaimed].map((c: any) => (
                  <FeatureClaimRow key={c.creatorToken} claim={c} featureId={f.id}
                    onApprove={onApproveCreatorClaim} onReset={onResetCreatorClaim} />
                ))}
              </div>
            );
          })}
        </div>
      )}


      {/* Bottom actions */}
      <div className="pt-2 border-t border-white/10 space-y-2">
        <button onClick={() => offerFeature("trial")} disabled={!!offering}
          className="w-full py-2 text-sm bg-blue-600/20 text-blue-300 border border-blue-500/20 rounded-lg hover:bg-blue-600/30 transition-all disabled:opacity-50 flex items-center justify-center gap-2">
          {offering === "trial" ? "Sending…" : "🎁 Send Free Feature"}
        </button>
        {/* Same call as above with is_trial false, so it counts against the
            business's monthly quota rather than being a giveaway. Purple to
            match how paid/completed features read elsewhere in this panel. */}
        <button onClick={() => offerFeature("oneoff")} disabled={!!offering}
          className="w-full py-2 text-sm bg-purple-600/20 text-purple-300 border border-purple-500/20 rounded-lg hover:bg-purple-600/30 transition-all disabled:opacity-50 flex items-center justify-center gap-2">
          {offering === "oneoff" ? "Sending…" : "🎟️ Add One-Time Feature"}
        </button>
        <button onClick={onImpersonate} disabled={impersonating}
          className="w-full py-2 bg-white text-neutral-900 text-sm rounded-lg hover:bg-neutral-100 transition-all disabled:opacity-50 flex items-center justify-center gap-2">
          <Eye className="w-4 h-4" />{impersonating ? "Opening…" : "View as business"}
        </button>
      </div>
    </div>
  );
}


function SubmissionCard({ sub, onApprove, approving, businessName, featurePayout, onPayoutSaved }: any) {
  const [thumbnail, setThumbnail] = useState<string | null>(sub.metrics?.thumbnail || null);
  const [thumbAuthor, setThumbAuthor] = useState<string | null>(sub.metrics?.author || null);
  const [payoutInput, setPayoutInput] = useState(sub.payout_amount || "");
  const [savingPayout, setSavingPayout] = useState(false);
  const [payoutSaved, setPayoutSaved] = useState(!!sub.admin_payout_approved);
  const [reportNote, setReportNote] = useState(sub.admin_report_note || "");
  const [savingReport, setSavingReport] = useState(false);
  const [reportSaved, setReportSaved] = useState(false);

  const businessApproved = sub.business_approved || sub.businessFeedback?.reaction === "approve";
  const isReported = sub.businessFeedback?.reaction === "report";
  const isCompleted = !!sub.cashed_out_at;

  useEffect(() => {
    if (thumbnail || !sub.reelUrl) return;
    fetch(`${BASE}/reel-preview?url=${encodeURIComponent(sub.reelUrl)}`, { headers: AUTH })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.thumbnail) setThumbnail(d.thumbnail); if (d?.author) setThumbAuthor(d.author); })
      .catch(() => {});
  }, [sub.reelUrl]);

  // Both of these update the submission and the feature together, so the server
  // does the pair in one call rather than the client issuing two writes that
  // can half-apply.
  const savePayout = async () => {
    if (!payoutInput) return;
    setSavingPayout(true);
    await apiFetch("/admin/approve-payout", {
      method: "POST",
      body: JSON.stringify({ submissionId: sub.id, payoutAmount: payoutInput }),
    }).catch(() => {});
    setPayoutSaved(true);
    setSavingPayout(false);
    onPayoutSaved?.();
  };

  const saveReport = async () => {
    if (!reportNote) return;
    setSavingReport(true);
    await apiFetch("/admin/deny-submission", {
      method: "POST",
      body: JSON.stringify({ submissionId: sub.id, note: reportNote }),
    }).catch(() => {});
    setReportSaved(true);
    setSavingReport(false);
  };

  const adminApproved = sub.status === "approved";
  const statusColor = isCompleted || payoutSaved ? "bg-neutral-500/10 text-neutral-400 border-neutral-500/20"
    : businessApproved ? "bg-green-500/10 text-green-400 border-green-500/20"
    : adminApproved ? "bg-blue-500/10 text-blue-400 border-blue-500/20"
    : "bg-yellow-500/10 text-yellow-400 border-yellow-500/20";
  // Crediting the balance completes the feature outright, so there is no
  // longer an intermediate "payout ready" state to show.
  const statusLabel = isCompleted || payoutSaved ? "Completed"
    : businessApproved ? "Business Approved"
    : adminApproved ? "Sent to Business"
    : "Pending";

  return (
    <div className="bg-white/5 border border-white/10 rounded-xl overflow-hidden">
      {thumbnail ? (
        <a href={sub.reelUrl} target="_blank" rel="noopener noreferrer">
          <img src={thumbnail} alt="Reel thumbnail" className="w-full object-cover max-h-40" />
        </a>
      ) : (
        <a href={sub.reelUrl} target="_blank" rel="noopener noreferrer"
          className="flex items-center justify-center gap-2 w-full h-12 bg-neutral-800 text-neutral-500 text-xs hover:bg-neutral-700 transition-colors">
          <ExternalLink className="w-3 h-3" />{sub.reelUrl || "No URL"}
        </a>
      )}
      <div className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="font-semibold text-white">@{(thumbAuthor || sub.creatorInstagram || "—").replace(/^@+/, "")}</p>
            {businessName && businessName !== "—" && <p className="text-xs text-neutral-300 font-medium">{businessName}</p>}
            <p className="text-xs text-neutral-500">
              <span className="font-medium">Submitted: </span>
              {sub.submittedAt ? new Date(sub.submittedAt).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"}
            </p>
          </div>
          <span className={`text-xs border px-2 py-0.5 rounded-full shrink-0 ${statusColor}`}>{statusLabel}</span>
        </div>

        {/* Only for ambassadors: null means there was no card for this Feature,
            which is different from "has not answered". */}
        {sub.handoffStatus && (
          <div className={`flex items-center gap-2 rounded-lg px-3 py-2 text-xs border ${
            sub.handoffStatus === "handed_off"
              ? "bg-green-500/10 border-green-500/20 text-green-300"
              : sub.handoffStatus === "not_handed_off"
                ? "bg-orange-500/10 border-orange-500/20 text-orange-300"
                : "bg-white/5 border-white/10 text-neutral-400"
          }`}>
            <Award className="w-3.5 h-3.5 shrink-0" />
            <span>
              {sub.handoffStatus === "handed_off" ? "Ambassador card handed off or shown"
                : sub.handoffStatus === "not_handed_off" ? "Could not hand off the Ambassador card"
                : "Ambassador card — not answered yet"}
            </span>
            {sub.handedOffAt && (
              <span className="ml-auto text-[10px] text-neutral-500 shrink-0">
                {new Date(sub.handedOffAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
              </span>
            )}
          </div>
        )}

        {/* Reel URL always visible */}
        {sub.reelUrl && (
          <a href={sub.reelUrl} target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 break-all">
            <ExternalLink className="w-3 h-3 shrink-0" />{sub.reelUrl}
          </a>
        )}

        {/* Business feedback */}
        {sub.businessFeedback && (
          <div className={`rounded-lg p-3 text-xs flex items-start gap-2 ${businessApproved ? "bg-green-500/10 border border-green-500/20 text-green-400" : "bg-orange-500/10 border border-orange-500/20 text-orange-400"}`}>
            {businessApproved ? <ThumbsUp className="w-3.5 h-3.5 shrink-0 mt-0.5" /> : <ThumbsDown className="w-3.5 h-3.5 shrink-0 mt-0.5" />}
            <div>
              <span className="font-medium">Business {businessApproved ? "approved" : "reported an issue"}</span>
              {sub.businessFeedback.note && <p className="mt-0.5 opacity-80">{sub.businessFeedback.note}</p>}
            </div>
          </div>
        )}

        {/* Admin report note (when business reported issue) */}
        {isReported && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-neutral-400">Your note to creator (shows as Denied):</p>
            {reportSaved ? (
              <p className="text-xs text-orange-400">✓ Denial note sent to creator</p>
            ) : (
              <>
                <textarea value={reportNote} onChange={e => setReportNote(e.target.value)}
                  placeholder="Explain why this reel was not approved…"
                  rows={2}
                  className="w-full px-3 py-2 text-xs bg-neutral-800 border border-white/15 rounded-lg text-white placeholder:text-neutral-600 focus:outline-none resize-none" />
                <button onClick={saveReport} disabled={!reportNote || savingReport}
                  className="w-full py-2 text-xs bg-orange-600 text-white rounded-lg hover:bg-orange-500 transition-all disabled:opacity-50">
                  {savingReport ? "Saving…" : "Send to Creator"}
                </button>
              </>
            )}
          </div>
        )}

        {/* Creator's payment method — shown once they've selected one */}
        {(sub.payment_method || sub.payment_info) && (
          <div className="bg-white/5 border border-white/10 rounded-lg px-3 py-2.5 text-xs space-y-0.5">
            <p className="text-neutral-400 font-medium">Creator Cash Out Method</p>
            {sub.payment_method && <p className="text-white">{sub.payment_method}</p>}
            {sub.payment_info && <p className="text-neutral-300">{sub.payment_info}</p>}
          </div>
        )}

        {/* Admin payout input — shown after business approves */}
        {businessApproved && !payoutSaved && (
          <div className="space-y-2 border-t border-white/10 pt-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-neutral-300">Amount to credit:</p>
              {featurePayout && (
                <span className="text-xs text-neutral-500">Estimate: <span className="text-neutral-300">{featurePayout}</span></span>
              )}
            </div>
            <input value={payoutInput} onChange={e => setPayoutInput(e.target.value)}
              placeholder="Payout amount (e.g. $25)"
              className="w-full px-3 py-2 text-xs bg-neutral-800 border border-white/15 rounded-lg text-white placeholder:text-neutral-600 focus:outline-none" />
            <button onClick={savePayout} disabled={!payoutInput || savingPayout}
              className="w-full py-2 text-sm bg-purple-600 text-white rounded-lg hover:bg-purple-500 transition-all disabled:opacity-50">
              {savingPayout ? "Crediting…" : "Approve & Add to Balance"}
            </button>
          </div>
        )}

        {payoutSaved && (
          <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-3 space-y-1">
            <p className="text-xs font-semibold text-green-300">Credited to creator balance</p>
            <p className="text-xs text-neutral-400">Amount: <span className="font-bold text-white">{(() => { const v = sub.payout_amount || payoutInput; return v && !v.startsWith("$") ? `$${v}` : v; })()}</span></p>
          </div>
        )}

        {/* Step 1: Admin approves (pending only) */}
        {!adminApproved && !isCompleted && (
          <div className="pt-1">
            <button onClick={() => onApprove(sub.id)} disabled={approving === sub.id}
              className="w-full py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-500 transition-all disabled:opacity-50 flex items-center justify-center gap-1.5">
              <ThumbsUp className="w-3.5 h-3.5" />{approving === sub.id ? "…" : "Approve → Send to Business"}
            </button>
          </div>
        )}
        {/* Step 2: Waiting for business */}
        {adminApproved && !businessApproved && !isReported && !payoutSaved && !isCompleted && (
          <p className="text-xs text-blue-400/70 text-center py-1">Waiting for business to approve in their portal…</p>
        )}
      </div>
    </div>
  );
}

// ─── Main Analytics component ─────────────────────────────────────────────────
export function Analytics({ adminToken }: { adminToken?: string } = {}) {
  // Starts false even when a token is in the URL. It used to start true, so
  // `?admin=anything` rendered the dashboard shell before a single byte had
  // been verified -- and nothing set it back when verification failed, so the
  // shell stayed up until an API call happened to 401. The server has always
  // been the real guard; this makes the client stop pretending otherwise.
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [verifying, setVerifying] = useState(!!adminToken);
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [sessionExpired, setSessionExpired] = useState(false);
  const [adminTokenVerified, setAdminTokenVerified] = useState(false);
  const [tab, setTab] = useState<Tab>("creators");
  const [signups, setSignups] = useState<Signup[]>([]);
  // Extended rather than BusinessSignup: /admin/businesses has always returned
  // the subscription fields and BusinessCard has always read them through an
  // `any` prop, so this widens the type to match what the endpoint actually
  // sends. It also gives BusinessSignupExtended its first real use -- it was
  // declared and then never referenced.
  const [businessSignups, setBusinessSignups] = useState<BusinessSignupExtended[]>([]);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [pageViews, setPageViews] = useState<PageView[]>([]);
  const [stats, setStats] = useState<{ totalSignups: number; totalBusinessSignups: number } | null>(null);
  const [creatorLinks, setCreatorLinks] = useState<Record<string, string>>({});
  const [approvedBusinesses, setApprovedBusinesses] = useState<Set<string>>(new Set());
  const [features, setFeatures] = useState<Feature[]>([]);
  const [claims, setClaims] = useState<Claim[]>([]);
  const [payoutRanges, setPayoutRanges] = useState<Record<string, string>>({});
  const [categories, setCategories] = useState<Record<string, string>>({});
  const [impersonatingId, setImpersonatingId] = useState<string | null>(null);
  const [approvingBiz, setApprovingBiz] = useState<string | null>(null);
  const [impersonatingBizId, setImpersonatingBizId] = useState<string | null>(null);
  const [impersonateError, setImpersonateError] = useState("");
  const [approvingReel, setApprovingReel] = useState<string | null>(null);
  const [fetchingMetrics, setFetchingMetrics] = useState<string | null>(null);
  const [adminLink, setAdminLink] = useState("");
  const [copiedAdmin, setCopiedAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [planClicksMap, setPlanClicksMap] = useState<Record<string, number>>({});
  const [markingPaid, setMarkingPaid] = useState<string | null>(null);
  const [ambData, setAmbData] = useState<AmbassadorAdminData | null>(null);
  const [readyData, setReadyData] = useState<ReadinessData | null>(null);
  const [emailHealth, setEmailHealth] = useState<EmailHealth | null>(null);
  const [testingEmail, setTestingEmail] = useState(false);
  const [testEmailResult, setTestEmailResult] = useState("");
  const [sendBusy, setSendBusy] = useState(false);
  const [sendResult, setSendResult] = useState("");
  // Stripe results used to arrive as window.alert. They are multi-line reports
  // about money -- account mode, which webhooks are listening, what each
  // business is paying -- and an alert cannot be scrolled, copied out of, or
  // compared against the table it describes. They render in the tab now.
  const [stripeResult, setStripeResult] = useState("");
  const [payoutRequests, setPayoutRequests] = useState<any[]>([]);
  const [settling, setSettling] = useState<string | null>(null);
  const [ambBusy, setAmbBusy] = useState<string | null>(null);

  const loadAmbassadors = useCallback(async () => {
    const res = await apiFetch("/admin/ambassadors").catch(() => null);
    if (res?.ok) setAmbData(await res.json());
  }, []);

  const loadReadiness = useCallback(async () => {
    const res = await apiFetch("/admin/creator-readiness").catch(() => null);
    if (res?.ok) setReadyData(await res.json());
  }, []);

  // Separate from the readiness load: it round-trips to Postmark, and a slow or
  // unreachable Postmark should not hold up the table.
  const loadEmailHealth = useCallback(async () => {
    const res = await apiFetch("/admin/email-health").catch(() => null);
    if (res?.ok) setEmailHealth(await res.json());
  }, []);

  const sendTestEmail = useCallback(async (to: string) => {
    setTestingEmail(true); setTestEmailResult("");
    try {
      const res = await apiFetch("/admin/email-test", { method: "POST", body: JSON.stringify({ to }) });
      const d = await res.json().catch(() => null);
      // Postmark's own message is the useful part -- "sender signature not
      // confirmed" tells you exactly what to go fix, and a generic failure does
      // not.
      setTestEmailResult(res.ok && d?.success
        ? `Sent to ${to} from ${d.from} on the ${d.stream} stream.`
        : `Failed: ${d?.error || `HTTP ${res.status}`}`);
    } catch { setTestEmailResult("Could not reach the server."); }
    finally { setTestingEmail(false); }
  }, []);

  // Dry run reports back without sending, so the result is shown rather than
  // silently discarded: seeing the rendered links is the whole point of it.
  const sendVerification = useCallback(async (creatorIds: string[], reminderOnly: boolean, dryRun: boolean) => {
    setSendBusy(true);
    try {
      const res = await apiFetch("/admin/verification/send", {
        method: "POST", body: JSON.stringify({ creatorIds, reminderOnly, dryRun }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok || !d?.success) { setSendResult(d?.error || "Send failed."); return; }
      setSendResult(dryRun
        ? `Dry run: ${d.considered} considered, ${d.results.filter((r: any) => r.dryRun).length} would send, ${d.skipped} skipped.`
        : `Sent ${d.sent}, skipped ${d.skipped}, failed ${d.failed}.`);
      if (!dryRun) await loadReadiness();
    } catch { setSendResult("Could not reach the server."); }
    finally { setSendBusy(false); }
  }, [loadReadiness]);
  // The drop announcement is a broadcast to creators already on board, so it
  // gets its own handler rather than a flag on sendVerification: different
  // audience, different cooldown, and a 409 of its own when there is nothing
  // open to announce.
  const sendFeatureDrop = useCallback(async (creatorIds: string[], dryRun: boolean, featureCount: number) => {
    setSendBusy(true);
    try {
      const res = await apiFetch("/admin/feature-drop/send", {
        method: "POST", body: JSON.stringify({ creatorIds, dryRun, featureCount }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok || !d?.success) { setSendResult(d?.error || "Send failed."); return; }

      // Every creator the batch passes over records why. Reporting only the
      // count made a fully skipped run look identical to a broken one -- you
      // clicked, nothing arrived, and "skipped 5" did not say what to change.
      const results: any[] = d.results || [];
      const tally = (key: string) => {
        const counts = new Map<string, number>();
        for (const r of results) if (r[key]) counts.set(r[key], (counts.get(r[key]) ?? 0) + 1);
        return [...counts.entries()].map(([reason, n]) => `${n} ${reason}`);
      };
      const why = [...tally("skipped"), ...tally("error")];
      const detail = why.length ? ` — ${why.join(", ")}` : "";
      const where = d.cities?.length ? d.cities.join(", ") : "no city set";

      // The number in the email is whatever was typed. Flagged when it does not
      // match what is actually published, so a slip is visible straight away
      // rather than only to the creator who opens an empty portal.
      const said = `${d.featureCount} ${d.featureCount === 1 ? "Feature" : "Features"}`;
      const mismatch = d.liveCount !== undefined && d.liveCount !== d.featureCount
        ? ` (note: ${d.liveCount} actually open)` : "";
      // A server-level problem leads, because it is the thing to act on. The
      // per-creator tally follows it rather than replacing it.
      setSendResult(dryRun
        ? `Dry run: email would say ${said} in ${where}${mismatch}. ${results.filter(r => r.dryRun).length} would send${detail}.`
        : d.problem
          ? `Nothing sent. ${d.problem}${detail}`
          : `Drop sent to ${d.sent}, saying ${said} in ${where}${mismatch}${detail}.`);
      if (!dryRun) await loadReadiness();
    } catch { setSendResult("Could not reach the server."); }
    finally { setSendBusy(false); }
  }, [loadReadiness]);

  const testFeatureDrop = useCallback(async (to: string, featureCount: number) => {
    setSendBusy(true);
    try {
      const res = await apiFetch("/admin/feature-drop/test", {
        method: "POST", body: JSON.stringify({ to, featureCount }),
      });
      const d = await res.json().catch(() => null);
      setSendResult(!res.ok || !d?.success
        ? (d?.error || "Test send failed.")
        : `Test drop sent to ${d.to}, saying ${d.featureCount} ${d.featureCount === 1 ? "Feature" : "Features"}. Subject: "${d.subject}"`);
    } catch { setSendResult("Could not reach the server."); }
    finally { setSendBusy(false); }
  }, []);

  const backfillReferrals = useCallback(async (dryRun: boolean) => {
    setAmbBusy("backfill");
    try {
      const res = await apiFetch("/admin/ambassadors/backfill-referrals", {
        method: "POST", body: JSON.stringify({ dryRun }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok || !d?.success) { window.alert(d?.error || "Backfill failed."); return; }
      const names = (d.results || []).filter((r: any) => r.created || r.wouldCreate)
        .map((r: any) => `${r.businessName || r.businessId} → @${(r.creator || "").replace(/^@+/, "")}`);
      window.alert(dryRun
        ? `Would record ${d.wouldCreate} referral${d.wouldCreate === 1 ? "" : "s"}:\n\n${names.join("\n") || "(none)"}\n\nSkipped ${d.skipped} already recorded.`
        : `Recorded ${d.created} referral${d.created === 1 ? "" : "s"}. Skipped ${d.skipped}, failed ${d.failed}.`);
      if (!dryRun) await loadAmbassadors();
    } catch { window.alert("Could not reach the server."); }
    finally { setAmbBusy(null); }
  }, [loadAmbassadors]);

  const remindExpiring = useCallback(async (dryRun: boolean) => {
    setSendBusy(true);
    try {
      const res = await apiFetch("/admin/claims/expiry-reminders", {
        method: "POST", body: JSON.stringify({ dryRun }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok || !d?.success) { setSendResult(d?.error || "Reminder sweep failed."); return; }
      const why = (() => {
        const counts = new Map<string, number>();
        for (const r of (d.results || [])) if (r.skipped) counts.set(r.skipped, (counts.get(r.skipped) ?? 0) + 1);
        return [...counts.entries()].map(([reason, n]) => `${n} ${reason}`);
      })();
      const detail = why.length ? ` — ${why.join(", ")}` : "";
      setSendResult(dryRun
        ? `Dry run: ${d.wouldSend} claim${d.wouldSend === 1 ? "" : "s"} near a deadline, of ${d.considered} open${detail}.`
        : `Reminded ${d.sent} of ${d.considered} open claim${d.considered === 1 ? "" : "s"}${detail}.`);
    } catch { setSendResult("Could not reach the server."); }
    finally { setSendBusy(false); }
  }, []);

  // Creates the four Prices in the real Stripe account, so this asks first and
  // previews by default. Idempotent on lookup_key, so a second run reuses what
  // is already there rather than making duplicate products in a live dashboard.
  const syncStripePrices = useCallback(async (dryRun: boolean) => {
    if (!dryRun && !window.confirm("Create the Contynt plan prices in your live Stripe account?\n\nExisting ones are reused, not duplicated.")) return;
    setSendBusy(true);
    try {
      const res = await apiFetch("/admin/stripe/sync-prices", {
        method: "POST", body: JSON.stringify({ dryRun }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok || !d?.success) { setStripeResult(d?.error || "Stripe price sync failed."); return; }
      const lines = (d.results || []).map((r: any) =>
        r.error ? `${r.plan}: ${r.error}`
        : r.existed ? `${r.plan}: already in Stripe (${r.priceId})`
        : r.created ? `${r.plan}: created (${r.priceId})`
        : `${r.plan}: would create at $${((r.amount ?? 0) / 100).toFixed(2)}`);

      // Stated up front, because a test key and a pending live account fail in
      // different ways and the fix for one is not the fix for the other.
      const a = d.account || {};
      const mode = d.livemode === null ? "mode unknown"
        : d.livemode ? "⚠️ LIVE mode — real money" : "TEST mode";
      const status = a.error ? `Stripe key rejected: ${a.error}`
        : `${mode} · charges ${a.chargesEnabled ? "enabled" : "NOT enabled"} · payouts ${a.payoutsEnabled ? "enabled" : "NOT enabled"}`;

      // Listed with the same key, so an endpoint missing here is in the other
      // mode -- which looks identical to a correctly configured one in Stripe's
      // dashboard, and never receives a thing.
      const hooks = d.webhooks || [];
      const hookLines = hooks.length === 0
        ? ["No webhook endpoint visible to this key. If Stripe shows one, it is in the other mode and will never fire for these payments."]
        : hooks.map((w: any) => w.error ? `webhooks: ${w.error}`
            : `${w.status} · ${w.hasCheckoutCompleted ? "listening for checkout.session.completed" : "NOT listening for checkout.session.completed"}\n  ${w.url}`);

      setStripeResult(`${dryRun ? "Preview" : "Stripe prices"}\n\n${status}\n\nWebhooks\n${hookLines.join("\n")}\n\n${lines.join("\n")}`);
    } catch { setStripeResult("Could not reach the server."); }
    finally { setSendBusy(false); }
  }, []);

  // Corrects the app against Stripe when a webhook never arrived. Previews by
  // default, because it writes what people are paying for.
  const syncSubscriptions = useCallback(async (dryRun: boolean) => {
    setSendBusy(true);
    try {
      const res = await apiFetch("/admin/stripe/sync-subscriptions", {
        method: "POST", body: JSON.stringify({ dryRun }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok || !d?.success) { setStripeResult(d?.error || "Subscription sync failed."); return; }
      const lines = (d.results || []).map((r: any) =>
        r.error ? `${r.business}: ${r.error}`
        : r.unchanged ? `${r.business}: already correct (${r.status})`
        : `${r.business}: ${r.status} → tier ${r.to?.tier ?? "none"}${r.to?.endsAt ? `, ends ${String(r.to.endsAt).slice(0, 10)}` : ""}`);
      setStripeResult(`${dryRun ? "Preview" : "Synced from Stripe"}\n\n${lines.join("\n") || "(no businesses with a Stripe customer)"}`);
      if (!dryRun) await fetchAll();
    } catch { setStripeResult("Could not reach the server."); }
    finally { setSendBusy(false); }
  }, []);

  const ambAction = async (id: string, path: string, body: object) => {
    setAmbBusy(id);
    await apiFetch(path, { method: "POST", body: JSON.stringify(body) }).catch(() => {});
    setAmbBusy(null);
    await loadAmbassadors();
  };

  // The password is checked server-side against ADMIN_SECRET; on success the
  // server hands back a session token that authorizes every later admin call.
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordError(""); setSessionExpired(false);
    try {
      const res = await apiFetch("/admin/login", { method: "POST", body: JSON.stringify({ password }) });
      // A 404 here means the function hasn't been deployed with /admin/login yet,
      // and the body won't be JSON — so don't assume it parses.
      const d = await res.json().catch(() => null);
      if (!res.ok || !d?.token) {
        setPasswordError(
          res.status === 404 ? "Server is out of date — deploy the edge function."
          : d?.error || `Login failed (${res.status})`
        );
        return;
      }
      sessionStorage.setItem("analytics_token", d.token);
      setIsAuthenticated(true);
    } catch {
      setPasswordError("Could not reach the server. Try again.");
    }
  };

  // Registered once, so a 401 from any admin call -- not just the ones on this
  // screen -- lands on the login sheet with a reason.
  useEffect(() => {
    onUnauthorized = () => {
      sessionStorage.removeItem("analytics_token");
      setIsAuthenticated(false);
      setSessionExpired(true);
    };
    return () => { onUnauthorized = null; };
  }, []);

  useEffect(() => {
    if (adminToken) {
      // Verify admin private link token. Resolved either way -- an invalid one
      // has to land on the login sheet, not on a shell waiting for a 401.
      apiFetch(`/admin/verify?token=${encodeURIComponent(adminToken)}`)
        .then((r) => r.json())
        .then((d) => {
          if (d?.valid) {
            // The private link doubles as the session token for later admin calls.
            sessionStorage.setItem("analytics_token", adminToken);
            setIsAuthenticated(true);
            setAdminTokenVerified(true);
          } else {
            // Falls back to whatever session already exists, so an admin who is
            // signed in and follows a stale link is not thrown out.
            setIsAuthenticated(!!sessionStorage.getItem("analytics_token"));
          }
        })
        .catch(() => setIsAuthenticated(!!sessionStorage.getItem("analytics_token")))
        .finally(() => setVerifying(false));
    } else {
      setIsAuthenticated(!!sessionStorage.getItem("analytics_token"));
      setVerifying(false);
    }
  }, [adminToken]);

  useEffect(() => {
    document.body.style.backgroundColor = "#030712";
    if (!isAuthenticated) { document.body.style.overflow = "hidden"; }
    else { document.body.style.overflow = "unset"; }
    return () => { document.body.style.overflow = "unset"; document.body.style.backgroundColor = ""; };
  }, [isAuthenticated]);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [statsRes, signupsRes, bizRes, subsRes, linksRes, featuresRows, claimsRes, payoutRes] = await Promise.all([
        apiFetch("/analytics/stats"),
        apiFetch("/signups"),
        apiFetch("/business-signups"),
        apiFetch("/admin/submissions"),
        apiFetch("/creator-links"),
        apiFetch("/admin/features"),
        apiFetch("/admin/claims"),
        apiFetch("/admin/payout-requests"),
      ]);
      if (statsRes.ok) { const d = await statsRes.json(); setStats(d); setPageViews(d.recentPageviews || []); }
      if (signupsRes.ok) { const d = await signupsRes.json(); setSignups(d.signups || []); }
      if (bizRes.ok) {
        const d = await bizRes.json();
        const rows = d.signups || [];
        setBusinessSignups(rows);
        // planClicks now comes back with the signup rather than a second query.
        const map: Record<string, number> = {};
        for (const r of rows) if (r.planClicks) map[r.id] = r.planClicks;
        setPlanClicksMap(map);
      }
      if (subsRes.ok) {
        const rows = await subsRes.json();
        const mapSub = (r: any) => ({
          id: r.id,
          featureId: r.feature_id || r.featureId,
          creatorInstagram: r.creator_instagram || r.creatorInstagram || "",
          reelUrl: r.reel_url || r.reelUrl || "",
          status: r.status,
          submittedAt: r.submitted_at || r.submittedAt,
          approvedAt: r.approved_at || r.approvedAt,
          metrics: r.metrics || {},
          businessFeedback: r.business_feedback || r.businessFeedback || null,
          reportNote: r.report_note || r.reportNote || "",
          business_approved: r.business_approved ?? false,
          admin_payout_approved: r.admin_payout_approved ?? false,
          payout_amount: r.payout_amount || "",
          stripe_link: r.stripe_link || "",
          cashed_out_at: r.cashed_out_at || null,
          denied: r.denied ?? false,
          admin_report_note: r.admin_report_note || "",
          payment_method: r.payment_method || "",
          payment_info: r.payment_info || "",
          handoffStatus: r.handoffStatus ?? null,
          handedOffAt: r.handedOffAt ?? null,
        });
        const allSubs = (Array.isArray(rows) ? rows : rows.submissions || []).map(mapSub);
        // Deduplicate by reelUrl + featureId — keep the most recent submitted_at
        const seen = new Map<string, any>();
        for (const s of allSubs) {
          const key = `${s.reelUrl}|${s.featureId}`;
          const existing = seen.get(key);
          if (!existing || new Date(s.submittedAt) > new Date(existing.submittedAt)) seen.set(key, s);
        }
        setSubmissions(Array.from(seen.values()));
      }
      if (linksRes.ok) { const d = await linksRes.json(); setCreatorLinks(d.links || {}); }
      // The server returns camelCase for the fields it renames and snake_case
      // for the ones the admin UI reads verbatim, so accept either.
      if (featuresRows.ok) {
        const featData = await featuresRows.json();
        const baseFeats: Feature[] = (featData.features || []).map((f: any) => ({
          id: f.id,
          businessId: f.businessId || f.business_id || "",
          businessName: f.businessName || f.business_name || "",
          category: f.category || "",
          payoutRange: f.payoutRange || f.payout_range || "",
          status: f.status || "",
          total_payout: f.total_payout || "",
          claimed_by: f.claimed_by || "",
          winner_instagram: f.winner_instagram || "",
          claimed_at: f.claimed_at || "",
          isTrial: f.isTrial ?? f.is_trial ?? false,
          isOneOff: f.isOneOff ?? f.is_one_off ?? false,
          // Dates the Feature to a month. The quota is monthly, so a card
          // without this counts every Feature the business has ever had.
          offeredAt: f.offeredAt ?? f.offered_at ?? null,
          approvedAt: f.approvedAt ?? f.approved_at ?? null,
          requestNotes: f.requestNotes || f.request_notes || "",
          submittedByBusiness: f.submittedByBusiness ?? f.submitted_by_business ?? false,
          admin_notes: f.admin_notes || "",
          address: f.address || "",
          city: f.city || "",
        }));
        setFeatures(baseFeats);
        const approvedIds = new Set<string>(baseFeats.filter(f => f.status === "available" || f.status === "completed").map(f => f.businessId));
        setApprovedBusinesses(approvedIds);
      }
      if (claimsRes.ok) { const d = await claimsRes.json(); setClaims(d.claims || []); }
      if (payoutRes.ok) { const d = await payoutRes.json(); setPayoutRequests(d.requests || []); }
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { if (isAuthenticated) fetchAll(); }, [isAuthenticated, fetchAll]);
  useEffect(() => { if (isAuthenticated && tab === "ambassadors" && !ambData) loadAmbassadors(); }, [isAuthenticated, tab, ambData, loadAmbassadors]);
  useEffect(() => { if (isAuthenticated && tab === "readiness" && !readyData) loadReadiness(); }, [isAuthenticated, tab, readyData, loadReadiness]);
  useEffect(() => { if (isAuthenticated && tab === "readiness" && !emailHealth) loadEmailHealth(); }, [isAuthenticated, tab, emailHealth, loadEmailHealth]);


  const settlePayoutRequest = async (req: any) => {
    if (!window.confirm(`Mark $${req.amount} to ${req.method} (${req.handle}) as sent?`)) return;
    setSettling(req.id);
    await apiFetch("/admin/mark-paid", {
      method: "POST",
      body: JSON.stringify({ creatorToken: req.creatorToken }),
    }).catch(() => {});
    setSettling(null);
    await fetchAll();
  };

  const markCreatorPaid = async (id: string, token?: string, label?: string) => {
    if (!window.confirm(`Mark ${label || "this creator"} as paid? This settles their balance to $0 and records the payout.`)) return;
    setMarkingPaid(id);
    await apiFetch("/admin/mark-paid", {
      method: "POST",
      body: JSON.stringify({ creatorId: id, creatorToken: token }),
    }).catch(() => {});
    setMarkingPaid(null);
    await fetchAll();
  };

  // Opens the creator's portal in a new tab on a short lived admin token.
  // Deliberately not /creator-links: that route rotates the creator's own token,
  // so using it here would sign the creator out just to take a look.
  const impersonateCreator = async (id: string) => {
    setImpersonatingId(id);
    try {
      const res = await apiFetch("/admin/impersonate-creator", {
        method: "POST", body: JSON.stringify({ creatorId: id }),
      });
      const d = await res.json().catch(() => null);
      if (res.ok && d?.token) {
        // imp=1 keeps the portal from persisting this as a real session.
        // "_blank" rather than a named target, so each creator opens in its own tab
        // and a second impersonation does not replace the first.
        window.open(`${window.location.origin}/app?creator=${encodeURIComponent(d.token)}&imp=1`, "_blank", "noopener");
      } else {
        // A failure used to leave the button silently returning to idle, which
        // made a missing server route look like a dead button.
        setImpersonateError(d?.error || `Could not open creator portal (${res.status}).`);
      }
    } catch { setImpersonateError("Could not reach the server."); }
    setImpersonatingId(null);
  };
  const resetCreator = async (creatorId: string) => {
    await apiFetch("/admin/reset-creator", { method: "POST", body: JSON.stringify({ creatorId }) });
    await fetchAll();
  };

  const approveBusiness = async (id: string, overrideCategory?: string, overridePayout?: string, existingFeatureId?: string, adminNotes?: string) => {
    setApprovingBiz(id);
    if (existingFeatureId) {
      const cat = overrideCategory || "";
      const pay = overridePayout || "";
      await apiFetch("/admin/publish-feature", {
        method: "POST",
        body: JSON.stringify({ featureId: existingFeatureId, category: cat, payoutRange: pay, adminNotes }),
      }).catch(() => {});
      setFeatures(prev => prev.map(f => f.id === existingFeatureId ? { ...f, status: "available", ...(cat && { category: cat }), ...(pay && { payoutRange: pay }) } : f));
    } else {
      const biz = businessSignups.find(b => b.id === id);
      // The server reads the business record itself, so the feature's
      // denormalised name/address/city can't drift from the source row.
      const res = await apiFetch("/admin/approve-business", {
        method: "POST",
        body: JSON.stringify({ businessId: id, category: overrideCategory || "Business", payoutRange: overridePayout || " " }),
      }).catch(() => null);
      const newId = (await res?.json().catch(() => null))?.featureId || "";
      if (newId) {
        setApprovedBusinesses((p) => new Set([...p, id]));
        setFeatures((prev) => [...prev, { id: newId, businessId: id, businessName: biz?.businessName || "", category: overrideCategory || "", payoutRange: overridePayout || "", status: "available" }]);
      }
    }
    setApprovingBiz(null);
  };
  // Same mechanics as impersonateCreator: a short lived token minted by the
  // server, opened in its own tab, and never written to the business's own
  // biztokenref_ so their real portal link keeps working.
  const impersonateBusiness = async (id: string) => {
    setImpersonatingBizId(id);
    try {
      const res = await apiFetch("/admin/impersonate-business", {
        method: "POST", body: JSON.stringify({ businessId: id }),
      });
      const d = await res.json().catch(() => null);
      if (res.ok && d?.token) {
        window.open(`${window.location.origin}?biz=${encodeURIComponent(d.token)}&imp=1`, "_blank", "noopener");
      } else {
        setImpersonateError(d?.error || `Could not open business portal (${res.status}).`);
      }
    } catch { setImpersonateError("Could not reach the server."); }
    setImpersonatingBizId(null);
  };
  // These three already had server endpoints doing the same writes; the direct
  // SQL calls alongside them were redundant.
  const approveCreatorClaim = async (featureId: string, creatorToken: string) => {
    await apiFetch("/admin/approve-creator-claim", { method: "POST", body: JSON.stringify({ featureId, creatorToken }) }).catch(() => {});
    await fetchAll();
  };
  const removeFeature = async (featureId: string) => {
    if (!window.confirm("Remove this feature?")) return;
    await apiFetch("/admin/remove-feature", { method: "POST", body: JSON.stringify({ featureId }) }).catch(() => {});
    setFeatures((prev: Feature[]) => prev.filter((f) => f.id !== featureId));
  };
  const resetCreatorClaim = async (featureId: string, creatorToken: string) => {
    await apiFetch("/admin/reset-creator-claim", { method: "POST", body: JSON.stringify({ featureId, creatorToken }) }).catch(() => {});
    await fetchAll();
  };
  const approveReel = async (id: string) => {
    setApprovingReel(id);
    await apiFetch("/admin/approve-reel", { method: "POST", body: JSON.stringify({ submissionId: id }) });
    setSubmissions((p) => p.map((s) => s.id === id ? { ...s, status: "approved" } : s));
    setApprovingReel(null);
  };
  const reportReel = async (id: string, note: string) => {
    await apiFetch("/admin/report-reel", { method: "POST", body: JSON.stringify({ submissionId: id, note }) });
    setSubmissions((p) => p.map((s) => s.id === id ? { ...s, status: "reported", reportNote: note } : s));
  };
  const fetchMetrics = async (id: string, url: string) => {
    setFetchingMetrics(id);
    const res = await apiFetch("/admin/fetch-metrics", { method: "POST", body: JSON.stringify({ submissionId: id, reelUrl: url }) });
    const d = await res.json();
    if (res.ok) setSubmissions((p) => p.map((s) => s.id === id ? { ...s, metrics: d.metrics } : s));
    setFetchingMetrics(null);
  };
  const generateAdminLink = async () => {
    const res = await apiFetch("/admin/generate-link", { method: "POST" });
    const d = await res.json();
    if (res.ok) setAdminLink(`${window.location.origin}?admin=${d.token}`);
  };

  // A valid private link should not flash the password sheet on its way in.
  // Only ever shown while /admin/verify is in flight, which is one round trip.
  if (verifying) {
    return (
      <div className="fixed inset-0 bg-neutral-950 z-[9999] flex items-center justify-center px-6">
        <p className="text-sm text-neutral-500">Checking your link…</p>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="fixed inset-0 bg-neutral-950/80 backdrop-blur-md z-[9999] flex items-center justify-center px-6" onClick={() => (window.location.hash = "")}>
        <div className="max-w-sm w-full bg-neutral-900 rounded-2xl shadow-2xl border border-white/10 p-8" onClick={(e) => e.stopPropagation()}>
          <h2 className="text-3xl font-bold text-white mb-6 text-center">Analytics</h2>
          <form onSubmit={handleLogin} className="space-y-3">
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              className="w-full px-4 py-3 bg-neutral-800 border border-white/20 text-white placeholder:text-neutral-500 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/30"
              placeholder="Password" required />
            {sessionExpired && !passwordError && (
              <p className="text-yellow-400 text-sm">Your session expired. Sign in again.</p>
            )}
            {passwordError && <p className="text-red-400 text-sm">{passwordError}</p>}
            <button type="submit" className="w-full px-4 py-3 bg-white text-neutral-900 rounded-lg hover:bg-neutral-100 transition-all">Login</button>
          </form>
        </div>
      </div>
    );
  }

  // Sorted so a cancellation is the first thing read: those are the rows with a
  // deadline, and the only ones where being a day late costs anything.
  const subscribedBusinesses = businessSignups
    .filter(b => b.subscriptionTier)
    .sort((a, b) => (a.subscriptionEndsAt ? 0 : 1) - (b.subscriptionEndsAt ? 0 : 1)
      || (a.businessName || "").localeCompare(b.businessName || ""));

  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: "creators", label: "Creators", count: signups.length },
    { key: "businesses", label: "Businesses", count: businessSignups.length },
    { key: "reels", label: "Submitted Reels", count: submissions.length },
    { key: "ambassadors", label: "Ambassadors", count: ambData?.overview.totalAmbassadors },
    { key: "readiness", label: "Creator Readiness", count: readyData?.funnel.confirmed },
    { key: "billing", label: "Billing", count: subscribedBusinesses.length },
    { key: "pageviews", label: "Page Views" },
  ];

  return (
    <div className="min-h-screen bg-neutral-950">
      {/* Header */}
      <div className="bg-neutral-900 border-b border-neutral-800 px-6 py-4">
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-white">Admin Dashboard</h1>
            {stats && (
              <p className="text-sm text-neutral-400 mt-0.5">
                {stats.totalSignups} creators · {stats.totalBusinessSignups} businesses
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={fetchAll}
              className="flex items-center gap-1.5 px-3 py-2 bg-white/10 text-neutral-300 rounded-lg hover:bg-white/15 transition-all text-sm">
              <RefreshCw className="w-3.5 h-3.5" />Refresh
            </button>
            <button onClick={generateAdminLink}
              className="flex items-center gap-1.5 px-3 py-2 bg-white text-neutral-900 rounded-lg hover:bg-neutral-100 transition-all text-sm">
              <Link className="w-3.5 h-3.5" />Generate Private Link
            </button>
            <button onClick={() => { sessionStorage.removeItem("analytics_token"); setIsAuthenticated(false); }}
              className="px-3 py-2 bg-white/10 text-neutral-300 rounded-lg hover:bg-white/15 transition-all text-sm">
              Logout
            </button>
            <a href="/" className="px-3 py-2 bg-white/10 text-neutral-300 rounded-lg hover:bg-white/15 transition-all text-sm">← Site</a>
          </div>
        </div>
        {adminLink && (
          <div className="max-w-5xl mx-auto mt-3 flex items-center gap-2 bg-blue-500/10 border border-blue-500/20 rounded-xl px-4 py-3">
            <span className="text-xs text-blue-300 font-mono flex-1 truncate">{adminLink}</span>
            <button onClick={() => { navigator.clipboard.writeText(adminLink); setCopiedAdmin(true); setTimeout(() => setCopiedAdmin(false), 2000); }}
              className="flex items-center gap-1 text-xs text-blue-300 bg-blue-500/10 px-2 py-1 rounded-lg hover:bg-blue-500/20 transition-all shrink-0">
              <Copy className="w-3 h-3" />{copiedAdmin ? "Copied!" : "Copy"}
            </button>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="bg-neutral-900 border-b border-neutral-800 px-6">
        <div className="max-w-5xl mx-auto flex gap-0 overflow-x-auto">
          {tabs.map((t) => (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={`px-4 py-3 text-sm font-medium whitespace-nowrap border-b-2 transition-all flex items-center gap-1.5 ${
                tab === t.key ? "border-white text-white" : "border-transparent text-neutral-500 hover:text-neutral-300"
              }`}>
              {t.label}
              {t.count !== undefined && t.count > 0 && (
                <span className={`text-xs px-1.5 py-0.5 rounded-full ${tab === t.key ? "bg-white text-neutral-900" : "bg-white/10 text-neutral-400"}`}>
                  {t.count}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        {impersonateError && (
          <div className="mb-4 flex items-center justify-between gap-3 bg-red-500/10 border border-red-500/25 rounded-xl px-4 py-2.5">
            <p className="text-xs text-red-300">{impersonateError}</p>
            <button onClick={() => setImpersonateError("")}
              className="text-xs text-neutral-400 hover:text-neutral-200 shrink-0">Dismiss</button>
          </div>
        )}
        {loading && <p className="text-neutral-400 text-sm text-center py-12">Loading…</p>}

        {/* ── Creators tab ── */}
        {!loading && tab === "creators" && (
          <div>
            <h2 className="text-lg font-semibold text-white mb-4">Creators</h2>

            {payoutRequests.filter(r => r.status === "requested").length > 0 && (
              <div className="mb-6 space-y-2">
                <p className="text-xs font-semibold text-yellow-400 uppercase tracking-wider">
                  Cash-out requests · {payoutRequests.filter(r => r.status === "requested").length}
                </p>
                {payoutRequests.filter(r => r.status === "requested").map(r => (
                  <div key={r.id} className="bg-yellow-500/5 border border-yellow-500/25 rounded-xl px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-white">
                        @{(r.creatorInstagram || "creator").replace(/^@+/, "")}
                        <span className="ml-2 text-green-400">${r.amount}</span>
                      </p>
                      <p className="text-xs text-neutral-400 mt-0.5">
                        {r.method} · <span className="font-mono text-neutral-300">{r.handle}</span>
                        <span className="text-neutral-600"> · {new Date(r.requestedAt).toLocaleDateString()}</span>
                      </p>
                    </div>
                    <button onClick={() => settlePayoutRequest(r)} disabled={settling === r.id}
                      className="shrink-0 px-3 py-1.5 text-xs bg-green-600 text-white rounded-lg hover:bg-green-500 transition-all disabled:opacity-50 whitespace-nowrap">
                      {settling === r.id ? "Settling…" : "Mark as Sent"}
                    </button>
                  </div>
                ))}
              </div>
            )}
            {signups.length === 0 ? <p className="text-neutral-400 text-sm">No creator sign-ups yet.</p> : (
              <div className="space-y-6">
                {Object.entries(
                  signups.reduce((acc, s) => { (acc[s.city || "Unknown"] = acc[s.city || "Unknown"] || []).push(s); return acc; }, {} as Record<string, Signup[]>)
                ).sort(([a], [b]) => {
                  const isSF = (c: string) => c.toLowerCase().includes("san francisco") || c === "san-francisco";
                  if (isSF(a)) return -1;
                  if (isSF(b)) return 1;
                  return a.localeCompare(b);
                }).map(([city, citySignups]) => (
                  <div key={city}>
                    <p className="text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-2">{city} — {citySignups.length}</p>
                    <div className="space-y-2">
                      {citySignups.map((s) => {
                        const token = creatorLinks[s.id];
                        const creatorClaims = token ? claims.filter(c => c.creatorToken === token) : [];
                        return (
                          <CreatorRow key={s.id} signup={s}
                            token={token}
                            onImpersonate={() => impersonateCreator(s.id)}
                            impersonating={impersonatingId === s.id}
                            claims={creatorClaims}
                            features={features}
                            onMarkPaid={() => markCreatorPaid(s.id, token, igHandle(s.instagram))}
                            markingPaid={markingPaid === s.id} />
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Businesses tab ── */}
        {!loading && tab === "businesses" && (
          <div>
            <h2 className="text-lg font-semibold text-white mb-4">Businesses</h2>
            {businessSignups.length === 0 ? <p className="text-neutral-400 text-sm">No business sign-ups yet.</p> : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {businessSignups.map((b) => (
                  <BusinessCard key={b.id} signup={b}
                    approved={approvedBusinesses.has(b.id)}
                    payoutRange={payoutRanges[b.id] || ""}
                    setPayoutRange={(v: string) => setPayoutRanges((p) => ({ ...p, [b.id]: v }))}
                    category={categories[b.id] || ""}
                    setCategory={(v: string) => setCategories((p) => ({ ...p, [b.id]: v }))}
                    onApprove={(cat?: string, payout?: string, fid?: string, notes?: string) => approveBusiness(b.id, cat, payout, fid, notes)}
                    onImpersonate={() => impersonateBusiness(b.id)}
                    impersonating={impersonatingBizId === b.id}
                    approving={approvingBiz === b.id}
                    planClicks={planClicksMap[b.id] || 0}
                    bizFeatures={features.filter(f => f.businessId === b.id)}
                    allClaims={claims}
                    onApproveCreatorClaim={approveCreatorClaim}
                    onResetCreatorClaim={resetCreatorClaim}
                    onFeatureOffered={(feat: any) => setFeatures((prev: any[]) => [...prev, feat])}
                    onRemoveFeature={(id: string) => removeFeature(id)} />
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Submitted Reels tab ── */}
        {!loading && tab === "reels" && (
          <div>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-white">Submitted Reels</h2>
              <button onClick={() => fetchAll()}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-white/10 text-neutral-300 rounded-lg hover:bg-white/15 transition-all">
                <RefreshCw className="w-3 h-3" />Refresh
              </button>
            </div>
            {submissions.length === 0 ? <p className="text-neutral-400 text-sm">No reels submitted yet.</p> : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {submissions.map((s) => (
                  <SubmissionCard key={s.id} sub={s}
                    onApprove={approveReel}
                    approving={approvingReel}
                    businessName={features.find(f => f.id === s.featureId)?.businessName || "—"}
                    featurePayout={features.find(f => f.id === s.featureId)?.payoutRange?.replace(/\$?(\d+)\s*[–\-]\s*\$?(\d+)/, '$$$1 - $$$2') || ""}
                    onPayoutSaved={fetchAll} />
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Page Views tab ── */}
        {!loading && tab === "billing" && (
          <div className="space-y-5">
            {/* What Stripe currently says, before anyone presses anything. The
                buttons below only make sense against this: "Sync from Stripe"
                is worth pressing when a row here disagrees with the dashboard,
                and pointless when they already match. */}
            <div>
              <h2 className="text-lg font-semibold text-white mb-1">Subscriptions</h2>
              <p className="text-sm text-neutral-400 mb-3">
                What this app believes each business is paying. Stripe is the source of truth —
                these rows are only as fresh as the last webhook that arrived.
              </p>
              {subscribedBusinesses.length === 0 ? (
                <p className="text-neutral-400 text-sm bg-white/5 border border-white/10 rounded-xl px-4 py-3">
                  No business has a plan yet.
                </p>
              ) : (
                <div className="space-y-2">
                  {subscribedBusinesses.map(b => (
                    <div key={b.id} className="bg-white/5 border border-white/10 rounded-xl px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-2">
                      <span className="text-sm text-white flex-1 truncate">{b.businessName}</span>
                      <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-500/20 border border-indigo-400/40 text-indigo-100 shrink-0">
                        {b.subscriptionTier}
                      </span>
                      {b.subscriptionEndsAt ? (
                        <span className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 rounded-full shrink-0">
                          Cancels {endsOn(b.subscriptionEndsAt)}
                        </span>
                      ) : (
                        <span className="text-xs text-neutral-500 shrink-0">renewing</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <div className="flex flex-wrap gap-2 mt-3">
                <button onClick={() => syncSubscriptions(true)} disabled={sendBusy}
                  title="Compare every business against Stripe, without writing"
                  className="px-3 py-2 bg-white/10 text-neutral-300 rounded-lg hover:bg-white/15 transition-all text-sm disabled:opacity-40">
                  Check subscriptions
                </button>
                <button onClick={() => syncSubscriptions(false)} disabled={sendBusy}
                  className="px-3 py-2 bg-indigo-500/20 border border-indigo-400/40 text-indigo-100 rounded-lg hover:bg-indigo-500/30 transition-all text-sm disabled:opacity-40">
                  Sync from Stripe
                </button>
              </div>
              <p className="text-xs text-neutral-500 mt-2">
                Check first — it writes nothing. Sync repairs the rows above when a webhook was
                sent to the wrong mode, went to an endpoint added after the payment, or failed
                every retry. Nothing else notices that, because the missing event is the only
                thing that would have said so.
              </p>
            </div>

            <div className="border-t border-white/10 pt-5">
              <h2 className="text-lg font-semibold text-white mb-1">Plan prices</h2>
              <p className="text-sm text-neutral-400 mb-3">
                The Prices the plan buttons check out against. Creating them is idempotent on
                lookup key, so a second run reuses what is already in Stripe.
              </p>
              <div className="flex flex-wrap gap-2">
                <button onClick={() => syncStripePrices(true)} disabled={sendBusy}
                  title="Show which plan prices exist in Stripe, without creating any"
                  className="px-3 py-2 bg-white/10 text-neutral-300 rounded-lg hover:bg-white/15 transition-all text-sm disabled:opacity-40">
                  Check Stripe prices
                </button>
                <button onClick={() => syncStripePrices(false)} disabled={sendBusy}
                  className="px-3 py-2 bg-indigo-500/20 border border-indigo-400/40 text-indigo-100 rounded-lg hover:bg-indigo-500/30 transition-all text-sm disabled:opacity-40">
                  Create Stripe prices
                </button>
              </div>
              <p className="text-xs text-neutral-500 mt-2">
                Check also reports which mode the key is in and whether a webhook endpoint is
                listening. A key and an endpoint in different modes look identical in Stripe's
                dashboard and never fire for each other.
              </p>
            </div>

            {stripeResult && (
              <div className="border-t border-white/10 pt-5">
                <div className="flex items-center justify-between gap-3 mb-2">
                  <h3 className="text-sm font-semibold text-white">Last result</h3>
                  <button onClick={() => setStripeResult("")}
                    className="text-xs text-neutral-400 hover:text-neutral-200 transition-all">
                    Dismiss
                  </button>
                </div>
                <pre className="bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-xs text-neutral-300 font-mono whitespace-pre-wrap break-words overflow-x-auto">
{stripeResult}
                </pre>
              </div>
            )}
          </div>
        )}

        {!loading && tab === "pageviews" && (
          <div>
            <h2 className="text-lg font-semibold text-white mb-4">Recent Page Views</h2>
            {pageViews.length === 0 ? <p className="text-neutral-400 text-sm">No page views recorded.</p> : (
              <div className="space-y-2">
                {pageViews.map((v, i) => (
                  <div key={i} className="bg-white/5 border border-white/10 rounded-xl px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3">
                    <span className="text-xs font-mono text-neutral-500 bg-white/10 px-2 py-1 rounded truncate max-w-[160px] shrink-0">{v.visitorId.slice(0, 16)}…</span>
                    {(v.city || v.country) && (
                      <span className="text-xs text-blue-400 bg-blue-500/10 border border-blue-500/20 px-2 py-0.5 rounded-full shrink-0">
                        📍 {[v.city, v.country].filter(Boolean).join(", ")}
                      </span>
                    )}
                    <span className="text-sm text-neutral-400 truncate flex-1">{v.referrer || "Direct"}</span>
                    <span className="text-xs text-neutral-500 shrink-0">{new Date(v.timestamp).toLocaleString()}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {!loading && tab === "ambassadors" && (
          ambData
            ? <AmbassadorAdmin
                data={ambData}
                busy={ambBusy}
                onAdvance={(id, stage) => ambAction(id, "/admin/referrals/advance", { referralId: id, stage })}
                onPayReward={(id) => ambAction(id, "/admin/referrals/pay-reward", { referralId: id })}
                onToggle={(id, enabled) => ambAction(id, "/admin/ambassadors/toggle", { ambassadorId: id, enabled })}
                onBackfill={backfillReferrals}
              />
            : <p className="text-neutral-400 text-sm">Loading ambassadors…</p>
        )}

        {!loading && tab === "readiness" && (
          readyData
            ? <div className="space-y-3">
                {sendResult && (
                  <div className="bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 flex items-center justify-between gap-3">
                    <p className="text-xs text-neutral-300">{sendResult}</p>
                    <button onClick={() => setSendResult("")}
                      className="text-xs text-neutral-500 hover:text-neutral-300">Dismiss</button>
                  </div>
                )}
                <CreatorReadiness data={readyData} onSend={sendVerification} onSendFeatureDrop={sendFeatureDrop} onTestFeatureDrop={testFeatureDrop} onRemindExpiring={remindExpiring} busy={sendBusy}
                  health={emailHealth} onTest={sendTestEmail} testing={testingEmail} testResult={testEmailResult} />
              </div>
            : <p className="text-neutral-400 text-sm">Loading readiness…</p>
        )}
      </div>
    </div>
  );
}
