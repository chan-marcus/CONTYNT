import { useState, useEffect, useCallback } from "react";
import { CheckCircle, Copy, RefreshCw, ExternalLink, ThumbsUp, ThumbsDown, Link, ChevronDown, Award, Eye } from "lucide-react";
import { projectId, publicAnonKey } from "/utils/supabase/info";
import { AmbassadorAdmin, type AmbassadorAdminData } from "./AmbassadorAdmin";
import { CreatorReadiness, type ReadinessData } from "./CreatorReadiness";

const BASE = `https://${projectId}.supabase.co/functions/v1/make-server-f5961d0c`;
const AUTH = { Authorization: `Bearer ${publicAnonKey}` };
// Admin session token from /admin/login (or an admin private link). Read per
// call so it picks up a fresh login without a reload.
const adminSession = () => sessionStorage.getItem("analytics_token") || "";
const apiFetch = (path: string, opts?: RequestInit) =>
  fetch(`${BASE}${path}`, {
    ...opts,
    headers: { ...AUTH, "Content-Type": "application/json", "x-admin-token": adminSession(), ...(opts?.headers ?? {}) },
  });

type Tab = "creators" | "businesses" | "reels" | "pageviews" | "ambassadors" | "readiness";

interface Signup { id: string; instagram: string; email: string; city: string; createdAt: string; totalEarned?: number; pendingEarnings?: number; availableEarnings?: number; }
interface BusinessSignup { id: string; businessName: string; instagram: string; email: string; city: string; address: string; preferredContact: string; createdAt: string; }
interface Submission { id: string; featureId: string; creatorInstagram: string; reelUrl: string; status: string; submittedAt: string; reportNote?: string; metrics?: any; businessFeedback?: { reaction: "approve" | "report"; note?: string; submittedAt: string; businessName?: string }; }
interface PageView { visitorId: string; referrer: string; timestamp: string; country?: string; city?: string; }
interface Feature { id: string; businessId: string; businessName: string; category: string; payoutRange: string; status: string; total_payout?: string; claimed_by?: string; winner_instagram?: string; claimed_at?: string; isTrial?: boolean; requestNotes?: string; submittedByBusiness?: boolean; }
interface BusinessSignupExtended extends BusinessSignup { subscriptionTier?: string; }
interface Claim { featureId: string; creatorToken: string; creatorInstagram: string; status: string; claimedAt: string; reelUrl?: string; approvedAt?: string; expiresAt?: string; acceptanceExpiresAt?: string; lastViewed?: string; }

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

