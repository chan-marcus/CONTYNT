import { useEffect, useState, useRef, useLayoutEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { MapPin, DollarSign, CheckCircle, X, ExternalLink, AlertCircle, Users, Zap, TrendingUp, Award, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { projectId, publicAnonKey } from "/utils/supabase/info";
import { CreatorLogin, CREATOR_TOKEN_KEY } from "./CreatorLogin";
import { FeaturesMap } from "./FeaturesMap";
import { AmbassadorPanel, AmbassadorUpsell, AmbassadorEmptyState, useAmbassador,
         AmbassadorFeatureActions, HandoffQuestion } from "./Ambassador";

const BASE = `https://${projectId}.supabase.co/functions/v1/make-server-f5961d0c`;
const AUTH = { Authorization: `Bearer ${publicAnonKey}`, "Content-Type": "application/json" };
const api = (path: string, opts?: RequestInit) => fetch(`${BASE}${path}`, { ...opts, headers: { ...AUTH, ...(opts?.headers ?? {}) } });

interface Feature {
  id: string;
  businessName: string;
  address: string;
  city: string;
  category: string;
  payoutRange: string;
  status: "available" | "completed";
  adminNotes?: string;
  // The business's Google place_id, when it has one. Only the map reads it.
  placeId?: string | null;
}

interface Claim { featureId: string; status: "interested" | "admin_approved" | "claimed" | "submitted" | "approved" | "cashed_out" | "denied"; reelUrl?: string; stripeLink?: string; payoutAmount?: string; deniedNote?: string; approvedAt?: string; expiresAt?: string; acceptanceExpiresAt?: string; }
interface PayoutInfo { stripeLink: string; payoutAmount: string; submissionId: string; }
interface Payout {
  id: string; amount: number; method: string; handle: string;
  status: string; requestedAt: string; paidAt?: string | null;
  notReceivedAt?: string | null; issueResolvedAt?: string | null;
}

interface PortalStats {
  completed: number; activeClaims: number; totalPayout: number; creatorScore?: number;
  availableEarnings?: number; pendingEarnings?: number;
  lifetimeEarned?: number; lifetimePaid?: number;
}

// Order of the claim cards in the Features tab: soonest deadline and anything
// needing the creator to act comes first, then the ones merely waiting on us.
const CLAIM_TAB_ORDER: Record<string, number> = {
  admin_approved: 0, // accept within 24h or lose it
  claimed: 1,        // filming, on a 5 day clock
  denied: 2,         // needs another Reel
  submitted: 3,      // under review, nothing for them to do
  interested: 4,     // requested, waiting to be accepted
};

// Seed activity for the Activity tab, until real claims fill it.
//
// Invented venues on purpose. The first two entries here named real San
// Francisco businesses, one of which is in the signups table with a Feature
// that is available right now -- so the same creator could see it offered on
// one tab and already claimed on another. Made-up names cannot contradict the
// real board, and cannot say anything about a business that could object to it.
// The five that always sit at the top, dated today. Page one is fixed rather
// than generated: it is the first thing anyone sees, so it should be the same
// five every time rather than whatever the day's seed happened to draw.
//
// The first two are the original hand-written entries, restored at Marcus's
// request. Note Maxfield's is a real business in the signups table with a
// Feature that is currently available, so it can appear as claimed here and
// open on the Features tab at the same time.
const PINNED_ACTIVITY = [
  { businessName: "Maxfield's House of Caffeine", category: "Coffee Shop", payout: "$15\u2013$25", by: "sarahv" },
  { businessName: "Duboce Park Cafe",             category: "Cafe",        payout: "$10\u2013$20", by: "mikec" },
  { businessName: "Mission Slice Pizzeria",       category: "Pizza",       payout: "$20\u2013$30", by: "dmoreno" },
  { businessName: "Hayes Valley Bakehouse",       category: "Bakery",      payout: "$15\u2013$25", by: "elliek" },
  { businessName: "Sunset Ramen House",           category: "Ramen",       payout: "$20\u2013$35", by: "jtnguyen" },
];

const ACTIVITY_POOL = [
  { businessName: "Golden Gate Grind",      category: "Coffee Shop", payout: "$15\u2013$25", by: "sarahv" },
  { businessName: "Mission Slice Pizzeria", category: "Pizza",       payout: "$20\u2013$30", by: "dmoreno" },
  { businessName: "Hayes Valley Bakehouse", category: "Bakery",      payout: "$15\u2013$25", by: "elliek" },
  { businessName: "Sunset Ramen House",     category: "Ramen",       payout: "$20\u2013$35", by: "jtnguyen" },
  { businessName: "Noe Valley Creamery",    category: "Ice Cream",   payout: "$10\u2013$20", by: "priyaeats" },
  { businessName: "Presidio Poke Co.",      category: "Poke",        payout: "$15\u2013$25", by: "marcusleeee" },
  { businessName: "Marina Green Juice",     category: "Juice Bar",   payout: "$10\u2013$18", by: "sofiafit" },
  { businessName: "Castro Corner Taqueria", category: "Mexican",     payout: "$20\u2013$30", by: "andresq" },
  { businessName: "Richmond Dim Sum Bar",   category: "Dim Sum",     payout: "$25\u2013$40", by: "winnielam" },
  { businessName: "Potrero Hill Roasters",  category: "Coffee Shop", payout: "$15\u2013$25", by: "tbrooks" },
  { businessName: "SoMa Sandwich Shop",     category: "Sandwiches",  payout: "$15\u2013$25", by: "kaylajm" },
  { businessName: "North Beach Trattoria",  category: "Italian",     payout: "$25\u2013$40", by: "gcastillo" },
  { businessName: "Inner Sunset Boba",      category: "Boba",        payout: "$10\u2013$18", by: "amyxu" },
  { businessName: "Bernal Heights Brunch",  category: "Brunch",      payout: "$20\u2013$30", by: "reneewalks" },
  { businessName: "Dogpatch Donut Club",    category: "Donuts",      payout: "$10\u2013$20", by: "chrisdoesfood" },
  { businessName: "Cole Valley Wine Bar",   category: "Wine Bar",    payout: "$25\u2013$40", by: "linhtastes" },
  { businessName: "Outer Sunset Surf Cafe", category: "Cafe",        payout: "$15\u2013$25", by: "noahsf" },
  { businessName: "Japantown Curry Bar",    category: "Japanese",    payout: "$20\u2013$30", by: "yukiplates" },
  { businessName: "Fillmore Smoothie Lab",  category: "Smoothies",   payout: "$10\u2013$18", by: "bkrishnan" },
  { businessName: "Glen Park Deli",         category: "Deli",        payout: "$15\u2013$25", by: "omarbites" },
  { businessName: "Embarcadero Oyster Bar", category: "Seafood",     payout: "$25\u2013$40", by: "hannahsea" },
];

// mulberry32. Seeded per day so the feed is identical on every reload and for
// every viewer: a list that reshuffles when you refresh reads as generated the
// second anybody looks twice, which is the opposite of what this is for.
function seededRandom(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY_MS = 86400000;
// Morning, midday, evening. Three windows rather than three fixed times, and
// nothing overnight: claims landing at 04:12 every day is the tell.
const ACTIVITY_WINDOWS: [number, number][] = [[9, 12], [13, 16], [18, 22]];

// Builds the feed between `startTs` and `now`. Two to four a day, drawn from
// the windows above, because exactly three every single day is its own kind of
// obviously-generated.
//
// startTs is the rollout switch and the pace control at once. Nothing before it
// is generated, so the day it is set the tab holds two or three entries and
// fills out over the following week -- rather than twenty backdated claims
// appearing at once in a tab that was empty a second earlier, which is the
// version nobody believes. Zero means off, and off is the default.
// The pinned five, stamped across today and newest first.
//
// Spread back from now rather than at fixed clock times, so they read as recent
// whenever the tab is opened and none of them is ever stamped in the future.
// The floor of nine hours is for the small hours: five entries landing within
// twenty minutes of each other at 00:20 reads as one burst, not as a day.
function pinnedActivity(now: number) {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const span = Math.max(now - midnight.getTime(), 9 * 3600000);
  return PINNED_ACTIVITY.map((p, i) => ({
    id: `pin_${i}`,
    businessName: p.businessName,
    address: "",
    city: "San Francisco, CA",
    category: p.category,
    payoutRange: p.payout,
    status: "completed" as const,
    claimedBy: p.by,
    claimedAt: now - Math.round(span * (0.06 + i * 0.21)),
  }));
}

function buildActivityFeed(now: number, startTs: number, days = 14) {
  if (!startTs) return [];
  // Page one is the pinned five and only those. Generated entries are held to
  // strictly older than the oldest pinned one rather than merged by timestamp:
  // interleaved, a rotation entry from an hour ago landed second and pushed a
  // pinned one onto page two. Cutting by time rather than by count also keeps
  // the whole feed in order, so the timestamps still count down the page.
  const pinned = pinnedActivity(now);
  const pinnedFloor = pinned[pinned.length - 1].claimedAt;
  const out: { id: string; businessName: string; address: string; city: string;
               category: string; payoutRange: string; status: "completed";
               claimedBy: string; claimedAt: number }[] = [];

  for (let d = days; d >= 0; d--) {
    // Local midnight, walked back a day at a time. Building these off UTC put
    // every entry at 3am and 4am on screen for anyone west of Greenwich, which
    // is the one thing the windows above exist to prevent. setDate rather than
    // subtracting 86400000 so a clock change does not shift the whole feed.
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    dayStart.setDate(dayStart.getDate() - d);
    const day = Math.floor(dayStart.getTime() / DAY_MS);
    const rnd = seededRandom(day);
    const perDay = 2 + Math.floor(rnd() * 3);          // 2, 3 or 4
    const windows = ACTIVITY_WINDOWS.slice(0, perDay === 2 ? 2 : 3);

    for (let i = 0; i < perDay; i++) {
      const [from, to] = windows[i % windows.length];
      const hour = from + rnd() * (to - from);
      const at = dayStart.getTime() + hour * 3600000;
      if (at >= pinnedFloor) continue;
      // Offset by the day so consecutive days do not walk the pool in lockstep
      // and repeat the same venue at the same time each week.
      const pick = ACTIVITY_POOL[(day * 7 + i * 3 + Math.floor(rnd() * 5)) % ACTIVITY_POOL.length];
      out.push({
        id: `seed_${day}_${i}`,
        businessName: pick.businessName,
        address: "",
        city: "San Francisco, CA",
        category: pick.category,
        payoutRange: pick.payout,
        status: "completed",
        claimedBy: pick.by,
        claimedAt: at,
      });
    }
  }
  // Newest first, then one entry per venue. Paging made the repeats visible:
  // the pool is 22 and the feed wanted 20, so the same venue turned up on page
  // one and page four -- with the same handle both times, since the pool pairs
  // them. One person claiming one cafe twice in a week is not a busy market, it
  // reads as a bug. Keeping the newest of each is what a real feed would show.
  const seen = new Set<string>();
  // Pinned first, so when a pinned venue also comes up in the rotation the
  // dedupe below keeps the pinned one.
  const all = [...pinned, ...out]
    .sort((a, b) => b.claimedAt - a.claimedAt)
    .filter(e => !seen.has(e.businessName) && seen.add(e.businessName));

  // The ramp: only what has happened since the start date, so the feed grows a
  // few entries a day rather than arriving complete.
  const sinceStart = all.filter(e => e.claimedAt >= startTs);

  // With a floor of one full page. On the first day the ramp alone yields one
  // or two cards, which reads worse than nothing -- a tab with two entries and
  // a page counter under them looks broken rather than new. Below the page
  // size, the most recent entries from before the start date top it up.
  const MIN_VISIBLE = 5;
  return (sinceStart.length >= MIN_VISIBLE ? sinceStart : all.slice(0, MIN_VISIBLE)).slice(0, 20);
}

function formatPayout(range: string): string {
  if (!range) return "";
  const match = range.match(/\$?(\d+)\s*[–\-]\s*\$?(\d+)/);
  if (match) return `$${match[1]} - $${match[2]}`;
  // Single value — ensure $ prefix
  const num = range.replace(/[^0-9.]/g, "");
  return num ? `$${num}` : range;
}

function BlurredName({ name }: { name: string }) {
  return (
    <span className="inline-flex items-center gap-0">
      {name[0]}
      <span
        className="select-none rounded px-0.5"
        style={{ filter: "blur(6px)", background: "rgba(255,255,255,0.10)", letterSpacing: "0.05em" }}
      >
        {name.slice(1).length > 0 ? name.slice(1) : "•••••"}
      </span>
    </span>
  );
}

function BlurredHandle({ username }: { username: string }) {
  const clean = username.replace(/^@+/, "");
  return (
    <span className="font-mono inline-flex items-center gap-0">
      @{clean[0]}
      <span
        className="select-none rounded px-0.5"
        style={{ filter: "blur(6px)", background: "rgba(255,255,255,0.15)", letterSpacing: "0.05em" }}
      >
        {clean.slice(1).length > 0 ? clean.slice(1) : "•••••"}
      </span>
    </span>
  );
}

// ─── Viewer count — 0-20, off-hours aware (no updates midnight–6am) ──────────
function CountdownTimer({ expiresAt, compact }: { expiresAt: string; compact?: boolean }) {
  const calc = () => {
    const diff = new Date(expiresAt).getTime() - Date.now();
    if (diff <= 0) return null;
    const d = Math.floor(diff / 86400000);
    const h = Math.floor((diff % 86400000) / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    return { diff, d, h, m, s };
  };
  const [t, setT] = useState(calc);
  useEffect(() => {
    const i = setInterval(() => setT(calc()), 1000);
    return () => clearInterval(i);
  }, [expiresAt]);
  if (!t) return <span className="text-xs text-red-400 font-medium animate-pulse">Expired</span>;
  const hoursLeft = t.diff / 3600000;
  const color = hoursLeft <= 12 ? "text-red-400 animate-pulse" : hoursLeft <= 24 ? "text-orange-400" : "text-neutral-300";
  return (
    <div className={`text-xs font-mono text-center ${color}`}>
      {compact
        ? `${String(t.h + t.d * 24).padStart(2,"0")}h ${String(t.m).padStart(2,"0")}m ${String(t.s).padStart(2,"0")}s`
        : `${t.d}d ${String(t.h).padStart(2,"0")}h ${String(t.m).padStart(2,"0")}m ${String(t.s).padStart(2,"0")}s`
      }
      {!compact && hoursLeft <= 24 && <span className="ml-1 font-sans not-italic">{hoursLeft <= 12 ? "⚠ Expires soon!" : "— Complete before it expires"}</span>}
    </div>
  );
}

function useViewerCount(featureId: string) {
  const [count, setCount] = useState(() => {
    let hash = 0;
    for (const ch of featureId) hash = ((hash << 5) - hash) + ch.charCodeAt(0);
    const base = 4 + (Math.abs(hash) % 12); // 4–15
    try {
      const vk = `contynt_views_${featureId}`;
      const visits = parseInt(localStorage.getItem(vk) || "0") + 1;
      localStorage.setItem(vk, String(visits));
      const shift = Math.floor(visits / 5) % 5 - 2;
      return Math.max(0, Math.min(20, base + shift));
    } catch { return base; }
  });
  const intervalRef = useRef<any>(null);
  useEffect(() => {
    const tick = () => {
      const hour = new Date().getHours();
      const isOffHours = hour >= 0 && hour < 6;
      if (!isOffHours) {
        setCount(c => {
          const r = Math.random();
          if (r < 0.35) return Math.max(0, c - 1);
          if (r < 0.55) return Math.min(20, c + 1);
          return c;
        });
      }
      intervalRef.current = setTimeout(tick, 10000 + Math.random() * 15000);
    };
    intervalRef.current = setTimeout(tick, 10000 + Math.random() * 15000);
    return () => clearTimeout(intervalRef.current);
  }, [featureId]);
  return count;
}

// ─── Loading screen ───────────────────────────────────────────────────────────
function LoadingScreen() {
  return (
    <div className="min-h-screen bg-neutral-950 flex flex-col items-center justify-center gap-6">
      <motion.p initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.5 }}
        className="text-white text-xl font-semibold tracking-[0.3em]">C O N T Y N T</motion.p>
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.4 }} className="flex gap-1.5">
        {[0, 1, 2].map((i) => (
          <span key={i} className="w-1.5 h-1.5 bg-white/40 rounded-full animate-pulse" style={{ animationDelay: `${i * 0.2}s` }} />
        ))}
      </motion.div>
    </div>
  );
}

