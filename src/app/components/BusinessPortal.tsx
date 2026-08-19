import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { ExternalLink, CheckCircle, AlertCircle, Star, ThumbsUp, ThumbsDown, ArrowRight, Film, ChevronDown,
         MapPin, Mail, Instagram, CalendarDays, Clock, TrendingUp } from "lucide-react";
import { projectId, publicAnonKey } from "/utils/supabase/info";
import { countQuotaUsed, countOpenOffers, quotaLimit, quotaRemaining, openRequestSlots } from "../lib/featureQuota";

const BASE = `https://${projectId}.supabase.co/functions/v1/make-server-f5961d0c`;
const AUTH = { Authorization: `Bearer ${publicAnonKey}` };

function BlurredCreatorHandle({ username }: { username: string }) {
  const clean = (username || "creator").replace(/^@+/, "");
  if (!clean) return <span className="text-white font-mono">@creator</span>;
  return (
    <span className="font-mono text-white">
      @{clean[0]}<span className="blur select-none" style={{ filter: "blur(5px)" }}>{clean.slice(1)}</span>
    </span>
  );
}

function CreatorSubmissionCard({ label, date, badge, badgeColor, dim }: {
  label?: React.ReactNode; date?: string; badge: string; badgeColor: string; dim?: boolean;
}) {
  return (
    <div className={`bg-white/5 border border-white/10 rounded-2xl px-5 py-4 flex items-center justify-between gap-3 ${dim ? "opacity-40" : ""}`}>
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-neutral-800 flex items-center justify-center shrink-0 text-neutral-500">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
          </svg>
        </div>
        <div>
          {label && <div className="text-sm font-semibold">{label}</div>}
          {date && <p className="text-xs text-neutral-500">{date}</p>}
        </div>
      </div>
      <span className={`text-xs px-2.5 py-1 rounded-full border shrink-0 ${badgeColor}`}>{badge}</span>
    </div>
  );
}

interface Reel {
  id: string; featureId?: string;
  creatorInstagram: string; reelUrl: string; approvedAt: string; submittedAt?: string;
  metrics?: { thumbnail?: string; author?: string; authorUrl?: string };
  businessFeedback?: { reaction: "approve" | "report"; note?: string; submittedAt: string };
}
interface RequestingCreator { featureId: string; instagram: string; requestedAt: string; }
interface InProgressCreator { featureId: string; instagram: string; approvedAt: string; expiresAt: string; }
interface PublishedFeature { id: string; category: string; payoutRange: string; status: string; approvedAt?: string; businessNotes?: string; isTrial?: boolean; isOneOff?: boolean; requestNotes?: string; submittedByBusiness?: boolean; }
interface BizData {
  businessName: string; city: string; address?: string; instagram?: string; email?: string;
  reels: Reel[]; requestingCreators: RequestingCreator[]; inProgressCreators: InProgressCreator[];
  publishedFeatures: PublishedFeature[]; reelsLimit?: number; subscriptionTier?: string;
  planClicks?: number;
}

// Founder pricing. originalPrice is held at a consistent 40% discount — the
// same ratio the previous prices used — so the strike-through stays honest.
// Founder pricing. Each tier adds a new *kind* of value rather than just more
// volume — choice and priority at Growth, then content rights and strategy at
// Pro — and perCreator makes the falling unit price explicit, since that is the
// clearest reason to move up a tier.
const PLANS = [
  {
    icon: "🌱", name: "Starter", price: "$69", originalPrice: "$115", tag: null,
    perCreator: "$69 per creator",
    tagline: "Prove it works. One local creator, one reel, real neighbourhood reach.",
    features: [
      "1 Creator/month, filmed and posted for you",
      "Collab post — lives on your profile like organic content",
      "Location + business tagged for nearby customers",
      "Performance dashboard",
    ],
    cta: "Get Your First Reel",
    ctaStyle: "bg-neutral-800 text-white hover:bg-neutral-700 border border-white/10",
  },
  {
    icon: "⭐", name: "Growth", price: "$119", originalPrice: "$199", tag: "Most Popular",
    perCreator: "$60 per creator — save $19/mo",
    tagline: "Two creators, two separate audiences. Twice the people discovering you.",
    features: [
      "2 Different Creators/month, each with their own following",
      "Fresh content every 2 weeks instead of once a month",
      "Two creator styles — reach foodies and lifestyle crowds",
      "Priority matching — your features get filled first",
      "Everything in Starter",
    ],
    cta: "Get Started",
    ctaStyle: "bg-white text-neutral-900 hover:bg-neutral-100",
  },
  {
    icon: "🔥", name: "Pro", price: "$199", originalPrice: "$329", tag: null,
    perCreator: "$50 per creator — save $77/mo",
    tagline: "A new creator every week. Your business stays in the feed all month.",
    features: [
      "4 Different Creators/month — a new reel every week",
      "Four separate local audiences seeing you each month",
      "Time content to new menu items, events, and seasons",
      "Rotating roster — your audience keeps seeing new faces",
      "Direct line to the CONTYNT team",
      "Everything in Starter + Growth",
    ],
    cta: "Get Started",
    ctaStyle: "bg-neutral-800 text-white hover:bg-neutral-700 border border-white/10",
  },
];

// Sits beneath the subscription plans — deliberately secondary styling.
const ONE_OFF = {
  name: "One-Time Feature",
  price: "$89",
  description: "Receive one professionally created Reel from a local CONTYNT creator.",
  note: "No subscription. Starter gets you the same reel every month for $69.",
  cta: "Buy One Feature",
};

const FAQ_ITEMS = [
  { q: "Who films the content?", a: "Our vetted local creators who already love spots like yours. You approve nothing, ship nothing, and edit nothing. They film, post, and tag you." },
  { q: "How much of my time does this take?", a: "Almost none. After a quick setup, we handle creator matching, scheduling, and posting. Content simply shows up on Instagram with your business tagged." },
  { q: "What if I want a specific vibe?", a: "Let us know what the creator should focus on when submitting a request. We match creators whose style fits your brand and rotate in new ones as you grow." },
  { q: "Can I cancel?", a: "Anytime. No contracts, no minimums." },
];