function BusinessCard({ signup, bizToken, approved, onApprove, onGenerateLink, onCopyLink, payoutRange, setPayoutRange, category, setCategory, approving, generatingLink, copiedId, bizFeatures, allClaims, onApproveCreatorClaim, onResetCreatorClaim, onFeatureOffered, onRemoveFeature, planClicks = 0 }: any) {
  const portalUrl = bizToken ? `${window.location.origin}?biz=${bizToken}` : null;
  const [showAddAnother, setShowAddAnother] = useState(false);
  const [addCategory, setAddCategory] = useState("");
  const [addPayout, setAddPayout] = useState("");
  const [pendingCats, setPendingCats] = useState<Record<string, string>>({});
  const [pendingPayouts, setPendingPayouts] = useState<Record<string, string>>({});
  const [pendingNotes, setPendingNotes] = useState<Record<string, string>>({});
  const [tier, setTierLocal] = useState(signup.subscriptionTier || "");
  const [offeringSaving, setOfferingSaving] = useState(false);

  const tierLimit = TIER_LIMITS[tier] || 0;
  // Count offered/pending/available/completed features this month as "used"
  const reelsUsed = (bizFeatures || []).filter((f: any) => ["pending","available","completed"].includes(f.status) && !f.isTrial).length;

  const offerFeature = async (isTrial = false) => {
    setOfferingSaving(true);
    const now = new Date().toISOString();
    // The server builds the row from the business record and returns the id.
    const res = await apiFetch("/admin/offer-feature", {
      method: "POST", body: JSON.stringify({ businessId: signup.id, isTrial }),
    }).catch(() => null);
    const newId = (await res?.json().catch(() => null))?.featureId || "";
    if (newId) {
      onFeatureOffered?.({ id: newId, businessId: signup.id, businessName: signup.businessName || "", category: "", payoutRange: "", status: "offered", isTrial, offeredAt: now });
    }
    setOfferingSaving(false);
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
          <p className="font-semibold text-white">{signup.businessName}</p>
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
          <span className={`text-xs px-2 py-1 rounded-lg border shrink-0 ${reelsUsed >= tierLimit ? "bg-red-500/10 text-red-400 border-red-500/20" : "bg-white/5 text-neutral-400 border-white/10"}`}>
            {reelsUsed} of {tierLimit} used
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
                      f.status === "offered" ? "bg-neutral-500/15 text-neutral-400" :
                      "bg-green-100/10 text-green-400"
                    }`}>
                      {f.status === "completed" ? "Completed" : f.status === "offered" ? "Not Accepted Yet" : "Accepted"}
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
        <button onClick={() => offerFeature(true)} disabled={offeringSaving}
          className="w-full py-2 text-sm bg-blue-600/20 text-blue-300 border border-blue-500/20 rounded-lg hover:bg-blue-600/30 transition-all disabled:opacity-50 flex items-center justify-center gap-2">
          {offeringSaving ? "Sending…" : "🎁 Send Free Feature"}
        </button>
        {!bizToken ? (
          <button onClick={onGenerateLink} disabled={generatingLink}
            className="w-full py-2 bg-white text-neutral-900 text-sm rounded-lg hover:bg-neutral-100 transition-all disabled:opacity-50 flex items-center justify-center gap-2">
            <Link className="w-4 h-4" />{generatingLink ? "Generating…" : "Generate Business Portal Link"}
          </button>
        ) : (
          <div className="flex gap-2">
            <a href={portalUrl!} target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 font-mono truncate flex-1">
              <ExternalLink className="w-3 h-3 shrink-0" />{`…?biz=${bizToken.slice(0, 10)}…`}
            </a>
            <button onClick={onCopyLink}
              className="px-3 py-1.5 text-xs bg-white/10 text-neutral-300 rounded-lg hover:bg-white/15 transition-all flex items-center gap-1 shrink-0">
              <Copy className="w-3 h-3" />{copiedId ? "Copied!" : "Copy Link"}
            </button>
          </div>
        )}
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
  const [isAuthenticated, setIsAuthenticated] = useState(!!adminToken);
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [adminTokenVerified, setAdminTokenVerified] = useState(false);
  const [tab, setTab] = useState<Tab>("creators");
  const [signups, setSignups] = useState<Signup[]>([]);
  const [businessSignups, setBusinessSignups] = useState<BusinessSignup[]>([]);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [pageViews, setPageViews] = useState<PageView[]>([]);
  const [stats, setStats] = useState<{ totalSignups: number; totalBusinessSignups: number } | null>(null);
  const [creatorLinks, setCreatorLinks] = useState<Record<string, string>>({});
  const [bizLinks, setBizLinks] = useState<Record<string, string>>({});
  const [approvedBusinesses, setApprovedBusinesses] = useState<Set<string>>(new Set());
  const [features, setFeatures] = useState<Feature[]>([]);
  const [claims, setClaims] = useState<Claim[]>([]);
  const [payoutRanges, setPayoutRanges] = useState<Record<string, string>>({});
  const [categories, setCategories] = useState<Record<string, string>>({});
  const [impersonatingId, setImpersonatingId] = useState<string | null>(null);
  const [approvingBiz, setApprovingBiz] = useState<string | null>(null);
  const [generatingBizLink, setGeneratingBizLink] = useState<string | null>(null);
  const [copiedBiz, setCopiedBiz] = useState<string | null>(null);
  const [approvingReel, setApprovingReel] = useState<string | null>(null);
  const [fetchingMetrics, setFetchingMetrics] = useState<string | null>(null);
  const [adminLink, setAdminLink] = useState("");
  const [copiedAdmin, setCopiedAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [planClicksMap, setPlanClicksMap] = useState<Record<string, number>>({});
  const [markingPaid, setMarkingPaid] = useState<string | null>(null);
  const [ambData, setAmbData] = useState<AmbassadorAdminData | null>(null);
  const [readyData, setReadyData] = useState<ReadinessData | null>(null);
  const [sendBusy, setSendBusy] = useState(false);
  const [sendResult, setSendResult] = useState("");
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
    setPasswordError("");
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

  useEffect(() => {
    if (adminToken) {
      // Verify admin private link token
      apiFetch(`/admin/verify?token=${adminToken}`).then((r) => r.json()).then((d) => {
        if (d.valid) {
          // The private link doubles as the session token for later admin calls.
          sessionStorage.setItem("analytics_token", adminToken);
          setIsAuthenticated(true);
          setAdminTokenVerified(true);
        }
      });
    } else {
      setIsAuthenticated(!!sessionStorage.getItem("analytics_token"));
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
      const [statsRes, signupsRes, bizRes, subsRes, linksRes, bizLinksRes, featuresRows, claimsRes, payoutRes] = await Promise.all([
        apiFetch("/analytics/stats"),
        apiFetch("/signups"),
        apiFetch("/business-signups"),
        apiFetch("/admin/submissions"),
        apiFetch("/creator-links"),
        apiFetch("/business-links"),
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
      if (bizLinksRes.ok) { const d = await bizLinksRes.json(); setBizLinks(d.links || {}); }
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
      }
    } catch { /* button returns to idle below */ }
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
  const generateBizLink = async (id: string) => {
    setGeneratingBizLink(id);
    const res = await apiFetch(`/business-links/${id}`, { method: "POST" });
    const d = await res.json();
    if (res.ok) setBizLinks((p) => ({ ...p, [id]: d.token }));
    setGeneratingBizLink(null);
  };
  const copyBizLink = (token: string, id: string) => {
    navigator.clipboard.writeText(`${window.location.origin}?biz=${token}`);
    setCopiedBiz(id); setTimeout(() => setCopiedBiz(null), 2000);
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

  if (!isAuthenticated) {
    return (
      <div className="fixed inset-0 bg-neutral-950/80 backdrop-blur-md z-[9999] flex items-center justify-center px-6" onClick={() => (window.location.hash = "")}>
        <div className="max-w-sm w-full bg-neutral-900 rounded-2xl shadow-2xl border border-white/10 p-8" onClick={(e) => e.stopPropagation()}>
          <h2 className="text-3xl font-bold text-white mb-6 text-center">Analytics</h2>
          <form onSubmit={handleLogin} className="space-y-3">
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              className="w-full px-4 py-3 bg-neutral-800 border border-white/20 text-white placeholder:text-neutral-500 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/30"
              placeholder="Password" required />
            {passwordError && <p className="text-red-400 text-sm">{passwordError}</p>}
            <button type="submit" className="w-full px-4 py-3 bg-white text-neutral-900 rounded-lg hover:bg-neutral-100 transition-all">Login</button>
          </form>
        </div>
      </div>
    );
  }

  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: "creators", label: "Creators", count: signups.length },
    { key: "businesses", label: "Businesses", count: businessSignups.length },
    { key: "reels", label: "Submitted Reels", count: submissions.length },
    { key: "ambassadors", label: "Ambassadors", count: ambData?.overview.totalAmbassadors },
    { key: "readiness", label: "Creator Readiness", count: readyData?.funnel.confirmed },
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
                    bizToken={bizLinks[b.id]}
                    approved={approvedBusinesses.has(b.id)}
                    payoutRange={payoutRanges[b.id] || ""}
                    setPayoutRange={(v: string) => setPayoutRanges((p) => ({ ...p, [b.id]: v }))}
                    category={categories[b.id] || ""}
                    setCategory={(v: string) => setCategories((p) => ({ ...p, [b.id]: v }))}
                    onApprove={(cat?: string, payout?: string, fid?: string, notes?: string) => approveBusiness(b.id, cat, payout, fid, notes)}
                    onGenerateLink={() => generateBizLink(b.id)}
                    onCopyLink={() => copyBizLink(bizLinks[b.id], b.id)}
                    approving={approvingBiz === b.id}
                    generatingLink={generatingBizLink === b.id}
                    copiedId={copiedBiz === b.id}
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
                <CreatorReadiness data={readyData} onSend={sendVerification} busy={sendBusy} />
              </div>
            : <p className="text-neutral-400 text-sm">Loading readiness…</p>
        )}
      </div>
    </div>
  );
}