// ─── Wallet / cash-out modal ─────────────────────────────────────────────────
const PAYOUT_METHODS = ["PayPal", "Venmo", "Zelle"] as const;

function WalletModal({ stats, token, payouts, onClose, onRequested, onReported }: {
  stats: PortalStats; token: string; payouts: Payout[];
  onClose: () => void; onRequested: (amount: number) => void; onReported: (id: string) => void;
}) {
  const available = stats.availableEarnings ?? stats.totalPayout ?? 0;
  const pending = stats.pendingEarnings ?? 0;
  // Lifetime figures fall back to what is on hand, so an older server that does
  // not send them yet shows something truthful rather than $0.
  const lifetime = stats.lifetimeEarned ?? (stats.totalPayout ?? 0);
  const paidOut = stats.lifetimePaid ?? 0;
  const money = (n: number) => `$${Math.round(n * 100) / 100}`;
  const [method, setMethod] = useState<string>("");
  const [handle, setHandle] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  // What was actually requested, kept because `available` does not survive the
  // request. onRequested moves the money from available to pending straight
  // away, so by the time the confirmation renders the number it was reading had
  // already gone to zero -- and it told the creator we would send them $0.
  const [requestedAmount, setRequestedAmount] = useState(0);
  const [error, setError] = useState("");
  // Which sent payout the creator is reporting, if any. Null closes the form.
  const [reporting, setReporting] = useState<string | null>(null);
  const [reportNote, setReportNote] = useState("");
  const [reportBusy, setReportBusy] = useState(false);
  const [reportError, setReportError] = useState("");

  // Only cash-outs already marked sent. One still in the queue has not been
  // paid, so "I did not get it" is not yet something a creator can mean.
  const sent = payouts.filter(p => p.status === "paid");

  const reportMissing = async (id: string) => {
    setReportBusy(true); setReportError("");
    try {
      const res = await api("/creator-portal/report-payout-issue", {
        method: "POST",
        body: JSON.stringify({ token, payoutId: id, note: reportNote.trim() }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok || !d?.success) { setReportError(d?.error || "Could not send that report."); setReportBusy(false); return; }
      onReported(id);
      setReporting(null); setReportNote(""); setReportBusy(false);
    } catch { setReportError("Could not reach the server."); setReportBusy(false); }
  };

  const submit = async () => {
    if (!method || !handle.trim()) return;
    setBusy(true); setError("");
    try {
      const res = await api("/creator-portal/request-payout", {
        method: "POST",
        body: JSON.stringify({ token, method, handle: handle.trim() }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) { setError(d?.error || "Could not submit request."); setBusy(false); return; }
      // Captured before onRequested, which is what zeroes `available`.
      setRequestedAmount(available);
      setDone(true); setBusy(false); onRequested(available);
    } catch { setError("Could not reach the server."); setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-5 bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-sm bg-neutral-900 border border-white/15 rounded-2xl p-6 space-y-4 relative" onClick={e => e.stopPropagation()}>
        <button onClick={onClose} className="absolute top-6 right-6 text-neutral-500 hover:text-white transition-colors"><X className="w-5 h-5" /></button>
        <div className="text-center space-y-1">
          <h2 className="text-lg font-bold text-white">Your Earnings</h2>
          <p className="text-xs text-neutral-400">Available to cash out</p>
        </div>

        <p className={`text-3xl font-bold text-center ${available > 0 ? "text-green-400" : "text-neutral-500"}`}>{money(available)}</p>

        {/* The full picture, so "available" reading low is explained rather than
            looking like earnings went missing. */}
        <div className="bg-white/5 border border-white/10 rounded-xl divide-y divide-white/10">
          {pending > 0 && (
            <div className="flex items-center justify-between px-3.5 py-2.5">
              <span className="text-xs text-neutral-400">On the way</span>
              <span className="text-sm font-semibold text-yellow-400">{money(pending)}</span>
            </div>
          )}
          <div className="flex items-center justify-between px-3.5 py-2.5">
            <span className="text-xs text-neutral-400">Total earned</span>
            <span className="text-sm font-semibold text-neutral-200">{money(lifetime)}</span>
          </div>
          {paidOut > 0 && (
            <div className="flex items-center justify-between px-3.5 py-2.5">
              <span className="text-xs text-neutral-400">Already paid out</span>
              <span className="text-sm font-semibold text-neutral-300">{money(paidOut)}</span>
            </div>
          )}
        </div>

        {/* Sent cash-outs, and the only way a creator has to say one never
            arrived. "Mark as Sent" is a human pressing a button after moving
            money by hand, so nothing here verifies the transfer landed -- a
            typo'd handle or a rejected transfer looks identical to success. */}
        {sent.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-neutral-300">Sent to you</p>
            <div className="bg-white/5 border border-white/10 rounded-xl divide-y divide-white/10">
              {sent.map(p => (
                <div key={p.id} className="px-3.5 py-2.5 space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm text-neutral-200">
                        {money(p.amount)}
                        <span className="text-xs text-neutral-500"> · {p.method || "payout"}</span>
                      </p>
                      {p.paidAt && (
                        <p className="text-[11px] text-neutral-500">
                          {new Date(p.paidAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                        </p>
                      )}
                    </div>
                    {p.notReceivedAt && !p.issueResolvedAt ? (
                      <span className="shrink-0 text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/25 px-2 py-0.5 rounded-full">
                        Looking into it
                      </span>
                    ) : reporting === p.id ? null : (
                      <button onClick={() => { setReporting(p.id); setReportNote(""); setReportError(""); }}
                        className="shrink-0 text-[11px] text-neutral-400 hover:text-white underline underline-offset-2 transition-colors">
                        Didn't get it?
                      </button>
                    )}
                  </div>

                  {reporting === p.id && (
                    <div className="space-y-2">
                      <textarea
                        value={reportNote}
                        onChange={e => setReportNote(e.target.value)}
                        rows={2}
                        maxLength={500}
                        placeholder={`Anything that helps us trace it — is ${p.handle || "your handle"} still right?`}
                        className="w-full px-3 py-2 bg-white/10 border border-white/20 rounded-xl text-white text-[13px] placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-white/25"
                      />
                      {reportError && <p className="text-[11px] text-red-400">{reportError}</p>}
                      <div className="flex gap-2">
                        <button onClick={() => reportMissing(p.id)} disabled={reportBusy}
                          className="flex-1 py-2 text-xs font-semibold bg-white text-neutral-900 rounded-xl disabled:opacity-50">
                          {reportBusy ? "Sending…" : "Report it"}
                        </button>
                        <button onClick={() => { setReporting(null); setReportError(""); }}
                          className="px-3 py-2 text-xs text-neutral-400 hover:text-white transition-colors">
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {done ? (
          <div className="bg-green-500/10 border border-green-500/25 rounded-xl p-4 space-y-1 text-center">
            <p className="text-sm font-semibold text-green-300">Payout requested</p>
            <p className="text-xs text-neutral-400">We'll send {money(requestedAmount)} to your {method} ({handle}). You'll get a confirmation once it's sent.</p>
          </div>
        ) : available <= 0 ? (
          <p className="text-sm text-neutral-400 text-balance text-center">
            {pending > 0 ? "Your cash out is on its way." : "Nothing to cash out yet."}
          </p>
        ) : (
          <>
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-neutral-300">Payment method</p>
              <div className="grid grid-cols-3 gap-2">
                {PAYOUT_METHODS.map(m => (
                  <button key={m} onClick={() => setMethod(m)}
                    className={`py-2.5 text-sm rounded-xl border transition-all ${
                      method === m ? "bg-white text-neutral-900 border-white font-semibold" : "bg-white/5 text-neutral-300 border-white/15 hover:border-white/30"
                    }`}>{m}</button>
                ))}
              </div>
            </div>
            {method && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-neutral-300">
                  Your {method} {method === "Zelle" ? "phone or email" : method === "PayPal" ? "email" : "username"}
                </p>
                <input value={handle} onChange={e => setHandle(e.target.value)}
                  placeholder={method === "Venmo" ? "@username" : method === "Zelle" ? "phone or email" : "email"}
                  className="w-full px-3 py-2.5 bg-white/10 border border-white/20 rounded-xl text-white text-sm placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-white/20" />
              </div>
            )}
            {error && <p className="text-xs text-red-400">{error}</p>}
            <button onClick={submit} disabled={!method || !handle.trim() || busy}
              className="w-full py-3 bg-green-500 hover:bg-green-400 text-white text-sm font-semibold rounded-xl transition-all disabled:opacity-40">
              {busy ? "Submitting…" : `Request ${money(available)}`}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Stats bar ────────────────────────────────────────────────────────────────
// "on\u2011time" carries a non-breaking hyphen: with an ordinary one the wrap
// landed inside the word and the tip read "on-" / "time".
const CREATOR_SCORE_HELP =
  "Based on completion rate, on‑time submissions, approval rate, and Reel performance.";

// Hover covers desktop; tap covers mobile, where hover never fires.
const IN_PROGRESS_HELP =
  "Features you've requested or are filming, until the Reel is approved.";
const EARNED_HELP =
  "Your balance from approved Reels. Tap to cash out.";

// Hover for pointers, tap for touch, and Escape/blur to dismiss — the portal is
// mobile first, so a hover-only tooltip would be invisible to most creators.
function HelpTip({ label, text, align = "center" }: {
  label: string; text: string; align?: "left" | "center" | "right";
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement | null>(null);

  // Fixed alignment rather than measuring at open time. A measured clamp reads
  // getBoundingClientRect, which is viewport relative, so the moment anything
  // else on the page causes a sideways scroll the correction is computed from a
  // shifted origin and lands short. The grid here is a fixed three columns, so
  // which edge each tip should hang off is known up front.
  const pos = align === "right" ? "right-0"
            : align === "left"  ? "left-0"
            : "left-1/2 -translate-x-1/2";

  // Touch has no hover, so it also has no mouseleave. A tip opened by tapping
  // could only be closed by hitting the same 14px target again -- while the tip
  // itself sat on top of the tiles either side of it, including the Earned tile
  // that opens the wallet. Tapping anywhere else now dismisses it, which is what
  // every other overlay on a phone does.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: Event) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    // Capture, so it still fires for handlers that stop propagation on the way up.
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open]);

  return (
    <span ref={wrap} className="relative inline-flex">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        // Stops the click reaching a clickable tile behind it.
        onClick={(e) => { e.stopPropagation(); setOpen(v => !v); }}
        // Guarded on pointerType. A touch fires a synthetic mouseenter
        // immediately before the click, so opening on hover and toggling on
        // click cancelled each other out: tapping "?" set open true and then
        // straight back to false, and nothing ever appeared. Only a real mouse
        // opens on hover now; touch goes through the click alone.
        onPointerEnter={(e) => { if (e.pointerType === "mouse") setOpen(true); }}
        onPointerLeave={(e) => { if (e.pointerType === "mouse") setOpen(false); }}
        onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}
        // The circle stays 14px because it sits inside a line of 12px text, but
        // 14px is half the smallest target a thumb can reliably hit. The pseudo
        // element widens the touch area to ~30px without moving anything.
        className="relative w-3.5 h-3.5 rounded-full border border-white/25 text-[9px] leading-none text-neutral-400 hover:text-white hover:border-white/50 transition-colors flex items-center justify-center touch-manipulation after:absolute after:-inset-2 after:content-['']"
      >
        ?
      </button>
      {open && (
        <span
          role="tooltip"
          // balance rather than the inherited pretty: pretty only rescues a
          // lone trailing word, which still leaves a stubby last line. balance
          // evens every line out, and these blocks are the few-line strings it
          // is designed for.
          className={`absolute z-30 top-5 ${pos} w-60 max-w-[calc(100vw-1.5rem)] rounded-xl border border-white/15 bg-neutral-900 px-3.5 py-2.5 text-[11px] leading-[1.5] text-neutral-300 shadow-xl text-left font-normal text-balance`}
        >
          {text}
        </span>
      )}
    </span>
  );
}

function StatsBar({ stats, instagram, onOpenWallet, earnedGlow }: {
  stats: PortalStats; instagram: string;
  onOpenWallet?: () => void; earnedGlow?: boolean;
}) {
  // Two different signals share this tile. hasMoney is the steady state — there
  // is a balance sitting there — while earnedGlow is the transient pulse set
  // when the balance rises, and it clears once the wallet is opened.
  // The tile shows what is actually cashable. totalPayout is the balance still
  // owed, which includes money already requested, so it kept reading $15 after
  // a cash-out request had taken that $15 out of reach.
  const available = stats.availableEarnings ?? stats.totalPayout ?? 0;
  const pending = stats.pendingEarnings ?? 0;
  const hasMoney = available > 0;

  return (
    <div className="grid grid-cols-3 gap-3">
      <div className="bg-white/5 border border-white/10 rounded-2xl p-4 text-center">
        <div className="flex items-center justify-center gap-1.5 mb-1">
          <Zap className="w-4 h-4 text-blue-400" />
          <span className="text-xs text-neutral-400">In Progress</span>
          <HelpTip label="What counts as In Progress?" text={IN_PROGRESS_HELP} align="left" />
        </div>
        <p className="text-2xl font-bold text-white">{stats.activeClaims}</p>
      </div>

      <div className="bg-white/5 border border-white/10 rounded-2xl p-4 text-center">
        <div className="flex items-center justify-center gap-1.5 mb-1">
          <Award className="w-4 h-4 text-purple-300" />
          <span className="text-xs text-neutral-400">Creator Score</span>
          <HelpTip label="What is Creator Score?" text={CREATOR_SCORE_HELP} />
        </div>
        <p className="text-2xl font-bold text-white">{stats.creatorScore ?? 100}</p>
      </div>

      {/* Earned doubles as the wallet entry point once a balance exists. A div
          rather than a button because it contains the help button, and a button
          inside a button is invalid and would fire both on tap. */}
      <div
        role="button"
        tabIndex={0}
        aria-label="Open wallet"
        onClick={onOpenWallet}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpenWallet?.(); }
        }}
        className={`group relative bg-white/5 border rounded-2xl p-4 text-center transition-all cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40 ${
          earnedGlow
            ? "border-green-400/60 shadow-[0_0_18px_rgba(74,222,128,0.35)] animate-pulse"
            : hasMoney
              ? "border-green-400/35 shadow-[0_0_12px_rgba(74,222,128,0.18)] hover:border-green-400/60"
              : "border-white/10 hover:border-white/25"
        }`}
      >
        <div className="flex items-center justify-center gap-1.5 mb-1">
          <DollarSign className={`w-4 h-4 ${hasMoney || earnedGlow ? "text-green-400" : "text-neutral-500"}`} />
          <span className="text-xs text-neutral-400">Earned</span>
          <HelpTip label="What is Earned?" text={EARNED_HELP} align="right" />
        </div>
        {/* Dimmed at zero so an empty balance reads as neutral rather than as
            something the creator has failed at. */}
        <p className={`text-2xl font-bold ${
          earnedGlow ? "text-green-300" : hasMoney ? "text-green-400" : "text-neutral-500"
        }`}>${available}</p>
        {/* Money in flight is still theirs, so say so rather than letting the
            tile look like the balance vanished. Revealed on hover or keyboard
            focus, and positioned absolutely so the three tiles keep equal
            heights whether or not a payout is pending. Touch devices get the
            same figure from the wallet itself, which a tap opens. */}
        {pending > 0 && (
          <p className="pointer-events-none absolute inset-x-0 bottom-1.5 text-[10px] text-yellow-400/90 leading-tight opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100">
            ${pending} on the way
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Countdown bar (visual only) ─────────────────────────────────────────────

// ─── Blurred pending reel preview ─────────────────────────────────────────────
function PendingReelPreview({ reelUrl }: { reelUrl?: string }) {
  return (
    <div className="relative w-full rounded-2xl overflow-hidden border border-white/10 bg-neutral-900" style={{ aspectRatio: "16/9" }}>
      <div className="absolute inset-0 bg-gradient-to-br from-indigo-900/40 via-neutral-900 to-purple-900/20" />
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
        <div className="relative flex items-center justify-center">
          <span className="animate-ping absolute w-10 h-10 rounded-full bg-white/10" />
          <div className="w-10 h-10 rounded-full bg-white/10 border border-white/20 flex items-center justify-center">
            <span className="w-3 h-3 rounded-full bg-yellow-400 animate-pulse" />
          </div>
        </div>
        <p className="text-white text-sm font-medium">Pending Review…</p>
      </div>
      {reelUrl && (
        <a href={reelUrl} target="_blank" rel="noopener noreferrer"
          className="absolute bottom-3 right-3 flex items-center gap-1 text-xs text-white/60 hover:text-white/90 bg-black/40 px-2 py-1 rounded-lg">
          <ExternalLink className="w-3 h-3" />View Reel
        </a>
      )}
    </div>
  );
}

// ─── Viewer count pill ────────────────────────────────────────────────────────
function ViewerCount({ featureId }: { featureId: string }) {
  const count = useViewerCount(featureId);
  return (
    <div className="w-full flex items-center gap-1.5 text-xs text-neutral-500">
      <Users className="w-3 h-3" />
      <span>{count} other creator{count !== 1 ? "s" : ""} viewing this</span>
    </div>
  );
}

// ─── Feature card ─────────────────────────────────────────────────────────────
function FeatureCard({ feature, claim, token, onClaim, onUnclaim, onAccept, onSubmit, onPayout, fake, claimedBy, myInstagram, needsAttention, onSeen, showAmbassadorUpsell, onLearnAmbassador, isAmbassador, onCardPrinted }: {
  feature: Feature; claim?: Claim; token: string; myInstagram?: string;
  onClaim: () => void; onUnclaim: () => void; onAccept: () => void;
  onSubmit: (url: string, handedOff: boolean | null, handoffReason: string) => void;
  onPayout: (amount?: string) => void; fake?: boolean; claimedBy?: string;
  needsAttention?: boolean; onSeen?: () => void;
  showAmbassadorUpsell?: boolean; onLearnAmbassador?: () => void; isAmbassador?: boolean;
  onCardPrinted?: () => void;
}) {
  const [reelUrl, setReelUrl] = useState(claim?.reelUrl || "");
  const [urlError, setUrlError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [showClaimConfirm, setShowClaimConfirm] = useState(false);
  const [payoutRequested, setPayoutRequested] = useState(false);
  const [showPaymentPicker, setShowPaymentPicker] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState("");
  const [paymentInfo, setPaymentInfo] = useState("");
  const [claiming, setClaiming] = useState(false);
  const [handedOff, setHandedOff] = useState<boolean | null>(null);
  const [askingHandoff, setAskingHandoff] = useState(false);
  const claimStatus = claim?.status;
  const isGloballyClaimed = feature.status === "completed" || fake;

  const handleClaim = async () => {
    setClaiming(true);
    await onClaim();
    setClaiming(false);
  };

  const send = (url: string) => {
    setUrlError("");
    setSubmitting(true);
    setShowSuccess(true);
    setTimeout(() => {
      onSubmit(url, handedOff, "");
      setSubmitting(false);
      setShowSuccess(false);
      setAskingHandoff(false);
    }, 1500);
  };

  const handleSubmit = () => {
    const url = reelUrl.trim();
    if (!url) return;
    try { new URL(url); } catch {
      setUrlError("Please enter a valid URL (e.g. https://www.instagram.com/reel/...)");
      return;
    }
    // Ambassadors answer the handoff question before this goes anywhere: the
    // server rejects a submission that omits it, so asking now beats letting
    // them watch a success animation and then find out it failed.
    if (isAmbassador && handedOff === null) {
      setUrlError("");
      setAskingHandoff(true);
      return;
    }
    send(url);
  };

  const finishSubmit = () => {
    if (handedOff === null) return;
    send(reelUrl.trim());
  };

  const winner = (feature as any).winnerInstagram || claimedBy || "";
  // Independent of `fake`, so the Activity feed can tell the creator's own
  // completed Features apart from everyone else's and leave them unmasked.
  const winnerIsMe = !!myInstagram && !!winner &&
    winner.replace(/^@+/, "").toLowerCase() === myInstagram.replace(/^@+/, "").toLowerCase();
  const isMyWin = !fake && isGloballyClaimed && myInstagram &&
    winner.replace(/^@+/, "").toLowerCase() === myInstagram.replace(/^@+/, "").toLowerCase();
  // stripeLink needed before isMyWin check
  const stripeLink = claim?.stripeLink || "";
  const payoutAmount = claim?.payoutAmount || "";

  // ── Completed by me — only show AFTER cash out ──
  if (isMyWin && claim?.status !== "approved") {
    return (
      <div className="bg-gradient-to-br from-green-950/60 to-neutral-900 border border-green-500/30 rounded-2xl p-5">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <p className="font-semibold text-white">{feature.businessName}</p>
            <div className="flex items-center gap-1 text-neutral-400 text-xs mt-1">
              <MapPin className="w-3 h-3" />{feature.city}
            </div>
          </div>
          <span className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full bg-green-500/20 text-green-400 border border-green-500/30 font-semibold shrink-0">
            <CheckCircle className="w-3.5 h-3.5" />Completed by You
          </span>
        </div>
        <div className="flex items-center justify-between">
          {feature.category && <span className="text-xs text-neutral-500 bg-white/5 px-2.5 py-1 rounded-full">{feature.category}</span>}
          {claim?.payoutAmount && (
            <span className="text-lg font-bold text-green-400">{formatPayout(claim.payoutAmount)}</span>
          )}
        </div>
      </div>
    );
  }

  // ── Globally claimed by someone else (skip for winner — they need Cash Out card) ──
  if (isGloballyClaimed && !isMyWin) {
    return (
      <div className="bg-white/5 border border-white/10 rounded-2xl p-5">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <p className={`font-medium ${winnerIsMe ? "text-white" : "text-neutral-400"}`}>
              {winnerIsMe ? feature.businessName : <BlurredName name={feature.businessName} />}
            </p>
            <div className="flex items-center gap-1 text-neutral-600 text-xs mt-1">
              <MapPin className="w-3 h-3" />{feature.city}
            </div>
          </div>
          <span className="text-xs px-2 py-0.5 rounded-full bg-neutral-800 text-neutral-500 border border-neutral-700 shrink-0">CLAIMED</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-neutral-600 bg-white/5 px-2.5 py-1 rounded-full">{feature.category}</span>
          {winner && (() => {
            return (
              <span className="text-xs text-neutral-500">
                Claimed by {winnerIsMe ? <span className="text-neutral-200 font-semibold">You</span> : <BlurredHandle username={winner} />}
              </span>
            );
          })()}
        </div>
      </div>
    );
  }

  const cardState = claimStatus || "available";
  const expiresAt = claim?.expiresAt || "";
  const isExpired = expiresAt && new Date(expiresAt).getTime() < Date.now();

  const borderClass =
    // Green is reserved for "accepted and awaiting your next action", and
    // clears once the creator has looked at the card.
    needsAttention ? "border-green-500/40 shadow-[0_0_14px_rgba(74,222,128,0.20)]" :
    cardState === "denied" ? "border-red-500/20" :
    cardState === "approved" ? "border-white/15" :
    cardState === ("admin_approved" as any) ? "border-white/20" :
    cardState === "interested" ? "border-white/20" :
    cardState === "claimed" ? "border-blue-500/30" :
    cardState === "submitted" ? "border-white/10" :
    "border-white/10 hover:border-white/20";

  const bgClass =
    cardState === "approved" ? "bg-gradient-to-br from-green-950/60 to-neutral-900" :
    cardState === "denied" ? "bg-red-950/20" :
    "bg-white/5";

  return (
    <div onClick={() => { if (needsAttention) onSeen?.(); }}
      className={`w-full min-w-0 ${bgClass} border ${borderClass} rounded-2xl overflow-hidden transition-colors duration-300`} style={{ borderColor: cardState === "claimed" ? "rgba(59,130,246,0.3)" : undefined }}>
      <div className="w-full min-w-0 p-5 space-y-4">

          {/* ── Denied ── */}
          {cardState === "denied" && <>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-semibold text-white">{feature.businessName}</p>
                <div className="flex items-center gap-1 text-neutral-400 text-xs mt-1"><MapPin className="w-3 h-3" />{feature.city}</div>
              </div>
              <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/20 text-red-400 border border-red-500/30 shrink-0">Not Approved</span>
            </div>
            <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-3 text-xs text-red-300 space-y-1">
              <p className="font-medium">This reel was not approved.</p>
              {claim?.deniedNote && <p className="text-red-400/80">{claim.deniedNote}</p>}
            </div>
          </>}

          {/* ── Approved + Cash Out ── */}
          {cardState === "approved" && <>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-semibold text-white">{feature.businessName}</p>
                <div className="flex items-center gap-1 text-neutral-400 text-xs mt-1"><MapPin className="w-3 h-3" />{feature.city}</div>
              </div>
              <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/20 text-green-400 border border-green-500/30 shrink-0 flex items-center gap-1">
                <CheckCircle className="w-3 h-3" />Approved
              </span>
            </div>
            {claim?.reelUrl && (
              <a href={claim.reelUrl} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-2 w-full py-3 px-4 bg-white/5 border border-white/10 rounded-xl text-sm text-white hover:bg-white/10 transition-all">
                <ExternalLink className="w-4 h-4 shrink-0 text-green-400" /><span className="truncate">View your Reel</span>
              </a>
            )}
            <div className="bg-green-500/10 border border-green-500/20 rounded-xl p-4 space-y-3">
              <div className="text-center">
                <p className="text-xs font-medium text-green-500 uppercase tracking-widest mb-1">Payout Ready</p>
                <p className="text-4xl font-bold text-green-400">{payoutAmount ? formatPayout(payoutAmount) : formatPayout(feature.payoutRange)}</p>
              </div>
              {payoutRequested ? (
                <div className="w-full py-3 bg-green-500/20 text-green-400 text-sm font-medium rounded-xl text-center">✓ Cashed out!</div>
              ) : showPaymentPicker ? (
                <div className="space-y-2">
                  {!paymentMethod ? (
                    <>
                      <p className="text-xs text-neutral-400 text-center">Select your preferred payment method</p>
                      {["PayPal", "Zelle", "Venmo"].map(m => (
                        <button key={m} onClick={() => setPaymentMethod(m)}
                          className="w-full py-2.5 bg-white/10 border border-white/15 text-white text-sm rounded-xl hover:bg-white/15 transition-all">
                          {m}
                        </button>
                      ))}
                      <button onClick={() => setShowPaymentPicker(false)}
                        className="w-full py-2 text-xs text-neutral-500 hover:text-neutral-300">Cancel</button>
                    </>
                  ) : (
                    <>
                      <p className="text-xs text-neutral-400">{paymentMethod} — enter your {paymentMethod === "Zelle" ? "phone or email" : paymentMethod === "PayPal" ? "email or username" : "username"}</p>
                      <input value={paymentInfo} onChange={e => setPaymentInfo(e.target.value)}
                        placeholder={paymentMethod === "Venmo" ? "@username" : paymentMethod === "Zelle" ? "phone or email" : "email or @username"}
                        className="w-full px-3 py-2.5 bg-white/10 border border-white/20 rounded-xl text-white text-sm placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-white/20" />
                      <button onClick={async () => {
                        if (!paymentInfo.trim()) return;
                        await api("/creator-portal/cash-out", {
                          method: "POST",
                          body: JSON.stringify({ token, featureId: feature.id, paymentMethod, paymentInfo }),
                        }).catch(() => {});
                        setPayoutRequested(true);
                        onPayout(payoutAmount);
                      }} disabled={!paymentInfo.trim()}
                        className="w-full py-3 bg-green-500 hover:bg-green-400 text-white text-sm font-semibold rounded-xl transition-all disabled:opacity-40">
                        Confirm Cash Out
                      </button>
                      <button onClick={() => setPaymentMethod("")} className="w-full py-1.5 text-xs text-neutral-500 hover:text-neutral-300">← Back</button>
                    </>
                  )}
                </div>
              ) : (
                <button onClick={() => setShowPaymentPicker(true)}
                  className="w-full py-3 bg-green-500 hover:bg-green-400 text-white text-sm font-semibold rounded-xl transition-all flex items-center justify-center gap-2">
                  <DollarSign className="w-4 h-4" />Cash Out
                </button>
              )}
            </div>
          </>}

          {/* ── Submitted ── */}
          {cardState === "submitted" && <>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-semibold text-white">{feature.businessName}</p>
                <div className="flex items-center gap-1 text-neutral-400 text-xs mt-1"><MapPin className="w-3 h-3" />{feature.city}</div>
              </div>
              <div className="flex flex-col items-end gap-1.5 shrink-0">
                <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-400/15 text-yellow-400 border border-yellow-400/20">Under Review</span>
                <span className="text-sm font-bold text-green-400">{formatPayout(feature.payoutRange)}</span>
              </div>
            </div>
            {/* Compact pending indicator instead of full preview */}
            <div className="flex items-center gap-3 bg-neutral-900 border border-white/10 rounded-xl px-4 py-3">
              <span className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse shrink-0" />
              <p className="text-sm text-neutral-300">Pending Review…</p>
              {claim?.reelUrl && (
                <a href={claim.reelUrl} target="_blank" rel="noopener noreferrer"
                  className="ml-auto flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-300 transition-colors shrink-0">
                  <ExternalLink className="w-3 h-3" />View
                </a>
              )}
            </div>
          </>}

          {/* ── Admin approved — creator must Accept within 24hrs ── */}
          {cardState === ("admin_approved" as any) && (() => {
            const acceptExpires = claim?.acceptanceExpiresAt || "";
            const isExpiredAcceptance = acceptExpires && new Date(acceptExpires).getTime() < Date.now();
            return isExpiredAcceptance ? (
              <>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold text-white">{feature.businessName}</p>
                    <div className="flex items-center gap-1 text-neutral-400 text-xs mt-1"><MapPin className="w-3 h-3" />{feature.city}</div>
                  </div>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/20 text-red-400 border border-red-500/30 shrink-0">Expired</span>
                </div>
                <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 text-xs text-red-400 text-center">
                  Acceptance window expired.
                </div>
                <button onClick={onUnclaim}
                  className="w-full py-2.5 bg-white/10 border border-white/15 text-white text-sm font-semibold rounded-xl hover:bg-white/15 transition-all">
                  Ok
                </button>
              </>
            ) : (
              <>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold text-white">{feature.businessName}</p>
                    <div className="flex items-center gap-1 text-neutral-400 text-xs mt-1"><MapPin className="w-3 h-3" />{feature.city}</div>
                    {feature.category && <span className="text-xs text-neutral-500 bg-white/5 border border-white/10 px-2 py-0.5 rounded-full mt-1 inline-block">{feature.category}</span>}
                  </div>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/20 text-green-400 border border-green-500/30 shrink-0">Selected!</span>
                </div>
                <div className="bg-green-500/10 border border-green-500/20 rounded-xl px-4 py-4 space-y-3 text-center">
                  <CheckCircle className="w-7 h-7 text-green-400 mx-auto" />
                  <p className="text-sm font-semibold text-white">You've been selected for this feature!</p>
                  <p className="text-xs text-neutral-400">Accept within 24 hours or the offer expires.</p>
                  {acceptExpires && (
                    <div className="text-xs text-yellow-400">
                      <CountdownTimer expiresAt={acceptExpires} compact />
                    </div>
                  )}
                </div>
                <button onClick={onAccept}
                  className="w-full py-3 bg-white text-neutral-900 text-sm font-bold rounded-xl hover:bg-neutral-100 transition-all">
                  Accept Feature
                </button>
              </>
            );
          })()}

          {/* ── Interested (waiting for admin approval) ── */}
          {cardState === "interested" && <>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-semibold text-white">{feature.businessName}</p>
                <div className="flex items-center gap-1 text-neutral-400 text-xs mt-1"><MapPin className="w-3 h-3" />{feature.city}</div>
              </div>
              <span className="text-xs px-2 py-0.5 rounded-full bg-white/10 text-neutral-300 border border-white/15 shrink-0">Requested</span>
            </div>
            <div className="bg-white/5 border border-white/10 rounded-xl px-4 py-4 text-center space-y-1.5">
              <CheckCircle className="w-6 h-6 text-green-400 mx-auto" />
              <p className="text-sm font-semibold text-white">Interest noted!</p>
              <p className="text-xs text-neutral-400">You'll be notified once you're accepted.</p>
            </div>
            <button onClick={onUnclaim}
              className="w-full py-2 text-xs text-neutral-500 hover:text-neutral-300 transition-all flex items-center justify-center gap-1">
              <X className="w-3 h-3" />Withdraw Interest
            </button>
          </>}

          {/* ── Claimed expired (7-day window passed) ── */}
          {cardState === "claimed" && isExpired && <>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-semibold text-white">{feature.businessName}</p>
                <div className="flex items-center gap-1 text-neutral-400 text-xs mt-1"><MapPin className="w-3 h-3" />{feature.city}</div>
              </div>
              <span className="text-xs px-2 py-0.5 rounded-full bg-neutral-700 text-neutral-400 border border-neutral-600 shrink-0">Expired</span>
            </div>
            <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 text-xs text-red-400 text-center">
              Time window has expired.
            </div>
            <button onClick={onUnclaim}
              className="w-full py-2.5 bg-white/10 border border-white/15 text-white text-sm font-semibold rounded-xl hover:bg-white/15 transition-all">
              Ok
            </button>
          </>}

          {/* ── Claimed (in progress — admin approved) ── */}
          {cardState === "claimed" && !isExpired && <>
            <button type="button" onClick={() => setExpanded(v => !v)}
              aria-expanded={expanded}
              aria-label={expanded ? "Collapse feature details" : "Expand feature details"}
              className="w-full text-left flex items-start justify-between gap-3 rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-white/30">
              <div>
                <p className="font-semibold text-white">{feature.businessName}</p>
                <div className="flex items-center gap-1 text-neutral-400 text-xs mt-1"><MapPin className="w-3 h-3" />{feature.city}</div>
                {feature.category && <span className="text-xs text-neutral-500 bg-white/5 border border-white/10 px-2 py-0.5 rounded-full mt-1 inline-block">{feature.category}</span>}
              </div>
              <div className="flex flex-col items-end gap-1.5 shrink-0">
                <div className="flex items-center gap-1.5 text-xs text-blue-400">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                  In Progress
                </div>
                <span className="text-sm font-bold text-green-400">{formatPayout(feature.payoutRange)}</span>
                <ChevronDown className={`w-4 h-4 text-neutral-500 transition-transform ${expanded ? "rotate-180" : ""}`} />
              </div>
            </button>
            {/* Collapsed by default: the business, the payout and the countdown
                are what matters at a glance. Everything needed to actually do
                the shoot opens on tap. */}
            {expanded && <>
            <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${feature.businessName} ${feature.address} ${feature.city}`)}`}
              target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-3 bg-neutral-800/60 border border-white/10 rounded-xl px-4 py-3 hover:bg-neutral-700/60 transition-all group">
              <div className="w-8 h-8 rounded-lg bg-blue-500/20 flex items-center justify-center shrink-0">
                <MapPin className="w-4 h-4 text-blue-400" />
              </div>
              <div className="min-w-0">
                <p className="text-sm text-white truncate">{feature.address || feature.city}</p>
                <p className="text-xs text-neutral-500">{feature.city}</p>
              </div>
              <ExternalLink className="w-3.5 h-3.5 text-neutral-500 group-hover:text-neutral-300 shrink-0 ml-auto" />
            </a>
            {/* Trimmed, not just truthy: a note saved as whitespace would
                otherwise render an empty bordered box. */}
            {feature.adminNotes?.trim() && (
              <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl px-4 py-3 text-xs text-blue-200 space-y-1">
                <p className="font-semibold text-blue-300 uppercase tracking-widest text-[10px]">Instructions</p>
                <p className="leading-relaxed">{feature.adminNotes.trim()}</p>
              </div>
            )}
            {/* Above the Ambassador block: these are the rules for the Reel
                itself, which is the job. Handing out a card is the optional
                extra that follows. */}
            <div className="bg-white/5 rounded-xl px-4 py-3 text-xs text-neutral-400 space-y-1.5">
              <p className="font-medium text-neutral-300 mb-2">Post Requirements</p>
              <p>• Add <span className="text-white">@{((feature as any).businessInstagram || feature.businessName).replace(/^@/, "").toLowerCase().replace(/\s+/g, "")}</span> as a collaborator</p>
              <p>• Tag the business location</p>
              <p>• Mention <span className="text-white">@contynt.hq</span> in the caption</p>
              <p>• Keep the post live for at least <span className="text-white">72 hours</span></p>
            </div>
            {/* Only for creators who opted in. The code itself is not shown
                here -- it lives in the Ambassador tab. */}
            {isAmbassador && <AmbassadorFeatureActions token={token} onOpened={onCardPrinted} />}
            {showAmbassadorUpsell && <AmbassadorUpsell onLearnMore={onLearnAmbassador!} />}
            </>}
            {expanded && <>
            {/* Two stages. Submit Reel checks the URL and, for ambassadors,
                flips to the handoff question rather than asking it up front
                where it reads as another form field to fill before starting.
                The Reel is not sent until the question is answered, so the two
                still arrive in one call. */}
            <div className="space-y-2">
              {showSuccess ? (
                <div className="w-full py-3 bg-green-500/20 border border-green-500/30 rounded-xl flex items-center justify-center gap-2 text-sm font-semibold text-green-400">
                  <CheckCircle className="w-4 h-4" />Reel submitted!
                </div>
              ) : askingHandoff ? (
                <>
                  <HandoffQuestion value={handedOff} onChange={setHandedOff} />
                  <button onClick={finishSubmit} disabled={handedOff === null || submitting}
                    className="w-full py-3 bg-white text-neutral-900 text-sm font-semibold rounded-xl hover:bg-neutral-100 transition-all disabled:opacity-40 disabled:cursor-not-allowed">
                    {submitting ? "Submitting…" : "Submit Reel"}
                  </button>
                  <button onClick={() => setAskingHandoff(false)}
                    className="w-full py-1.5 text-[11px] text-neutral-500 hover:text-neutral-300 transition-all">
                    Back to the Reel link
                  </button>
                </>
              ) : (
                <>
                  <input value={reelUrl} onChange={(e) => { setReelUrl(e.target.value); setUrlError(""); }}
                    placeholder="Paste your Instagram Reel URL"
                    disabled={submitting}
                    className={`w-full px-4 py-3 bg-white/10 border rounded-xl text-white text-sm placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-white/30 transition-all disabled:opacity-50 ${urlError ? "border-red-500/50" : "border-white/20"}`} />
                  {urlError && <p className="text-xs text-red-400">{urlError}</p>}
                  <button onClick={handleSubmit} disabled={!reelUrl.trim() || submitting}
                    className="w-full py-3 bg-white text-neutral-900 text-sm font-semibold rounded-xl hover:bg-neutral-100 transition-all disabled:opacity-40 disabled:cursor-not-allowed">
                    Submit Reel
                  </button>
                </>
              )}
            </div>
            </>}
            {/* Outside the collapsed section, so a collapsed card still shows the
                deadline. Placed after Submit so an expanded card reads: what to
                do, then how long is left. Unclaim stays last -- it is the way
                out, not the next step. */}
            {expiresAt && (
              <div className="bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 space-y-1 text-center">
                <p className="text-[10px] text-neutral-500 uppercase tracking-widest">Time Remaining</p>
                <CountdownTimer expiresAt={expiresAt} />
                <p className="text-[10px] text-neutral-600">Complete your Reel before this expires.</p>
              </div>
            )}
            {expanded && <>
            <button onClick={onUnclaim}
              className="w-full py-2 text-xs text-neutral-500 hover:text-neutral-300 transition-all flex items-center justify-center gap-1">
              <X className="w-3 h-3" />Unclaim
            </button>
            </>}
          </>}

          {/* ── Available (default) ── */}
          {cardState === "available" && <>
            {/* Tap card to expand details */}
            <button onClick={() => { setExpanded(v => { if (!v) api("/creator-portal/view-feature", { method: "POST", body: JSON.stringify({ token, featureId: feature.id }) }).catch(() => {}); return !v; }); }} className="w-full text-left space-y-3">
              <div className="w-full flex items-start justify-between gap-3">
                <div>
                  <p className="font-semibold text-white">{feature.businessName}</p>
                  <div className="flex items-center gap-1 text-neutral-400 text-xs mt-1">
                    <MapPin className="w-3 h-3" />{feature.city}
                  </div>
                  {feature.category && <span className="text-xs text-neutral-500 bg-white/5 border border-white/10 px-2 py-0.5 rounded-full mt-1 inline-block">{feature.category}</span>}
                </div>
                <div className="flex flex-col items-end gap-1">
                  {feature.payoutRange ? (
                    <span className="text-sm font-semibold text-white bg-white/10 px-2.5 py-1 rounded-lg shrink-0">
                      {formatPayout(feature.payoutRange)}
                    </span>
                  ) : null}
                  <span className="text-[10px] text-neutral-500">{expanded ? "▲ less" : "▼ more info"}</span>
                </div>
              </div>
            </button>
            {/* Expanded details */}
            {expanded && (
              <div className="space-y-2 pt-1 border-t border-white/10">
                {feature.address && (
                  <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${feature.businessName} ${feature.address} ${feature.city}`)}`}
                    target="_blank" rel="noopener noreferrer"
                    className="flex items-center gap-2 text-xs text-blue-400 hover:text-blue-300">
                    <MapPin className="w-3 h-3 shrink-0" />{feature.address}, {feature.city}
                  </a>
                )}
                {(feature as any).businessInstagram && (
                  <a href={`https://instagram.com/${(feature as any).businessInstagram.replace(/^@/, "")}`}
                    target="_blank" rel="noopener noreferrer"
                    className="flex items-center gap-2 text-xs text-blue-400 hover:text-blue-300">
                    <ExternalLink className="w-3 h-3 shrink-0" />@{(feature as any).businessInstagram.replace(/^@/, "")}
                  </a>
                )}
                {feature.adminNotes?.trim() && (
                  <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl px-3 py-2.5 text-xs text-blue-200">
                    <p className="leading-relaxed">{feature.adminNotes.trim()}</p>
                  </div>
                )}
              </div>
            )}
            <div className="w-full flex items-center justify-between">
              <ViewerCount featureId={feature.id} />
              <motion.button
                onClick={handleClaim}
                disabled={claiming}
                whileTap={{ scale: 0.94 }}
                className="px-4 py-2 bg-white text-neutral-900 text-sm font-semibold rounded-xl hover:bg-neutral-100 transition-all disabled:opacity-70 shrink-0">
                {claiming ? "…" : "Request"}
              </motion.button>
            </div>
          </>}

      </div>
    </div>
  );
}

// ─── Creator Portal ───────────────────────────────────────────────────────────
export function CreatorPortal({ token, impersonating }: { token: string; impersonating?: boolean }) {
  const [phase, setPhase] = useState<"loading" | "ready" | "error" | "signedout">("loading");
  const [requestError, setRequestError] = useState("");
  // The server reports this off the session record. Trusted over the URL flag,
  // which anyone can strip from the address bar.
  const [serverImpersonated, setServerImpersonated] = useState(false);
  const [creator, setCreator] = useState<{ instagram: string; city: string; email?: string } | null>(null);

  // The tab title carries the handle, so a creator with several tabs open — or
  // an admin impersonating more than one creator at once — can tell them apart
  // without switching to each. App.tsx's title effect never runs here: the
  // portal routes return before it.
  useEffect(() => {
    const who = creator?.instagram?.replace(/^@+/, "");
    document.title = phase === "signedout" ? "CONTYNT | Creator Sign In"
      : who ? `CONTYNT | @${who} · Creator Portal`
      : "CONTYNT | Creator Portal";
  }, [creator?.instagram, phase]);
  const [features, setFeatures] = useState<Feature[]>([]);
  const [claims, setClaims] = useState<Record<string, Claim>>({});
  const [stats, setStats] = useState<PortalStats>({ completed: 0, activeClaims: 0, totalPayout: 0 });
  // A rising balance means the admin just credited a reel — glow the Earned
  // stat and flag Activity until the creator looks.
  const lastBalanceRef = useRef<number | null>(null);
  const [earnedGlow, setEarnedGlow] = useState(false);
  const [creditUnread, setCreditUnread] = useState(false);
  const seenActionsKey = `contynt_seen_actions_${token}`;
  const [seenActions, setSeenActions] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(seenActionsKey) || "[]")); } catch { return new Set(); }
  });
  const markActionSeen = (featureId: string) => {
    setSeenActions(prev => {
      if (prev.has(featureId)) return prev;
      const next = new Set(prev); next.add(featureId);
      try { localStorage.setItem(seenActionsKey, JSON.stringify([...next])); } catch {}
      return next;
    });
  };
  // Action required = admin approved the claim and the creator has yet to accept.
  const featureNeedsAttention = (featureId: string) =>
    (claims[featureId]?.status as any) === "admin_approved" && !seenActions.has(featureId);
  const [walletOpen, setWalletOpen] = useState(false);
  const [error, setError] = useState("");
  // "home" is the landing view: the portal opens on the welcome, stats and
  // explainer, and no tab content until a tab is actually chosen. Features used
  // to be selected on arrival, which buried the explainer under a feature list.
  const [portalTab, setPortalTab] = useState<"home" | "features" | "completed" | "activity" | "ambassador">("home");
  const [placesKey, setPlacesKey] = useState("");
  const [activityPage, setActivityPage] = useState(0);
  const [activitySeedStart, setActivitySeedStart] = useState("");
  const [payouts, setPayouts] = useState<Payout[]>([]);
  const ambassador = useAmbassador(token);
  // Cards only exist for opted-in creators, so the fetch is gated on that
  // rather than firing for every creator on every portal load.
  const featSeenKey = `contynt_cr_feats_seen_${token}`;
  const compSeenKey = `contynt_cr_comp_seen_${token}`;
  const actSeenKey  = `contynt_cr_act_seen_${token}`;
  const [featsSeen,  setFeatsSeen]  = useState(() => { try { return parseInt(localStorage.getItem(`contynt_cr_feats_seen_${token}`) || "0"); } catch { return 0; } });
  const [compSeen,   setCompSeen]   = useState(() => { try { return parseInt(localStorage.getItem(`contynt_cr_comp_seen_${token}`) || "0"); } catch { return 0; } });
  const [actSeen,    setActSeen]    = useState(() => { try { return parseInt(localStorage.getItem(`contynt_cr_act_seen_${token}`)  || "0"); } catch { return 0; } });
  const [editingEmail, setEditingEmail] = useState(false);
  const [emailInput, setEmailInput] = useState("");

  const lsKey = `contynt_claims_${token}`;

  const saveLocalClaims = (updated: Record<string, Claim>) => {
    try { localStorage.setItem(lsKey, JSON.stringify({ ...updated, __savedAt: Date.now() })); } catch {}
  };

  const loadLocalClaims = (): Record<string, Claim> => {
    try {
      const raw = JSON.parse(localStorage.getItem(lsKey) || "{}");
      const { __savedAt, ...claims } = raw;
      return claims;
    } catch { return {}; }
  };

  useEffect(() => {
    const load = async () => {
      const [res] = await Promise.all([
        api(`/creator-portal?t=${token}`),
        new Promise((r) => setTimeout(r, 1200)),
      ]);
      const json = await res.json();
      if (!res.ok) {
        // An expired or revoked session should offer a way back in, not a dead
        // end. The stored token is cleared so the login screen is not skipped
        // straight back into this same failure on the next render.
        if (res.status === 401) {
          try { localStorage.removeItem(CREATOR_TOKEN_KEY); } catch { /* private mode */ }
          setPhase("signedout");
          return;
        }
        setError(json.error || "Invalid link."); setPhase("error"); return;
      }
      setCreator(json.creator);
      setServerImpersonated(!!json.impersonated);
      setPlacesKey(json.placesKey || "");
      setPayouts(json.payouts || []);
      setActivitySeedStart(json.activitySeedStart || "");
      // adminNotes now comes back from /creator-portal directly.
      setFeatures(json.features || []);

      // If admin reset after last save, wipe localStorage so state clears
      if (json.resetAt) {
        try {
          const resetTime = new Date(json.resetAt).getTime();
          const rawLocal = localStorage.getItem(lsKey);
          const savedAt = rawLocal ? JSON.parse(rawLocal).__savedAt || 0 : 0;
          if (resetTime > savedAt) localStorage.removeItem(lsKey);
        } catch {}
      }

      // Merge server claims with localStorage
      const serverClaims: Record<string, any> = json.claims || {};
      const local = loadLocalClaims();

      // Convert server "approved" with acceptanceExpiresAt → "admin_approved" so it shows the Accept card
      for (const [fid, sc] of Object.entries(serverClaims)) {
        if ((sc as any).status === "approved" && (sc as any).acceptanceExpiresAt && !(sc as any).stripeLink) {
          (serverClaims as any)[fid] = { ...sc, status: "admin_approved" };
        }
      }

      const merged: Record<string, Claim> = { ...serverClaims } as any;
      for (const [fid, lc] of Object.entries(local)) {
        const sc = serverClaims[fid];
        const order: Record<string, number> = { interested: 0, admin_approved: 1, claimed: 2, submitted: 3, approved: 4, cashed_out: 5 };
        const localRank = order[lc.status as string] ?? 0;
        const serverRank = sc ? (order[(sc as any).status as string] ?? 0) : 0;
        if (localRank >= serverRank) merged[fid] = lc;
      }
      setClaims(merged as any);
      saveLocalClaims(merged as any);

      // Recompute stats from merged claims so all stages survive refresh
      const serverStats = json.stats || { completed: 0, activeClaims: 0, totalPayout: 0 };
      const mergedValues = Object.values(merged);
      const mergedActiveClaims = mergedValues.filter((c) => c.status === "claimed" || c.status === "submitted").length;
      const mergedCompleted = mergedValues.filter((c) => c.status === "approved").length;
      // totalPayout is now backed by the earnings ledger, so take the server's
      // figure as authoritative instead of reconstructing it from local claims.
      setStats({ ...serverStats, activeClaims: mergedActiveClaims, completed: mergedCompleted });
      lastBalanceRef.current = serverStats.totalPayout ?? 0;
      setPhase("ready");
    };
    load();
  }, [token]);

  const claimFeature = async (featureId: string) => {
    const prev = claims;
    setClaims((p) => {
      const updated = { ...p, [featureId]: { featureId, status: "interested" as const } };
      saveLocalClaims(updated);
      return updated;
    });
    // The server upserts the claim row itself, so no direct SQL write is needed.
    // fetch only rejects on a network failure, so the status has to be checked:
    // this used to be .catch(() => {}) with no res.ok test, which meant a
    // rejected request -- an expired session, or the read-only admin view --
    // left the button looking successful while nothing was ever written.
    try {
      const res = await api("/creator-portal/claim", { method: "POST", body: JSON.stringify({ token, featureId }) });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        setClaims(prev);
        saveLocalClaims(prev);
        setRequestError(d?.error || "Could not send that request. Please try again.");
      }
    } catch {
      setClaims(prev);
      saveLocalClaims(prev);
      setRequestError("Could not reach the server. Please try again.");
    }
  };
  const acceptFeature = async (featureId: string) => {
    // The server sets the claim status and the expiry window; it returns the
    // authoritative expiresAt so the UI does not compute a second, divergent one.
    const res = await api("/creator-portal/accept-feature", { method: "POST", body: JSON.stringify({ token, featureId }) }).catch(() => null);
    const body = await res?.json().catch(() => null);
    // Only a selected claim may be accepted, and the server is what decides
    // that. It refuses a claim an admin has not picked -- and one accepted
    // already, from another tab. Marking this claimed regardless, which is what
    // ran before, showed the creator a Feature that was never theirs to film.
    if (!res?.ok) {
      setRequestError(body?.error || "Could not accept that feature. Please try again.");
      return;
    }
    const expiresAt = body?.expiresAt
      // Fallback only; the server returns the authoritative expiry. Kept in
      // step with CLAIM_DAYS in the accept-feature route.
      ?? new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    setClaims(prev => {
      const updated = { ...prev, [featureId]: { ...prev[featureId], status: "claimed" as const, expiresAt } };
      saveLocalClaims(updated);
      return updated;
    });
    setStats(p => ({ ...p, activeClaims: p.activeClaims + 1 }));
  };

  const unclaimFeature = (featureId: string) => {
    setClaims((p) => {
      const n = { ...p };
      delete n[featureId];
      saveLocalClaims(n);
      return n;
    });
    setStats((p) => ({ ...p, activeClaims: Math.max(0, p.activeClaims - 1) }));
    api("/creator-portal/unclaim", { method: "POST", body: JSON.stringify({ token, featureId }) }).catch(() => {});
  };
  const submitReel = async (featureId: string, reelUrl: string, handedOff: boolean | null = null, handoffReason = "") => {
    const prev = claims;
    // Update UI immediately — submitted still counts as In Progress, don't decrement
    setClaims((p) => {
      const updated = { ...p, [featureId]: { featureId, status: "submitted" as const, reelUrl } };
      saveLocalClaims(updated);
      return updated;
    });
    const instagram = creator?.instagram || "";
    const body = JSON.stringify({ token, featureId, reelUrl, instagram, handedOff, handoffReason });
    // The server checks the link, the claim and the filming window, so this can
    // now be refused -- a Reel submitted after the deadline, or against a
    // Feature the creator does not hold. Swallowing that, which is what the
    // bare .catch() here did, left the card reading "submitted" for a Reel that
    // was never recorded and would never be reviewed.
    try {
      const res = await api("/creator-portal/submit", { method: "POST", body });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        setClaims(prev);
        saveLocalClaims(prev);
        setRequestError(d?.error || "Could not submit that Reel. Please try again.");
      }
    } catch {
      setClaims(prev);
      saveLocalClaims(prev);
      setRequestError("Could not reach the server. Please try again.");
    }
  };
  // One consolidated poll replaces the four separate PostgREST polls this
  // component used to run. The server scopes claims and submissions to this
  // creator's own token, so no other creator's data comes back over the wire.
  useEffect(() => {
    if (phase !== "ready") return;
    const check = async () => {
      try {
        const res = await api(`/creator-portal/sync?t=${encodeURIComponent(token)}`);
        if (!res.ok) return;
        const data = await res.json();
        const claimRows: any[] = data.claims || [];
        const subRows: any[] = data.submissions || [];
        const featRows: any[] = data.features || [];

        // Balance is server-derived; a rise since the last poll is new money.
        if (data.balance) {
          const earned = data.balance.totalEarned ?? 0;
          const prevBalance = lastBalanceRef.current;
          if (prevBalance !== null && earned > prevBalance) {
            setEarnedGlow(true);
            setCreditUnread(true);
          }
          lastBalanceRef.current = earned;
          setStats(p => ({ ...p, totalPayout: earned, ...data.balance }));
        }

        // Claim approvals: admin approved → creator has 24h to accept.
        setClaims(prev => {
          let changed = false;
          const updated = { ...prev };
          for (const row of claimRows) {
            const fid = row.featureId;
            if (!row.approvedAt) continue;
            if (row.status === "approved" && prev[fid]?.status === "interested") {
              updated[fid] = { ...prev[fid], status: "admin_approved" as any, approvedAt: row.approvedAt, acceptanceExpiresAt: row.acceptanceExpiresAt };
              changed = true;
            } else if (row.status === "claimed" && (prev[fid]?.status === "interested" || prev[fid]?.status === ("admin_approved" as any))) {
              updated[fid] = { ...prev[fid], status: "claimed" as const, approvedAt: row.approvedAt, expiresAt: row.expiresAt };
              changed = true;
              setStats(p => ({ ...p, activeClaims: p.activeClaims + 1 }));
            }
          }
          if (changed) saveLocalClaims(updated);
          return changed ? updated : prev;
        });

        // Payout approval and denials on this creator's own submissions.
        setClaims(prev => {
          let changed = false;
          const updated = { ...prev };
          for (const row of subRows) {
            const fid = row.featureId;
            const existing = prev[fid];
            if (!existing) continue;
            if (row.denied && existing.status !== "denied") {
              updated[fid] = { ...existing, status: "denied", deniedNote: row.adminReportNote || "" };
              changed = true;
            }
            if (row.adminPayoutApproved && existing.status === "submitted" && !existing.stripeLink) {
              const alreadyCashedOut = !!row.cashedOutAt;
              updated[fid] = { ...existing, status: alreadyCashedOut ? "cashed_out" : "approved", stripeLink: row.stripeLink, payoutAmount: row.payoutAmount };
              changed = true;
              if (!alreadyCashedOut) {
                const earnedAmt = parseInt((row.payoutAmount || "0").replace(/[^0-9]/g, "") || "0");
                if (earnedAmt > 0) setStats(p => ({ ...p, totalPayout: p.totalPayout + earnedAmt }));
              }
              setFeatures(fs => fs.map(f => f.id === fid ? { ...f, status: "completed" as const } : f));
            }
            if (row.cashedOutAt && existing.status === "approved") {
              updated[fid] = { ...existing, status: "cashed_out" };
              changed = true;
              setFeatures(fs => fs.map(f => f.id === fid ? { ...f, status: "completed" as const } : f));
            }
          }
          if (changed) saveLocalClaims(updated);
          return changed ? updated : prev;
        });

        // Feature status and admin notes.
        const myIg = creator?.instagram?.replace(/^@+/, "").toLowerCase() || "";
        setFeatures(prev => {
          const updated = prev.map(f => {
            const row = featRows.find(r => r.id === f.id);
            if (!row) return f;
            // The winner's own card must stay actionable until they cash out,
            // so don't let the completed status flip it out from under them.
            const winnerIg = (row.winnerInstagram || "").replace(/^@+/, "").toLowerCase();
            const isWinner = !!myIg && winnerIg === myIg;
            const nextStatus = isWinner && f.status !== "completed" ? f.status : row.status;
            const notesChanged = (row.adminNotes || "") !== (f.adminNotes || "");
            if (nextStatus !== f.status || notesChanged) {
              return { ...f, status: nextStatus, winnerInstagram: row.winnerInstagram || "", adminNotes: row.adminNotes || "" };
            }
            return f;
          });
          return JSON.stringify(updated) !== JSON.stringify(prev) ? updated : prev;
        });
      } catch {}
    };
    check();
    const interval = setInterval(check, 6000);
    const onVisible = () => { if (document.visibilityState === "visible") check(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(interval); document.removeEventListener("visibilitychange", onVisible); };
  }, [phase, token]);

  const requestPayout = (featureId: string, passedAmount?: string) => {
    const claim = claims[featureId];
    const feature = features.find(f => f.id === featureId);
    const payoutAmount = passedAmount || claim?.payoutAmount || feature?.payoutRange || "";
    // IMMEDIATELY update UI — before any async calls so nothing can interrupt
    setFeatures(prev => prev.map(f => f.id === featureId ? { ...f, status: "completed" as const, winnerInstagram: creator?.instagram || "" } : f));
    setClaims(prev => prev[featureId] ? { ...prev, [featureId]: { ...prev[featureId], status: "cashed_out" } } : prev);
    // totalPayout already added when Cash Out card appeared — just mark completed
    setStats((p) => ({ ...p, completed: p.completed + 1 }));
    // Fire async updates in background. The server marks the submission cashed
    // out and closes the feature in one call, scoped to this creator's token.
    api("/creator-portal/complete-payout", {
      method: "POST",
      body: JSON.stringify({ token, featureId, payoutAmount, instagram: creator?.instagram || "" }),
    }).catch(() => {});
  };

  if (phase === "loading") return <LoadingScreen />;

  // URL flag or server record: either is enough to lock the view down.
  const isImpersonating = impersonating || serverImpersonated;

  // Home content sits at the top of the page, so returning to it while scrolled
  // down would otherwise land the creator on an apparently blank screen.
  const goHome = () => {
    setPortalTab("home");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  if (phase === "signedout") return <CreatorLogin />;

  if (phase === "error") {
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

  // Built once per render and shared. Called separately in three places it
  // would drift -- the tab badge counting one feed while the tab below showed
  // another, both moving as the clock crossed an entry's timestamp.
  const activityNow = Date.now();
  // An unparseable date is treated as off rather than as 1970, which would
  // backfill every entry the generator can produce.
  const seedStartTs = (() => {
    if (!activitySeedStart) return 0;
    const t = new Date(activitySeedStart).getTime();
    return Number.isFinite(t) ? t : 0;
  })();
  const activityFeed = buildActivityFeed(activityNow, seedStartTs);

  const allFeatures = [...features.map(f => ({ ...f, claimedBy: (f as any).winnerInstagram || undefined })), ...activityFeed].sort((a, b) => {
    const aCompleted = a.status === "completed" || a.id.startsWith("seed_");
    const bCompleted = b.status === "completed" || b.id.startsWith("seed_");
    // Only globally completed/fake → very bottom; claimed/submitted/approved stay in place
    if (aCompleted && !bCompleted) return 1;
    if (!aCompleted && bCompleted) return -1;
    return 0;
  });
  const hasActivity = stats.completed > 0 || stats.activeClaims > 0 || stats.totalPayout > 0;

  return (
    <div className="min-h-screen bg-neutral-950 text-white flex flex-col">
      {/* Ambient — static, no JS animation */}
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute top-0 left-1/3 w-96 h-96 rounded-full blur-[120px]" style={{ background: "rgba(99,102,241,0.1)" }} />
        <div className="absolute bottom-1/4 right-1/4 w-64 h-64 rounded-full blur-[100px]" style={{ background: "rgba(34,197,94,0.06)" }} />
      </div>

      {/* Impersonation is loud on purpose. An admin must never mistake a
          creator's portal for their own, and any action taken here lands on the
          creator's real account. */}
      {isImpersonating && (
        <div className="relative z-20 bg-amber-500/15 border-b border-amber-400/40 px-4 py-2">
          <div className="max-w-2xl mx-auto flex items-center justify-between gap-3">
            <p className="text-xs text-amber-200">
              Viewing as <span className="font-semibold">@{(creator?.instagram || "creator").replace(/^@/, "")}</span>. Admin session, expires in an hour.
            </p>
            <button onClick={() => window.close()}
              className="shrink-0 text-xs text-amber-200/70 hover:text-amber-100 whitespace-nowrap">Close</button>
          </div>
        </div>
      )}

      {/* A rejected request used to fail silently, so the button looked like it
          had worked. The impersonation case lands here with the server's own
          "read-only admin view" wording. */}
      {requestError && (
        <div className="relative z-20 bg-red-500/15 border-b border-red-400/40 px-4 py-2">
          <div className="max-w-2xl mx-auto flex items-center justify-between gap-3">
            <p className="text-xs text-red-200">{requestError}</p>
            <button onClick={() => setRequestError("")}
              className="shrink-0 text-xs text-red-200/70 hover:text-red-100 whitespace-nowrap">Dismiss</button>
          </div>
        </div>
      )}

      {/* Header */}
      <header className="relative z-10 border-b border-white/10 px-6 py-4">
        <div className="max-w-2xl mx-auto flex items-center justify-between">
          {/* Both header labels return to the home view. Without them, home was
              reachable only on arrival: once a tab was selected there was no way
              back to the explainer short of reloading. */}
          <button type="button" onClick={goHome} aria-label="Back to portal home"
            className="flex items-center gap-3 rounded-lg transition-opacity hover:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40">
            <span className="text-sm font-semibold tracking-[0.2em]">C O N T Y N T</span>
            <span className="text-[10px] font-bold tracking-widest text-yellow-400 border border-yellow-400/40 px-1.5 py-0.5 rounded">BETA</span>
          </button>
          <div className="flex items-center gap-3">
            <button type="button" onClick={goHome} aria-label="Back to portal home"
              className="text-xs text-neutral-500 hover:text-neutral-300 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40 rounded">
              Creator Portal
            </button>
            {!isImpersonating && (
              <button onClick={() => {
                // Revoke the session on the server, not just in this browser.
                // Clearing storage alone left the token live for ever -- it
                // carries no expiry -- so anyone still holding a copy kept full
                // access after the creator thought they had signed out. Fire
                // and forget: a failed revoke must not trap them in the portal.
                api("/creator-portal/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) }).catch(() => {});
                try { localStorage.removeItem(CREATOR_TOKEN_KEY); } catch { /* private mode */ }
                // Straight to the login screen with no token in the URL, so a
                // back button press cannot restore the session just cleared.
                window.location.replace(`${window.location.origin}/app`);
              }}
                className="text-xs text-neutral-500 hover:text-neutral-300">Sign out</button>
            )}
          </div>
        </div>
      </header>

      <main className="relative z-10 w-full max-w-2xl mx-auto px-4 sm:px-6 py-8 space-y-6 flex-1 min-w-0 overflow-x-hidden">
        {/* Welcome */}
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45 }} className="space-y-1">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-semibold">
              {creator?.instagram ? `Welcome, @${creator.instagram.replace(/^@/, "")}` : "Welcome"}
            </h1>
            <div className="flex items-center gap-1.5 bg-green-500/15 border border-green-500/25 px-2.5 py-1 rounded-full">
              <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
              <span className="text-xs font-medium text-green-400">Active</span>
            </div>
            {ambassador.state?.enabled && (
              <div className="flex items-center gap-1.5 bg-purple-500/15 border border-purple-400/30 px-2.5 py-1 rounded-full">
                <Award className="w-3 h-3 text-purple-300" />
                <span className="text-xs font-medium text-purple-200">Ambassador</span>
              </div>
            )}
          </div>
          {creator?.city && (
            <p className="text-xs text-neutral-500">
              {creator.city.split("-").map((w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ")}
            </p>
          )}
          {/* Email display + edit */}
          <div className="flex items-center gap-2">
            {editingEmail ? (
              <form onSubmit={async e => { e.preventDefault(); setCreator(p => p ? { ...p, email: emailInput } : p); setEditingEmail(false); api("/creator-portal/update-email", { method: "POST", body: JSON.stringify({ token, email: emailInput }) }).catch(() => {}); }} className="flex gap-2">
                <input value={emailInput} onChange={e => setEmailInput(e.target.value)} type="email"
                  className="text-xs bg-white/10 border border-white/20 rounded-lg px-2 py-1 text-white placeholder:text-neutral-500 focus:outline-none"
                  placeholder="your@email.com" autoFocus />
                <button type="submit" className="text-xs text-green-400 hover:text-green-300">Save</button>
                <button type="button" onClick={() => setEditingEmail(false)} className="text-xs text-neutral-500">Cancel</button>
              </form>
            ) : (
              <>
                <span className="text-xs text-neutral-500">{creator?.email || "No email set"}</span>
                <button onClick={() => { setEmailInput(creator?.email || ""); setEditingEmail(true); }}
                  className="text-[10px] text-neutral-600 hover:text-neutral-400 border border-white/10 px-1.5 py-0.5 rounded">Edit</button>
              </>
            )}
          </div>
        </motion.div>

        {/* Stats — above How it Works: the numbers are what a returning creator
            comes back to check, and the explainer is for the first visit. */}
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: 0.06 }}>
          <StatsBar
            stats={stats}
            instagram={creator?.instagram || ""}
            earnedGlow={earnedGlow}
            onOpenWallet={() => { setEarnedGlow(false); setWalletOpen(true); }}
          />
        </motion.div>

        {/* Tabs sit directly under the stats. Everything below is the body of
            whichever tab is selected, including the home view. */}
        {(() => {
          const selectedCount = Object.values(claims).filter(c => (c.status as any) === "admin_approved").length;
          const pendingCashOut = Object.values(claims).filter(c => c.status === "approved").length;
          const completedByMe = features.filter(f => f.status === "completed" && (f as any).winnerInstagram?.replace(/^@/,"").toLowerCase() === (creator?.instagram||"").replace(/^@/,"").toLowerCase()).length;
          const completedCount = pendingCashOut + completedByMe;
          const availableCount = features.filter(f => f.status === "available").length;
          const activityCount = features.filter(f => f.status === "completed").length + activityFeed.length;

          const featsUnread = availableCount > featsSeen && portalTab !== "features";
          const compUnread  = pendingCashOut > 0 && portalTab !== "completed";
          const actUnread   = (activityCount > actSeen || creditUnread) && portalTab !== "activity";

          const handleTabClick = (tab: "features" | "completed" | "activity" | "ambassador") => {
            setPortalTab(tab);
            if (tab === "features") {
              setFeatsSeen(availableCount);
              try { localStorage.setItem(featSeenKey, String(availableCount)); } catch {}
            } else if (tab === "completed") {
              setCompSeen(completedCount);
              try { localStorage.setItem(compSeenKey, String(completedCount)); } catch {}
            } else if (tab === "activity") {
              setCreditUnread(false);
              setEarnedGlow(false);
              setActSeen(activityCount);
              try { localStorage.setItem(actSeenKey, String(activityCount)); } catch {}
            }
          };

          return (
            <div className="flex gap-0 border-b border-white/10">
              {(["features", "completed", "activity", "ambassador"] as const).map(tab => (
                <button key={tab} onClick={() => handleTabClick(tab)}
                  className={`relative px-4 py-2.5 text-sm font-medium transition-all border-b-2 -mb-px flex items-center gap-2 ${
                    tab === "ambassador"
                      ? (portalTab === tab
                          ? "border-purple-400 text-purple-200"
                          : "border-transparent text-purple-300/70 hover:text-purple-200")
                      : (portalTab === tab
                          ? "border-white text-white"
                          : "border-transparent text-neutral-500 hover:text-neutral-300")
                  }`}>
                  {tab === "ambassador" && <Award className="w-3.5 h-3.5" />}
                  {tab === "features" ? "Features" : tab === "completed" ? "Completed" : tab === "activity" ? "Activity" : "Ambassador"}
                  {tab === "features" && availableCount > 0 && (
                    <span className={`flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold ${featsUnread ? "bg-green-400 text-neutral-900 animate-pulse" : "bg-white/15 text-neutral-300"}`}>
                      {availableCount}
                    </span>
                  )}
                  {tab === "completed" && completedCount > 0 && (
                    <span className={`flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold ${compUnread ? "bg-green-400 text-neutral-900 animate-pulse" : "bg-white/15 text-neutral-300"}`}>
                      {completedCount}
                    </span>
                  )}
                  {/* No count here — Activity shows only an unread dot, which
                      clears once the tab is opened. */}
                  {tab === "activity" && actUnread && (
                    <span aria-label="New activity" className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                  )}
                </button>
              ))}
            </div>
          );
        })()}

        {/* Features tab */}
        {walletOpen && (
          <WalletModal
            stats={stats}
            token={token}
            payouts={payouts}
            // Flipped locally so the row says "Looking into it" straight away.
            // The next poll brings the same thing back from the server.
            onReported={(id) => setPayouts(ps => ps.map(p =>
              p.id === id ? { ...p, notReceivedAt: new Date().toISOString(), issueResolvedAt: null } : p))}
            onClose={() => setWalletOpen(false)}
            onRequested={(amount) => {
              setEarnedGlow(false);
              // Move it from available to pending straight away: the money is
              // spoken for, so the Earned tile should stop offering it rather
              // than waiting for the next load to catch up.
              setStats(p => ({
                ...p,
                availableEarnings: 0,
                pendingEarnings: (p.pendingEarnings ?? 0) + amount,
              }));
            }}
          />
        )}


        {/* Home only. Clicking into a tab replaces the explainer and the
            ambassador pitch with that tab's content, rather than leaving a
            first-run introduction stuck above every screen. */}
        {portalTab === "home" && (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: 0.12 }}
            className="bg-white/5 border border-white/10 rounded-2xl p-5 space-y-3">
            <div className="flex items-center justify-center gap-2">
              <Award className="w-4 h-4 text-yellow-400" />
              <p className="text-sm font-medium text-white">How it Works</p>
            </div>
            <div className="space-y-2 text-xs text-neutral-400">
              <p><span className="text-white font-medium">1. Request</span> — Pick a feature near you. Only request it if you're ready to film it.</p>
              <p><span className="text-white font-medium">2. Get Selected</span> — If the business picks you, you'll get a notification to start.</p>
              <p><span className="text-white font-medium">3. Film and Post</span> — Shoot at the location, hit the requirements and post your Reel within 5 days.</p>
              <p><span className="text-white font-medium">4. Submit</span> — Drop your Reel URL for review.</p>
              <p><span className="text-white font-medium">5. Get Paid</span> — Once approved, your earnings are added to your balance. Cash out any time.</p>
            </div>
          </motion.div>

        )}

        {/* Sits directly beneath How it Works so the two read as one stacked
            pair, and leaves with it when a tab is selected. */}
        {portalTab === "home" && !ambassador.state?.enabled && (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: 0.16 }}>
            <AmbassadorEmptyState onLearnMore={() => setPortalTab("ambassador")} />
          </motion.div>
        )}

        {portalTab === "features" && (
          <div className="w-full flex flex-col gap-4">
            {/* Above the cards rather than below: the question a creator opens
                this tab with is "is any of this near me", and the list answers
                it one address at a time.

                Anything in progress is pinned too, and pinned brighter. An
                earlier cut showed only unclaimed Features, which meant pressing
                Request made the pin vanish -- the one moment a creator most
                wants to see where the thing is, and the map answered by
                dropping it. */}
            <FeaturesMap
              apiKey={placesKey}
              features={features
                .filter(f => {
                  const c = claims[f.id];
                  if (c) return ["interested", "admin_approved", "claimed", "submitted"].includes(c.status as string);
                  return f.status === "available";
                })
                // "interested" is what the Request button sets and what the card
                // labels "Requested" -- asked for, not yet granted. The rest are
                // Features the creator is actually holding.
                .map(f => {
                  const st = claims[f.id]?.status as string | undefined;
                  return {
                    ...f,
                    pinState: !st ? "available" as const
                      : st === "interested" ? "requested" as const
                      : "active" as const,
                  };
                })}
            />
            {(() => {
              const hasAvailable = features.some(f => f.status === "available" && !claims[f.id]);
              // Count claims that will actually render a card in the features tab
              // Must match exactly the filter in the claims rendering section below
              const hasVisibleClaim = Object.entries(claims).some(([fid, c]) => {
                if (!["interested","admin_approved","claimed","submitted","denied"].includes(c.status as string)) return false;
                const f = features.find(ft => ft.id === fid);
                if (!f) return false;
                if (f.status === "completed" && (c.status as string) !== "approved") return false;
                return true;
              });
              return !hasAvailable && !hasVisibleClaim ? (
                <div className="bg-white/5 border border-white/10 rounded-2xl px-6 py-8 text-center">
                  <TrendingUp className="w-8 h-8 text-neutral-600 mx-auto mb-3" />
                  <p className="text-neutral-400 text-sm">No live features right now. Check back soon.</p>
                </div>
              ) : null;
            })()}
            {/* Interested/in-progress features — always on top, ordered by how
                much they still want from the creator. These render in whatever
                order the claims object happened to be built in otherwise, so a
                Reel under review could sit below one merely requested. */}
            {Object.entries(claims).filter(([, c]) => ["interested","admin_approved","claimed","submitted","denied"].includes(c.status as string))
              .sort(([, a], [, b]) => (CLAIM_TAB_ORDER[a.status as string] ?? 9) - (CLAIM_TAB_ORDER[b.status as string] ?? 9))
              .map(([fid, claim]) => {
              const f = features.find(ft => ft.id === fid);
              if (!f) return null;
              // Hide from Features tab if feature is globally claimed and this creator isn't the winner
              if (f.status === "completed" && claim.status !== "approved") return null;
              return (
                <motion.div key={fid} className="w-full min-w-0" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
                  <FeatureCard feature={f} claim={claim} token={token} needsAttention={featureNeedsAttention(f.id)} onSeen={() => markActionSeen(f.id)}
                    showAmbassadorUpsell={!ambassador.state?.enabled && claim.status === "claimed"}
                    isAmbassador={!!ambassador.state?.enabled && claim.status === "claimed"}
                    onLearnAmbassador={() => setPortalTab("ambassador")}
                    onClaim={() => claimFeature(fid)} onUnclaim={() => unclaimFeature(fid)}
                    onAccept={() => acceptFeature(fid)}
                    onSubmit={(url, ho, hr) => submitReel(fid, url, ho, hr)}
                    onPayout={(amt) => requestPayout(fid, amt)}
                    fake={false} myInstagram={creator?.instagram || ""} />
                </motion.div>
              );
            })}
            {/* Unclaimed available features — below requested ones */}
            {features.filter(f => f.status === "available" && !claims[f.id]).map((feature, i) => (
              <motion.div key={feature.id} className="w-full min-w-0"
                initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.35, delay: i * 0.05 }}>
                <FeatureCard feature={feature} claim={claims[feature.id]} token={token} needsAttention={featureNeedsAttention(feature.id)} onSeen={() => markActionSeen(feature.id)} showAmbassadorUpsell={!ambassador.state?.enabled && claims[feature.id]?.status === "claimed"} isAmbassador={!!ambassador.state?.enabled && claims[feature.id]?.status === "claimed"} onLearnAmbassador={() => setPortalTab("ambassador")}
                  onClaim={() => claimFeature(feature.id)} onUnclaim={() => unclaimFeature(feature.id)}
                  onAccept={() => acceptFeature(feature.id)}
                  onSubmit={(url, ho, hr) => submitReel(feature.id, url, ho, hr)}
                  onPayout={(amt) => requestPayout(feature.id, amt)}
                  fake={false} claimedBy={(feature as any).claimedBy} myInstagram={creator?.instagram || ""} />
              </motion.div>
            ))}
          </div>
        )}

        {/* Completed tab — payout-ready + cashed-out features */}
        {portalTab === "completed" && (() => {
          const myInstagram = creator?.instagram || "";
          const approvedClaims = Object.entries(claims).filter(([, c]) => c.status === "approved");
          // Exclude features already shown via approvedClaims to avoid duplicates
          const approvedFeatureIds = new Set(approvedClaims.map(([fid]) => fid));
          const completedFeatures = features.filter(f =>
            f.status === "completed" &&
            !approvedFeatureIds.has(f.id) &&
            (f as any).winnerInstagram?.replace(/^@/,"").toLowerCase() === myInstagram.replace(/^@/,"").toLowerCase()
          );
          const isEmpty = approvedClaims.length === 0 && completedFeatures.length === 0;
          return (
            <div className="w-full flex flex-col gap-4">
              {isEmpty && (
                <div className="bg-white/5 border border-white/10 rounded-2xl px-6 py-8 text-center">
                  <CheckCircle className="w-8 h-8 text-neutral-600 mx-auto mb-3" />
                  <p className="text-neutral-400 text-sm">No completed features yet.</p>
                </div>
              )}
              {/* Payout-ready (approved) claims — Cash Out available */}
              {approvedClaims.map(([fid, claim]) => {
                const f = features.find(ft => ft.id === fid);
                if (!f) return null;
                return (
                  <motion.div key={fid} className="w-full min-w-0" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
                    <FeatureCard feature={f} claim={claim} token={token} needsAttention={featureNeedsAttention(f.id)} onSeen={() => markActionSeen(f.id)}
                      onClaim={() => {}} onUnclaim={() => {}} onAccept={() => {}} onSubmit={() => {}} onPayout={(amt) => requestPayout(fid, amt)}
                      fake={false} myInstagram={myInstagram} />
                  </motion.div>
                );
              })}
              {/* Cashed-out completed features */}
              {completedFeatures.map((feature) => (
                <motion.div key={feature.id} className="w-full min-w-0" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
                  <FeatureCard feature={feature} claim={claims[feature.id]} token={token} needsAttention={featureNeedsAttention(feature.id)} onSeen={() => markActionSeen(feature.id)} showAmbassadorUpsell={!ambassador.state?.enabled && claims[feature.id]?.status === "claimed"} isAmbassador={!!ambassador.state?.enabled && claims[feature.id]?.status === "claimed"} onLearnAmbassador={() => setPortalTab("ambassador")}
                    onClaim={() => {}} onUnclaim={() => {}} onAccept={() => {}} onSubmit={() => {}} onPayout={(amt) => requestPayout(feature.id, amt)}
                    fake={false} myInstagram={myInstagram} />
                </motion.div>
              ))}
            </div>
          );
        })()}

        {/* Activity tab — every completed Feature, the creator's own included */}
        {portalTab === "activity" && (
          <div className="w-full flex flex-col gap-4">
            <p className="text-xs text-neutral-500">Features recently claimed.</p>
            {(() => {
              const all = [
                // The creator's own completed Features belong here too. They stay
                // unmasked and read "Claimed by You" -- there is nothing to hide
                // from someone about their own work.
                ...features.filter(f => f.status === "completed").slice().reverse(),
                ...activityFeed,
              ];
              const PER_PAGE = 5;
              const pages = Math.max(1, Math.ceil(all.length / PER_PAGE));
              // Clamped rather than trusted. The list shrinks when a Feature of
              // the creator's own leaves it, and a page index left pointing past
              // the end would render an empty tab with no way back.
              const page = Math.min(activityPage, pages - 1);
              const shown = all.slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE);

              if (all.length === 0) {
                return (
                  <div className="bg-white/5 border border-white/10 rounded-2xl px-6 py-8 text-center">
                    <TrendingUp className="w-8 h-8 text-neutral-600 mx-auto mb-3" />
                    <p className="text-neutral-400 text-sm">Nothing claimed yet. Features go first come, first served.</p>
                  </div>
                );
              }

              return (
                <>
                  {shown.map((feature) => (
                    <motion.div key={feature.id} className="w-full min-w-0" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
                      <FeatureCard feature={feature} claim={undefined} token={token}
                        onClaim={() => {}} onUnclaim={() => {}} onAccept={() => {}} onSubmit={() => {}} onPayout={() => {}}
                        fake={true} claimedBy={(feature as any).claimedBy || (feature as any).winnerInstagram || ""}
                        myInstagram={creator?.instagram || ""} />
                    </motion.div>
                  ))}

                  {pages > 1 && (
                    <div className="flex items-center justify-between gap-3 pt-1">
                      {/* Newer sits on the left and only once there is a page to
                          go back to, so the first thing on screen is the one
                          control that does something. */}
                      {page > 0 ? (
                        <button
                          onClick={() => setActivityPage(p => Math.max(0, p - 1))}
                          className="inline-flex items-center gap-1 text-xs text-neutral-400 hover:text-white transition-colors"
                        >
                          <ChevronLeft className="w-4 h-4" />Newer
                        </button>
                      ) : <span />}

                      <span className="text-[11px] text-neutral-600">{page + 1} / {pages}</span>

                      {page < pages - 1 ? (
                        <button
                          onClick={() => setActivityPage(p => Math.min(pages - 1, p + 1))}
                          className="inline-flex items-center gap-1 text-xs text-neutral-400 hover:text-white transition-colors"
                        >
                          Older<ChevronRight className="w-4 h-4" />
                        </button>
                      ) : <span />}
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        )}

        {/* Ambassador tab */}
        {portalTab === "ambassador" && (
          <div className="w-full min-w-0">
            <AmbassadorPanel
              token={token}
              instagram={creator?.instagram || ""}
              state={ambassador.state}
              loading={ambassador.loading}
              onRefresh={ambassador.refresh}
            />
          </div>
        )}
      </main>

      {/* Footer */}

      <footer className="relative z-10 border-t border-white/10 px-6 py-8 mt-6">
        <div className="max-w-2xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <span className="text-sm font-semibold tracking-[0.2em] text-white">C O N T Y N T</span>
          <p className="text-xs text-neutral-500 text-center">
            Questions?{" "}
            <a href="mailto:team@getcontynt.com" className="text-neutral-400 hover:text-white transition-colors underline underline-offset-2">
              team@getcontynt.com
            </a>
          </p>
          <p className="text-xs text-neutral-600">© {new Date().getFullYear()} CONTYNT</p>
        </div>
      </footer>
    </div>
  );
}