function ReelCard({ reel, onFeedback }: { reel: Reel; onFeedback: (id: string, reaction: "approve" | "report", note?: string) => void }) {
  const [showReportField, setShowReportField] = useState(false);
  const [reportNote, setReportNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const feedback = reel.businessFeedback;

  const handleFeedback = async (reaction: "approve" | "report", note?: string) => {
    setSubmitting(true);
    await onFeedback(reel.id, reaction, note);
    setSubmitting(false);
    setShowReportField(false);
  };

  return (
    <div className="bg-white/5 border border-white/10 rounded-2xl overflow-hidden">
      {reel.metrics?.thumbnail ? (
        <a href={reel.reelUrl} target="_blank" rel="noopener noreferrer">
          <img src={reel.metrics.thumbnail} alt="Reel thumbnail" className="w-full object-cover max-h-36" />
        </a>
      ) : reel.reelUrl ? (
        <a href={reel.reelUrl} target="_blank" rel="noopener noreferrer"
          className="flex items-center gap-3 w-full px-5 py-4 bg-neutral-800/80 hover:bg-neutral-700/80 transition-colors group">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center shrink-0">
            <ExternalLink className="w-4 h-4 text-white" />
          </div>
          <div className="min-w-0">
            <p className="text-xs font-semibold text-white group-hover:text-neutral-200">View Instagram Reel</p>
            <p className="text-xs text-neutral-500 truncate">{reel.reelUrl.replace(/https?:\/\/(www\.)?/, "")}</p>
          </div>
        </a>
      ) : null}
      <div className="p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="font-semibold text-white font-mono">@{(reel.creatorInstagram || "creator").replace(/^@+/, "")}</p>
            <p className="text-xs text-neutral-400 mt-0.5">
              {reel.approvedAt
                ? new Date(reel.approvedAt).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" })
                : reel.submittedAt
                  ? new Date(reel.submittedAt).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" })
                  : "—"}
            </p>
          </div>
          <span className="text-xs bg-green-500/15 text-green-400 border border-green-500/25 px-2.5 py-1 rounded-full shrink-0 flex items-center gap-1.5">
            <CheckCircle className="w-3 h-3" />Creator Verified Visit
          </span>
        </div>
        {feedback ? (
          <div className={`rounded-xl px-4 py-3 text-sm flex items-start gap-2 ${
            feedback.reaction === "approve"
              ? "bg-green-500/10 border border-green-500/20 text-green-400"
              : "bg-red-500/10 border border-red-500/20 text-red-400"
          }`}>
            {feedback.reaction === "approve" ? <ThumbsUp className="w-4 h-4 shrink-0 mt-0.5" /> : <ThumbsDown className="w-4 h-4 shrink-0 mt-0.5" />}
            <div>
              <p className="font-medium">{feedback.reaction === "approve" ? "You approved this Reel" : "Issue reported"}</p>
              {feedback.note && <p className="text-xs mt-0.5 opacity-80">{feedback.note}</p>}
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-neutral-500">How did this Reel look?</p>
            <div className="flex gap-2">
              <button onClick={() => handleFeedback("approve")} disabled={submitting}
                className="flex-1 py-2.5 bg-green-600/20 border border-green-500/30 text-green-400 text-sm rounded-xl hover:bg-green-600/30 transition-all disabled:opacity-50 flex items-center justify-center gap-2">
                <ThumbsUp className="w-4 h-4" />Approve
              </button>
              <button onClick={() => setShowReportField(v => !v)} disabled={submitting}
                className="flex-1 py-2.5 bg-red-500/10 border border-red-500/20 text-red-400 text-sm rounded-xl hover:bg-red-500/20 transition-all disabled:opacity-50 flex items-center justify-center gap-2">
                <ThumbsDown className="w-4 h-4" />Report Issue
              </button>
            </div>
            {showReportField && (
              <div className="space-y-2">
                <textarea value={reportNote} onChange={e => setReportNote(e.target.value)}
                  placeholder="Describe the issue…"
                  className="w-full px-3 py-2 text-sm bg-white/5 border border-white/15 rounded-xl text-white placeholder:text-neutral-500 focus:outline-none resize-none"
                  rows={2} />
                <button onClick={() => handleFeedback("report", reportNote)} disabled={!reportNote || submitting}
                  className="w-full py-2 bg-red-600 text-white text-sm rounded-xl hover:bg-red-700 transition-all disabled:opacity-50">
                  {submitting ? "Submitting…" : "Submit Report"}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function RequestSlotCard({ bizToken, reelsLeft, reelsLimit, onSubmitted }: {
  bizToken: string; reelsLeft: number; reelsLimit: number;
  onSubmitted: (newId: string, notes: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [requestNotes, setRequestNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    setSubmitting(true);
    const notesVal = requestNotes.trim() || "No specific requests, creator's choice";
    // The server creates the row (and owns the id) from the business the token
    // belongs to, so business_id can't be spoofed from the client.
    const res = await fetch(`${BASE}/business-portal/submit-feature`, {
      method: "POST", headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ bizToken, requestNotes: notesVal, isNewRequest: true }),
    }).catch(() => null);
    const newId = (await res?.json().catch(() => null))?.featureId || "";
    setSubmitting(false);
    setExpanded(false);
    if (newId) onSubmitted(newId, notesVal);
  };

  // Same weight as an offered FeatureNoteCard. Both are actionable rows, so an
  // open slot sitting between two offers should not read as dimmer.
  return (
    <div className="border rounded-2xl overflow-hidden transition-all cursor-pointer bg-white/8 border-white/20 hover:border-white/30"
      onClick={() => setExpanded(v => !v)}>
      {/* Same header structure as FeatureNoteCard -- dot, then icon and label --
          so an open slot and an offered feature read as one kind of row. */}
      <div className="px-5 py-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <span className="w-2.5 h-2.5 rounded-full shrink-0 bg-green-400 animate-pulse" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-purple-500/30 to-pink-500/30 border border-white/10 flex items-center justify-center shrink-0">
                <Film className="w-3.5 h-3.5 text-pink-300" />
              </div>
              <p className="text-sm font-semibold text-white">Reel</p>
            </div>
          </div>
        </div>
        <span className="text-xs bg-white/15 text-white border border-white/25 px-2.5 py-1 rounded-full shrink-0">Available</span>
      </div>
      {expanded && (
        <div className="px-5 pb-5 space-y-4 border-t border-white/10 pt-4" onClick={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()}>
          <p className="text-xs text-neutral-500">
            This will use <span className="text-white font-medium">1</span> of your <span className="text-white font-medium">{reelsLeft}</span> available Reels this month.
          </p>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-neutral-300">What should the creator focus on?</label>
            <textarea value={requestNotes} onChange={e => setRequestNotes(e.target.value)}
              placeholder="New brunch menu launching this month"
              rows={3}
              className="w-full px-3 py-2.5 text-sm bg-neutral-800 border border-white/15 rounded-xl text-white placeholder:text-neutral-500 focus:outline-none resize-none" />
            <p className="text-[11px] text-neutral-600">Optional — leave blank and we'll let the creator choose.</p>
          </div>
          <div className="flex justify-end">
            <button onClick={submit} disabled={submitting}
              className="w-10 h-10 flex items-center justify-center bg-white text-neutral-900 rounded-xl hover:bg-neutral-100 transition-all disabled:opacity-50">
              {submitting ? <span className="w-4 h-4 border-2 border-neutral-400 border-t-neutral-900 rounded-full animate-spin" /> : <ArrowRight className="w-5 h-5" />}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function FeatureNoteCard({ feature: f, bizPortalData: data, bizToken, onNoteSaved, onSubmitted }: {
  feature: PublishedFeature; bizPortalData: BizData; bizToken: string;
  onNoteSaved: (id: string, notes: string) => void; onSubmitted?: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [requestNotes, setRequestNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(f.submittedByBusiness || false);
  const hasInProgress = data.inProgressCreators?.some(c => c.featureId === f.id);
  const isCompleted = f.status === "completed";
  const isOffered = f.status === "offered";
  const isPending = f.status === "pending";
  const label = isCompleted ? "Completed" : isPending ? "Submitted" : hasInProgress ? "In Progress" : isOffered ? "Available" : "Live & Active";
  const dotColor = isCompleted ? "bg-green-400" : isPending ? "bg-yellow-400" : hasInProgress ? "bg-blue-400 animate-pulse" : isOffered ? "bg-green-400 animate-pulse" : "bg-blue-400 animate-pulse";
  const badgeColor = isCompleted ? "bg-green-500/15 text-green-400 border-green-500/25" : isPending ? "bg-yellow-500/15 text-yellow-400 border-yellow-500/25" : hasInProgress ? "bg-blue-500/15 text-blue-400 border-blue-500/25" : isOffered ? "bg-white/15 text-white border-white/25" : "bg-blue-500/15 text-blue-400 border-blue-500/25";
  // Includes one-off purchases, so a business with no tier but a bought
  // Reel still sees the allowance line.
  const totalReels = quotaLimit(data.reelsLimit || 0, data.publishedFeatures);
  // Derived, never stored: see the note in lib/featureQuota.
  const reelsLeft = quotaRemaining(data.reelsLimit || 0, data.publishedFeatures);

  const submitRequest = async () => {
    setSubmitting(true);
    // Server-side the update is scoped by business_id as well as feature id, so
    // one business cannot submit against another's feature.
    await fetch(`${BASE}/business-portal/submit-feature`, {
      method: "POST", headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({
        bizToken, featureId: f.id,
        requestNotes: requestNotes.trim() || "No specific requests, creator's choice",
      }),
    }).catch(() => {});
    setSubmitted(true);
    setExpanded(false);
    setSubmitting(false);
    onSubmitted?.(f.id);
  };

  return (
    <div className={`border rounded-2xl overflow-hidden cursor-pointer ${isOffered && !submitted ? "bg-white/8 border-white/20" : "bg-white/5 border-white/10"}`}
      onClick={isOffered && !submitted ? () => setExpanded(v => !v) : undefined}>
      <div className="px-5 py-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          {/* The dot means "this row needs you". Once the offer is accepted the
              card goes neutral and the dot goes with it, so a list of settled
              features does not keep signalling for attention. */}
          {isOffered && !submitted && <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${dotColor}`} />}
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-purple-500/30 to-pink-500/30 border border-white/10 flex items-center justify-center shrink-0">
                <Film className="w-3.5 h-3.5 text-pink-300" />
              </div>
              {/* Deliberately a fixed label. `category` is free text the admin
                  types for internal use ("Cafe", and worse), so it is not fit
                  for the business's own view of their features. The date below
                  and the status badge do the distinguishing. */}
              <p className="text-sm font-semibold text-white">Reel</p>
            </div>
            <p className="text-xs text-neutral-500">
              {!isOffered || submitted ? (f.approvedAt ? new Date(f.approvedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "") : ""}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {/* Gated on isTrial, not just isOffered. A one-time feature is a paid
              offer, so labelling it "Free Feature" told the business something
              untrue. Non-trial offers now fall through to the normal badge,
              which already had a "New Feature Available" branch for them. */}
          {isOffered && !submitted && f.isTrial ? (
            <span className="text-xs px-2.5 py-1 rounded-full border bg-green-500/15 text-green-300 border-green-500/30 font-medium"
              style={{ animation: "freeFeaturePulse 3s ease-in-out infinite" }}>
              🎁 Free Feature
            </span>
          ) : (
            <span className={`text-xs px-2.5 py-1 rounded-full border ${badgeColor}`}>{label}</span>
          )}
        </div>
      </div>

      {isOffered && !submitted && expanded && (
        <div className="px-5 pb-5 space-y-4 border-t border-white/10 pt-4" onClick={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()}>
          {f.isTrial ? (
            <p className="text-xs text-neutral-500">This is a free feature.</p>
          ) : totalReels > 0 ? (
            <p className="text-xs text-neutral-500">
              This will use <span className="text-white font-medium">1</span> of your <span className="text-white font-medium">{reelsLeft}</span> available Reels this month.
            </p>
          ) : null}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-neutral-300">What should the creator focus on?</label>
            <textarea value={requestNotes} onChange={e => setRequestNotes(e.target.value)}
              placeholder="New brunch menu launching this month"
              rows={3}
              className="w-full px-3 py-2.5 text-sm bg-neutral-800 border border-white/15 rounded-xl text-white placeholder:text-neutral-500 focus:outline-none resize-none" />
            <p className="text-[11px] text-neutral-600">Optional — leave blank and we'll let the creator choose.</p>
          </div>
          <div className="flex justify-end">
            <button onClick={e => { e.stopPropagation(); submitRequest(); }} disabled={submitting}
              className="w-10 h-10 flex items-center justify-center bg-white text-neutral-900 rounded-xl hover:bg-neutral-100 transition-all disabled:opacity-50">
              {submitting ? <span className="w-4 h-4 border-2 border-neutral-400 border-t-neutral-900 rounded-full animate-spin" /> : <ArrowRight className="w-5 h-5" />}
            </button>
          </div>
        </div>
      )}

      {(submitted || isPending) && (
        <div className="px-5 pb-4">
          <p className="text-xs text-neutral-500 bg-white/5 rounded-xl px-3 py-2">
            {requestNotes.trim() || f.requestNotes || "No specific requests, creator's choice"}
          </p>
        </div>
      )}
    </div>
  );
}

function PlanCard({ plan, featured }: { plan: typeof PLANS[0]; featured: boolean }) {
  return (
    <div className={`relative rounded-2xl p-6 flex flex-col gap-5 border h-full ${featured ? "bg-white/10 border-white/25 ring-1 ring-white/20" : "bg-white/5 border-white/10"}`}>
      {plan.tag && (
        <div className="absolute -top-4 left-1/2 -translate-x-1/2 z-10">
          <span className="bg-gradient-to-r from-yellow-400 to-amber-400 text-neutral-900 text-xs font-bold px-4 py-1.5 rounded-full flex items-center gap-1.5 shadow-lg whitespace-nowrap">
            <Star className="w-3 h-3" />{plan.tag}
          </span>
        </div>
      )}
      <div>
        <p className="text-2xl mb-1">{plan.icon}</p>
        <p className="text-lg font-bold text-white">{plan.name}</p>
        <div className="flex items-center gap-2 mt-1 flex-wrap">
          <span className="text-3xl font-bold text-white">{plan.price}</span>
          <span className="text-neutral-400 text-sm">/month</span>
          <span className="text-neutral-600 text-sm line-through">{plan.originalPrice}</span>
          <span className="text-xs bg-green-500/20 text-green-400 border border-green-500/30 px-1.5 py-0.5 rounded font-medium">40% off</span>
        </div>
        {/* Unit price — the upgrade argument, stated plainly. */}
        <p className="text-xs text-neutral-500 mt-1.5">{plan.perCreator}</p>
        <p className="text-sm text-neutral-400 mt-2">{plan.tagline}</p>
      </div>
      <ul className="space-y-2 flex-1">
        {plan.features.map((feat, i) => (
          <li key={i} className="flex items-start gap-2 text-sm text-neutral-300">
            <CheckCircle className="w-4 h-4 text-green-400 shrink-0 mt-0.5" />{feat}
          </li>
        ))}
      </ul>
      <button className={`w-full py-3 rounded-xl text-sm font-semibold transition-all ${plan.ctaStyle}`}>
        👉 {plan.cta}
      </button>
    </div>
  );
}

export function BusinessPortal({ token }: { token: string }) {
  const [data, setData] = useState<BizData | null>(null);

  // Named tab title, matching the creator portal. App.tsx's title effect never
  // runs on this route: it returns <BusinessPortal> before reaching it.
  useEffect(() => {
    document.title = data?.businessName
      ? `CONTYNT | ${data.businessName} · Business Portal`
      : "CONTYNT | Business Portal";
  }, [data?.businessName]);
  const [bizId, setBizId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const fakesKey = `contynt_biz_fakes_${token}`;
  const [visibleFakes, setVisibleFakes] = useState(() => {
    try { return parseInt(localStorage.getItem(fakesKey) || "0"); } catch { return 0; }
  });
  const [error, setError] = useState("");
  const [editingEmail, setEditingEmail] = useState(false);
  const [emailInput, setEmailInput] = useState("");
  const [plansExpanded, setPlansExpanded] = useState(false);
  const [expandedFaqs, setExpandedFaqs] = useState<Set<number>>(new Set());
  const [bizTab, setBizTab] = useState<"features" | "submissions">("features");
  const submissionsSeenKey = `contynt_biz_subs_seen_${token}`;
  const featuresSeenKey = `contynt_biz_feats_seen_${token}`;
  const [submissionsSeen, setSubmissionsSeen] = useState<number>(() => {
    try { return parseInt(localStorage.getItem(submissionsSeenKey) || "0"); } catch { return 0; }
  });
  const [featuresSeen, setFeaturesSeen] = useState<number>(() => {
    try { return parseInt(localStorage.getItem(featuresSeenKey) || "0"); } catch { return 0; }
  });
  const [refreshing, setRefreshing] = useState(false);
  const [resolvedBizId, setResolvedBizId] = useState<string>("");

  const TIER_LIMITS_BIZ: Record<string, number> = { Starter: 1, Growth: 2, Pro: 4, Scale: 8 };

  // One authenticated call replaces six PostgREST reads. The server scopes
  // every row to the business this token belongs to, so the portal can no
  // longer read another business's features or creators' submissions.
  const loadFeatures = async (_currentBizId?: string) => {
    const res = await fetch(`${BASE}/business-portal?t=${token}`, { headers: AUTH });
    if (!res.ok) throw new Error("Failed to load business portal");
    const json = await res.json();
    const publishedFeatures: PublishedFeature[] = (json.publishedFeatures || []).map((f: any) => ({
      id: f.id, category: f.category || "", payoutRange: f.payoutRange || "",
      status: f.status || "offered", approvedAt: f.approvedAt || null,
      businessNotes: f.businessNotes || "", isTrial: f.isTrial || false, isOneOff: f.isOneOff || false,
      requestNotes: f.requestNotes || "", submittedByBusiness: f.submittedByBusiness || false,
    }));
    const subscriptionTier: string | null = json.subscriptionTier || null;
    // Tier allowance only. One-off purchases are added on top by quotaLimit.
    const tierLimit = subscriptionTier ? (TIER_LIMITS_BIZ[subscriptionTier] || 0) : 0;
    // Derived from features rather than the stored counter, matching what the
    // portal displayed before.
    const completedFeatureIds = new Set(publishedFeatures.filter(f => f.status === "completed").map(f => f.id));
    const reels: Reel[] = (json.reels || []).map((s: any) => ({
      id: s.id, featureId: s.featureId,
      creatorInstagram: s.creatorInstagram, reelUrl: s.reelUrl, status: s.status,
      metrics: s.metrics || {}, businessFeedback: s.businessFeedback,
      approvedAt: s.approvedAt, submittedAt: s.submittedAt,
    }));
    const requestingCreators: RequestingCreator[] = json.requestingCreators || [];
    const inProgressCreators: InProgressCreator[] = (json.inProgressCreators || [])
      .filter((c: any) => !completedFeatureIds.has(c.featureId))
      .map((c: any) => ({ featureId: c.featureId, instagram: c.instagram || "", approvedAt: c.approvedAt || "", expiresAt: "" }));
    return {
      publishedFeatures, reelsLimit: tierLimit, subscriptionTier, reels,
      requestingCreators, inProgressCreators,
      address: json.address || "", instagram: json.instagram || "",
      email: json.email || "", planClicks: json.planClicks || 0,
      businessId: json.business?.businessId || "",
      businessName: json.business?.businessName || "",
      city: json.business?.city || "",
    };
  };

  const refreshFeatures = async () => {
    if (!resolvedBizId) return;
    setRefreshing(true);
    try {
      const result = await loadFeatures(resolvedBizId);
      setData(prev => prev ? { ...prev, ...result } : prev);
    } catch {}
    setRefreshing(false);
  };

  useEffect(() => {
    const load = async () => {
      try {
        const result = await loadFeatures();
        if (!result.businessId) { setError("Invalid link."); setLoading(false); return; }
        setResolvedBizId(result.businessId);
        setBizId(result.businessId);
        setData(result);
        setEmailInput(result.email || "");
      } catch { setError("Invalid or expired link."); }
      finally { setLoading(false); }
    };
    load();
  }, [token]);

  // Poll every 20s
  useEffect(() => {
    if (!resolvedBizId) return;
    const interval = setInterval(async () => {
      try {
        const result = await loadFeatures(resolvedBizId);
        setData(prev => prev ? { ...prev, ...result } : prev);
      } catch {}
    }, 20000);
    return () => clearInterval(interval);
  }, [resolvedBizId]);

  // Show fake pending cards 1 day after first creator is approved for a feature
  const fakesUnlockKey = `contynt_biz_fakes_unlock_${token}`;
  useEffect(() => {
    if (!data || visibleFakes >= 2) return;
    const hasApprovedCreator = data.inProgressCreators.length > 0;
    if (!hasApprovedCreator) return;
    // Record when we first detected an approved creator
    let unlockAt: number;
    try {
      const stored = localStorage.getItem(fakesUnlockKey);
      if (!stored) {
        unlockAt = Date.now() + 24 * 60 * 60 * 1000;
        localStorage.setItem(fakesUnlockKey, String(unlockAt));
      } else {
        unlockAt = parseInt(stored);
      }
    } catch { return; }
    if (Date.now() >= unlockAt) {
      setVisibleFakes(2);
      try { localStorage.setItem(fakesKey, "2"); } catch {}
    }
  }, [data?.inProgressCreators]);

  const saveEmail = async (newEmail: string) => {
    await fetch(`${BASE}/business-portal/update-email`, {
      method: "POST", headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ bizToken: token, email: newEmail }),
    }).catch(() => {});
    setData(prev => prev ? { ...prev, email: newEmail } : prev);
    setEditingEmail(false);
  };

  const handleFeedback = async (submissionId: string, reaction: "approve" | "report", note?: string) => {
    const now = new Date().toISOString();
    // The server records the feedback and, on approve, closes out the feature —
    // the client no longer writes either table itself.
    await fetch(`${BASE}/business-portal/feedback`, {
      method: "POST", headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ bizToken: token, submissionId, reaction, note }),
    }).catch(() => {});
    setData(prev => {
      if (!prev) return prev;
      const sub = prev.reels.find(r => r.id === submissionId);
      const featureId = sub?.featureId;
      return {
        ...prev,
        reels: prev.reels.map(r => r.id === submissionId
          ? { ...r, businessFeedback: { reaction, note: note || "", submittedAt: now } } : r),
        // Approving closes the feature server-side, so reflect that in Your
        // Features immediately instead of waiting for the next poll.
        publishedFeatures: reaction === "approve" && featureId
          ? prev.publishedFeatures.map(f => f.id === featureId ? { ...f, status: "completed" } : f)
          : prev.publishedFeatures,
        inProgressCreators: reaction === "approve" && featureId
          ? prev.inProgressCreators.filter(c => c.featureId !== featureId)
          : prev.inProgressCreators,
      };
    });
  };

  const toggleFaq = (i: number) => {
    setExpandedFaqs(prev => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-neutral-950 flex items-center justify-center">
        <div className="text-center">
          <p className="text-sm font-semibold tracking-[0.25em] text-white mb-4">C O N T Y N T</p>
          <div className="flex gap-1.5 justify-center">
            {[0, 1, 2].map(i => (
              <span key={i} className="w-1.5 h-1.5 bg-white/40 rounded-full animate-pulse" style={{ animationDelay: `${i * 0.2}s` }} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-neutral-950 flex items-center justify-center px-6">
        <div className="text-center max-w-sm">
          <AlertCircle className="w-10 h-10 text-red-400 mx-auto mb-4" />
          <h2 className="text-white text-xl font-semibold mb-2">Link unavailable</h2>
          <p className="text-neutral-400 text-sm">{error}</p>
        </div>
      </div>
    );
  }

  // Free offered features first, then rest
  const freeFeatures = data.publishedFeatures.filter(f => f.isTrial && f.status === "offered");
  // Order by how much the row still wants from the business, so anything
  // needing a decision sits above anything already running. The server returns
  // these newest-first, which interleaved live features with open offers.
  // Array.prototype.sort is stable, so newest-first is preserved within a rank.
  const FEATURE_ORDER: Record<string, number> = {
    offered: 0,    // needs the business to accept
    pending: 1,    // submitted, waiting on us to publish
    available: 2,  // Live & Active -- running, waiting on a creator
    completed: 3,  // done
  };
  const otherFeatures = data.publishedFeatures
    .filter(f => !(f.isTrial && f.status === "offered"))
    .slice()
    .sort((a, b) => (FEATURE_ORDER[a.status] ?? 9) - (FEATURE_ORDER[b.status] ?? 9));

  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      <style>{`@keyframes freeFeaturePulse { 0%,100%{opacity:1;box-shadow:0 0 4px rgba(74,222,128,0.2)} 50%{opacity:0.75;box-shadow:0 0 10px rgba(74,222,128,0.45)} }`}</style>
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute top-0 right-1/4 w-96 h-96 rounded-full" style={{ background: "radial-gradient(circle, rgba(99,102,241,0.06) 0%, transparent 70%)" }} />
        <div className="absolute bottom-0 left-1/4 w-80 h-80 rounded-full" style={{ background: "radial-gradient(circle, rgba(168,85,247,0.05) 0%, transparent 70%)" }} />
      </div>

      <header className="relative z-10 border-b border-white/10 px-6 py-4">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold tracking-[0.2em]">C O N T Y N T</span>
            <span className="text-[10px] font-bold tracking-widest text-yellow-400 border border-yellow-400/40 px-1.5 py-0.5 rounded">BETA</span>
          </div>
          <span className="text-xs text-neutral-500">Business Portal</span>
        </div>
      </header>

      <main className="relative z-10 max-w-3xl mx-auto px-4 sm:px-6 py-10 space-y-10">
        {/* Identity — a monogram anchors the card so the business, rather than
            the CONTYNT header, is what the eye lands on first. The meta used to
            stack as one field per line, which read like a raw record dump. */}
        <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-br from-white/[0.07] to-white/[0.02] px-5 py-5 sm:px-7 sm:py-6">
          <div className="absolute -top-16 -right-10 w-56 h-56 rounded-full pointer-events-none"
            style={{ background: "radial-gradient(circle, rgba(99,102,241,0.12) 0%, transparent 70%)" }} />
          <div className="relative flex items-start gap-4">
            <div className="shrink-0 w-14 h-14 rounded-2xl bg-gradient-to-br from-indigo-500/30 to-purple-500/20 border border-white/15 flex items-center justify-center">
              <span className="text-lg font-bold tracking-tight text-white">
                {data.businessName.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join("").toUpperCase() || "?"}
              </span>
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2.5 flex-wrap">
                <h1 className="text-2xl font-semibold leading-tight">{data.businessName}</h1>
                <div className="flex items-center gap-1.5 bg-green-500/15 border border-green-500/25 px-2.5 py-1 rounded-full shrink-0">
                  <div className="relative flex items-center justify-center w-2 h-2">
                    <span className="absolute w-2 h-2 rounded-full bg-green-400 animate-ping" />
                    <div className="w-2 h-2 rounded-full bg-green-400" />
                  </div>
                  <span className="text-xs font-medium text-green-400">Active</span>
                </div>
                {data.subscriptionTier && (
                  <span className="text-[11px] font-medium text-indigo-300 bg-indigo-500/15 border border-indigo-500/25 px-2 py-0.5 rounded-full shrink-0">
                    {data.subscriptionTier}
                  </span>
                )}
              </div>

              {/* Meta as inline chips — one wrapping row instead of four lines. */}
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                <span className="inline-flex items-start gap-1.5 text-sm text-neutral-400 min-w-0">
                  <MapPin className="w-3.5 h-3.5 shrink-0 text-neutral-500 mt-0.5" />
                  {/* Wraps rather than truncates: at 375px a truncated address
                      cut the city off, which is the part that matters most. */}
                  <span>{[data.address, data.city].filter(Boolean).join(" · ")}</span>
                </span>
                {data.instagram && (
                  <a href={`https://instagram.com/${data.instagram.replace(/^@/, "")}`} target="_blank" rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-sm text-blue-400 hover:text-blue-300 transition-colors">
                    <Instagram className="w-3.5 h-3.5 shrink-0" />
                    @{data.instagram.replace(/^@/, "")}
                  </a>
                )}
                {editingEmail ? (
                  <form onSubmit={e => { e.preventDefault(); saveEmail(emailInput); }} className="flex gap-2 items-center">
                    <input value={emailInput} onChange={e => setEmailInput(e.target.value)} type="email"
                      className="text-sm bg-white/10 border border-white/20 rounded-lg px-2 py-1 text-white placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-white/20"
                      placeholder="email@example.com" autoFocus />
                    <button type="submit" className="text-xs text-green-400 hover:text-green-300 font-medium">Save</button>
                    <button type="button" onClick={() => setEditingEmail(false)} className="text-xs text-neutral-500 hover:text-neutral-300">Cancel</button>
                  </form>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-sm text-neutral-400 min-w-0 group">
                    <Mail className="w-3.5 h-3.5 shrink-0 text-neutral-500" />
                    <span className="truncate">{data.email || "No email set"}</span>
                    <button onClick={() => { setEmailInput(data.email || ""); setEditingEmail(true); }}
                      className="text-[10px] text-neutral-500 hover:text-neutral-200 border border-white/10 hover:border-white/25 px-1.5 py-0.5 rounded transition-colors shrink-0">
                      Edit
                    </button>
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Stats — an icon per tile gives each number a scannable identity, and
            the estimate is set apart from the three measured counts so it does
            not read as something we actually recorded. */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: "Live Reels", value: data.reels.length, color: "text-green-400", ring: "bg-green-500/10 text-green-400", Icon: Film, estimated: false },
            { label: "This Month", value: data.reels.filter((r: any) => { const d = new Date(r.approvedAt || r.submittedAt); const now = new Date(); return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear(); }).length, color: "text-blue-400", ring: "bg-blue-500/10 text-blue-400", Icon: CalendarDays, estimated: false },
            // Everything the business has accepted that has not produced a Reel
            // yet: waiting on us to publish it ("pending") and published and
            // waiting on a creator ("available", shown as Live & Active).
            // "available" counted toward nothing before, so a published feature
            // was invisible in the stats. Unaccepted offers are excluded --
            // those are waiting on the business, not in progress.
            { label: "In Progress", value: (data.publishedFeatures?.filter(f => f.status === "pending" || f.status === "available").length || 0) + visibleFakes, color: "text-yellow-400", ring: "bg-yellow-500/10 text-yellow-400", Icon: Clock, estimated: false },
            { label: "Est. Reach", value: data.reels.length > 0 ? `${(data.reels.length * 2.4).toFixed(1)}k` : "—", color: "text-neutral-300", ring: "bg-white/5 text-neutral-500", Icon: TrendingUp, estimated: true },
          ].map(stat => (
            <div key={stat.label}
              className={`rounded-2xl p-4 border transition-colors ${
                stat.estimated
                  ? "bg-transparent border-dashed border-white/10"
                  : "bg-white/5 border-white/10 hover:border-white/20"
              }`}>
              <div className={`w-8 h-8 rounded-xl flex items-center justify-center mb-2.5 ${stat.ring}`}>
                <stat.Icon className="w-4 h-4" />
              </div>
              <p className={`text-2xl font-bold leading-none ${stat.color}`}>{stat.value}</p>
              <p className="text-xs text-neutral-500 mt-1.5">{stat.label}</p>
            </div>
          ))}
        </div>

        {/* Tabbed section */}
        {(data.reelsLimit! > 0 || data.publishedFeatures?.length > 0 || data.reels.length > 0 || (data.inProgressCreators?.length || 0) > 0 || (data.requestingCreators?.length || 0) > 0) && (() => {
          // Derived from the features themselves, so submitting a request
          // updates the quota purely by changing that feature's status. The
          // old stored counter was bumped by hand in three places and drifted.
          const totalReels = quotaLimit(data.reelsLimit || 0, data.publishedFeatures);
          const reelsUsedNow = countQuotaUsed(data.publishedFeatures);
          const reelsLeftNow = quotaRemaining(data.reelsLimit || 0, data.publishedFeatures);
          const openSlots = openRequestSlots(data.reelsLimit || 0, data.publishedFeatures);
          // The badge counts rows still waiting on the business -- unaccepted
          // offers plus open request slots -- so it falls as they are dealt
          // with, matching the dots. Settled features stay in the list but stop
          // being advertised on the tab.
          const actionableFeatures = countOpenOffers(data.publishedFeatures) + openSlots;
          const featuresUnread = actionableFeatures > featuresSeen;

          const submissionsTotal = data.reels.length + (data.inProgressCreators?.filter(rc => !data.reels.some(r => r.featureId === rc.featureId)).length || 0) + (data.requestingCreators?.length || 0) + visibleFakes;
          const unreviewedReels = data.reels.filter(r => !r.businessFeedback).length;
          const submissionsUnread = submissionsTotal > submissionsSeen;

          return (
          <section className="space-y-0">
            {/* Tab bar */}
            {/* flex-wrap so the refresh/quota group drops to its own line on
                narrow screens instead of overflowing off the right edge. */}
            <div className="flex flex-wrap items-center gap-y-2 border-b border-white/10 mb-4">
              {(["features", "submissions"] as const).map(tab => {
                const isActive = bizTab === tab;
                const count = tab === "features" ? actionableFeatures : submissionsTotal;
                const unread = tab === "features" ? featuresUnread : submissionsUnread;
                const label = tab === "features" ? "Your Features" : "Creator Submissions";
                return (
                  <button key={tab} onClick={() => {
                    setBizTab(tab);
                    if (tab === "submissions") {
                      setSubmissionsSeen(submissionsTotal);
                      try { localStorage.setItem(submissionsSeenKey, String(submissionsTotal)); } catch {}
                    } else {
                      setFeaturesSeen(actionableFeatures);
                      try { localStorage.setItem(featuresSeenKey, String(actionableFeatures)); } catch {}
                    }
                  }}
                    className={`relative px-3 sm:px-4 py-2.5 text-sm font-medium transition-all border-b-2 -mb-px flex items-center gap-2 whitespace-nowrap ${isActive ? "border-white text-white" : "border-transparent text-neutral-500 hover:text-neutral-300"}`}>
                    {label}
                    {count > 0 && (
                      <span className={`flex items-center justify-center min-w-[20px] h-5 px-1 rounded-full text-[10px] font-bold transition-all ${unread && !isActive ? "bg-green-400 text-neutral-900 animate-pulse" : "bg-white/15 text-neutral-300"}`}>
                        {count}
                      </span>
                    )}
                  </button>
                );
              })}
              <div className="w-full sm:w-auto sm:ml-auto flex items-center gap-3 pb-2 justify-end">
                <button onClick={refreshFeatures} disabled={refreshing}
                  className="text-xs text-neutral-500 hover:text-neutral-300 transition-colors flex items-center gap-1 disabled:opacity-40">
                  <svg className={`w-3 h-3 ${refreshing ? "animate-spin" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                  {refreshing ? "Updating…" : "Refresh"}
                </button>
                {totalReels > 0 ? (
                  <span className={`text-xs px-3 py-1 rounded-full border ${reelsUsedNow >= totalReels ? "bg-red-500/10 text-red-400 border-red-500/20" : "bg-white/5 text-neutral-400 border-white/10"}`}>
                    Available Reels: {reelsLeftNow} of {totalReels}
                  </span>
                ) : null}
              </div>
            </div>

            {/* Your Features tab */}
            {bizTab === "features" && <div className="space-y-3">
            {/* Free features first */}
            {freeFeatures.map(f => (
              <FeatureNoteCard key={f.id} feature={f} bizPortalData={data} bizToken={token}
                onNoteSaved={(id, notes) => setData(prev => prev ? {
                  ...prev, publishedFeatures: prev.publishedFeatures.map(pf => pf.id === id ? { ...pf, businessNotes: notes } : pf)
                } : prev)}
                onSubmitted={id => setData(prev => prev ? {
                  ...prev,
                  publishedFeatures: prev.publishedFeatures.map(pf => pf.id === id ? { ...pf, status: "pending", submittedByBusiness: true } : pf)
                } : prev)} />
            ))}
            {/* Request slots */}
            {Array.from({ length: openSlots }).map((_, i) => (
              <RequestSlotCard key={`slot-${i}`}
                bizToken={token}
                reelsLeft={reelsLeftNow}
                reelsLimit={data.reelsLimit || 0}
                onSubmitted={(newId, notes) => setData(prev => prev ? {
                  ...prev,
                  publishedFeatures: [...prev.publishedFeatures, {
                    id: newId, category: "", payoutRange: "", status: "pending",
                    submittedByBusiness: true, isTrial: false, requestNotes: notes,
                  }],
                } : prev)} />
            ))}
            {/* Other features */}
            {otherFeatures.map(f => (
              <FeatureNoteCard key={f.id} feature={f} bizPortalData={data} bizToken={token}
                onNoteSaved={(id, notes) => setData(prev => prev ? {
                  ...prev, publishedFeatures: prev.publishedFeatures.map(pf => pf.id === id ? { ...pf, businessNotes: notes } : pf)
                } : prev)}
                onSubmitted={id => setData(prev => prev ? {
                  ...prev,
                  publishedFeatures: prev.publishedFeatures.map(pf => pf.id === id ? { ...pf, status: "pending", submittedByBusiness: true } : pf)
                } : prev)} />
            ))}
            </div>}

            {/* Creator Submissions tab */}
            {bizTab === "submissions" && <div className="space-y-4">
          {data.reels.map(reel => (
            <div key={reel.id}>
              <ReelCard reel={reel} onFeedback={handleFeedback} />
            </div>
          ))}
          {data.inProgressCreators?.filter(rc => !data.reels.some(r => r.featureId === rc.featureId)).map((rc, n) => (
            <CreatorSubmissionCard key={`ip-${n}`}
              label={<BlurredCreatorHandle username={rc.instagram || "creator"} />}
              date="Working on Feature"
              badge="Pending"
              badgeColor="bg-yellow-500/15 text-yellow-400 border-yellow-500/25" />
          ))}
          {data.requestingCreators?.map((rc, n) => (
            <CreatorSubmissionCard key={`req-${n}`}
              label={<BlurredCreatorHandle username={rc.instagram || "creator"} />}
              date={`Requested · ${rc.requestedAt ? new Date(rc.requestedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "Recently"}`}
              badge="Pending"
              badgeColor="bg-neutral-700/50 text-neutral-400 border-neutral-700" />
          ))}
          {data.reels.length === 0 && (data.inProgressCreators?.length || 0) === 0 && (data.requestingCreators?.length || 0) === 0 && visibleFakes === 0 && (
            <div className="bg-white/5 border border-white/10 rounded-2xl px-6 py-8 text-center">
              <p className="text-2xl mb-3">🎬</p>
              <p className="text-sm font-medium text-neutral-300 mb-1">No submissions yet</p>
              <p className="text-xs text-neutral-500">Once a creator submits their Reel, it will appear here for your review.</p>
            </div>
          )}
          {["jasmine_vl", "marcus_ug"].map((name, n) =>
            visibleFakes > n ? (
              <div key={`fake-${n}`} style={{ animation: "fadeInUp 0.5s ease both" }}>
                <CreatorSubmissionCard
                  label={<BlurredCreatorHandle username={name} />}
                  date="In Review"
                  badge="Pending"
                  badgeColor="bg-yellow-500/15 text-yellow-400 border-yellow-500/25" />
              </div>
            ) : null
          )}
            </div>}
          </section>
          );
        })()}

        {/* Plan upsell — collapsible */}
        <section className="space-y-0">
          <button onClick={() => {
            const opening = !plansExpanded;
            setPlansExpanded(opening);
            if (opening) {
              // Optimistic bump; the server owns the authoritative increment.
              setData(prev => prev ? { ...prev, planClicks: (prev.planClicks || 0) + 1 } : prev);
              fetch(`${BASE}/business-portal/track-plan-click`, {
                method: "POST", headers: { ...AUTH, "Content-Type": "application/json" },
                body: JSON.stringify({ bizToken: token }),
              }).catch(() => {});
            }
          }}
            className="w-full flex items-center justify-center gap-4 bg-gradient-to-r from-blue-600/20 via-purple-600/20 to-blue-600/20 border border-blue-500/30 rounded-2xl px-6 py-5 hover:from-blue-600/30 hover:via-purple-600/30 hover:to-blue-600/30 hover:border-blue-500/50 transition-all text-center relative group">
            <div className="flex-1 text-center">
              <h2 className="text-lg font-bold text-white">Consistent Reels. Simple pricing.</h2>
              <p className="text-sm text-blue-300/80 mt-0.5">Founding partner plans start at {PLANS[0].price}/month.</p>
            </div>
            <ChevronDown className={`w-5 h-5 text-blue-400 shrink-0 transition-transform duration-300 ${plansExpanded ? "rotate-180" : ""}`} />
          </button>

          {plansExpanded && (
            <div className="pt-4 space-y-6">
              <p className="text-center text-xs text-neutral-400">🔒 Founding partner pricing — early adopters lock in 40% off for life!</p>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-stretch">
                {PLANS.map(plan => (
                  <div key={plan.name} className="flex flex-col">
                    <PlanCard plan={plan} featured={plan.name === "Growth"} />
                  </div>
                ))}
              </div>
              <p className="text-center text-xs text-neutral-500">Cancel anytime. No contracts.</p>

              {/* One-off purchase — secondary to the subscription plans above,
                  so it reuses the muted card styling rather than PlanCard. */}
              <div className="bg-white/5 border border-white/10 rounded-2xl px-5 py-4 flex flex-col sm:flex-row sm:items-center gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2">
                    <p className="text-sm font-semibold text-white">{ONE_OFF.name}</p>
                    <span className="text-sm font-semibold text-white">{ONE_OFF.price}</span>
                  </div>
                  <p className="text-xs text-neutral-400 mt-1 leading-relaxed">{ONE_OFF.description}</p>
                  {/* One-off costs more than a month of Starter — say so, so the
                      cheaper subscription reads as the obvious choice. */}
                  <p className="text-[11px] text-neutral-500 mt-1.5">{ONE_OFF.note}</p>
                </div>
                <button
                  className="shrink-0 px-4 py-2.5 text-sm font-medium rounded-xl bg-neutral-800 text-white border border-white/10 hover:bg-neutral-700 transition-all">
                  {ONE_OFF.cta}
                </button>
              </div>

              {/* FAQ — collapsible */}
              <div className="space-y-2">
                <p className="text-xs font-semibold text-neutral-500 uppercase tracking-widest">Questions</p>
                {FAQ_ITEMS.map((item, i) => (
                  <div key={i} className="border border-white/10 rounded-xl overflow-hidden">
                    <button onClick={() => toggleFaq(i)}
                      className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-white/5 transition-all">
                      <p className="text-sm font-medium text-white">{item.q}</p>
                      <ChevronDown className={`w-4 h-4 text-neutral-500 shrink-0 transition-transform duration-200 ${expandedFaqs.has(i) ? "rotate-180" : ""}`} />
                    </button>
                    {expandedFaqs.has(i) && (
                      <div className="px-4 pb-3 border-t border-white/10 pt-3">
                        <p className="text-xs text-neutral-400 leading-relaxed">{item.a}</p>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      </main>

      <footer className="relative z-10 border-t border-white/10 mt-10 px-6 py-8">
        <div className="max-w-3xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <span className="text-sm font-semibold tracking-[0.2em] text-white">C O N T Y N T</span>
          <p className="text-xs text-neutral-500 text-center">
            Questions or feedback?{" "}
            <a href="mailto:team@getcontynt.com" className="text-neutral-400 hover:text-white transition-colors underline underline-offset-2">
              team@getcontynt.com
            </a>
          </p>
          <p className="text-xs text-neutral-600">© {new Date().getFullYear()} Contynt</p>
        </div>
      </footer>
    </div>
  );
}
