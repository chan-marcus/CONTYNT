import { useEffect, useState, useCallback } from "react";
import QRCode from "qrcode";
import { Award, Copy, Check, Printer, Download, Share2, QrCode, Users, Clock, Building2, DollarSign, Sparkles } from "lucide-react";
import { projectId, publicAnonKey } from "/utils/supabase/info";

const BASE = `https://${projectId}.supabase.co/functions/v1/make-server-f5961d0c`;
const AUTH = { Authorization: `Bearer ${publicAnonKey}`, "Content-Type": "application/json" };
const api = (path: string, opts?: RequestInit) =>
  fetch(`${BASE}${path}`, { ...opts, headers: { ...AUTH, ...(opts?.headers ?? {}) } });

export interface AmbassadorState {
  enabled: boolean;
  ambassador: { referralCode: string; referralUrl: string; creatorInstagram: string; createdAt: string } | null;
  stats: { businessesReferred: number; pendingReferrals: number; activeBusinesses: number; rewardsEarned: number; rewardsPending: number } | null;
  referrals: { id: string; businessName: string; status: string; rewardStatus: string; rewardAmount: number; createdAt: string }[];
}

export const REFERRAL_REWARD = 25;

// Shared purple treatment — Ambassador reads as a tier, not a banner.
const PURPLE_CARD = "bg-purple-500/10 border border-purple-400/25 rounded-2xl";

export function useAmbassador(token: string) {
  const [state, setState] = useState<AmbassadorState | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await api(`/creator-portal/ambassador?t=${encodeURIComponent(token)}`);
      if (res.ok) setState(await res.json());
    } catch { /* leave previous state */ }
    setLoading(false);
  }, [token]);

  useEffect(() => { refresh(); }, [refresh]);
  return { state, loading, refresh };
}

// ─── Upsell shown inside active feature cards ────────────────────────────────
export function AmbassadorUpsell({ onLearnMore }: { onLearnMore: () => void }) {
  return (
    <div className={`${PURPLE_CARD} px-4 py-3 flex items-start gap-3`}>
      <Sparkles className="w-4 h-4 text-purple-300 shrink-0 mt-0.5" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-white">Want to earn more?</p>
        <p className="text-xs text-neutral-400 mt-1 leading-relaxed">
          Become a CONTYNT Ambassador and earn ${REFERRAL_REWARD} for every successful business
          referral, plus unlock exclusive creator opportunities.
        </p>
      </div>
      <button onClick={onLearnMore}
        className="shrink-0 self-center px-3 py-1.5 text-xs font-medium rounded-lg bg-purple-500/25 text-purple-100 border border-purple-400/30 hover:bg-purple-500/35 transition-all whitespace-nowrap">
        Learn More
      </button>
    </div>
  );
}

// ─── Larger upsell for creators with nothing active ──────────────────────────
export function AmbassadorEmptyState({ onLearnMore }: { onLearnMore: () => void }) {
  return (
    <div className={`${PURPLE_CARD} p-6 space-y-4`}>
      <div className="flex items-center gap-2">
        <Award className="w-5 h-5 text-purple-300" />
        <h3 className="text-base font-bold text-white">Become a CONTYNT Ambassador</h3>
      </div>
      <p className="text-sm text-neutral-400 leading-relaxed">
        Help local businesses discover CONTYNT and earn referral rewards by introducing
        businesses to the platform.
      </p>
      <ul className="space-y-2">
        {[`Earn $${REFERRAL_REWARD} per successful referral`,
          "Unlock exclusive creator opportunities",
          "Grow your creator profile within CONTYNT"].map(b => (
          <li key={b} className="flex items-start gap-2 text-sm text-neutral-300">
            <Check className="w-4 h-4 text-purple-300 shrink-0 mt-0.5" />{b}
          </li>
        ))}
      </ul>
      <button onClick={onLearnMore}
        className="w-full py-2.5 text-sm font-semibold rounded-xl bg-purple-500 text-white hover:bg-purple-400 transition-all">
        Learn More
      </button>
    </div>
  );
}

// ─── Instructions shown on in-progress features for ambassadors ──────────────
const AMBASSADOR_STEPS = [
  "Visit the business location.",
  "Introduce yourself as a CONTYNT Ambassador.",
  "Show the owner your Ambassador printable.",
  "Have the owner scan your QR code.",
  "Help them complete CONTYNT signup.",
  "If the owner is unavailable, leave the printable with an employee or manager.",
  "Submit referral confirmation inside CONTYNT.",
];

export function AmbassadorInstructions() {
  return (
    <div className={`${PURPLE_CARD} px-4 py-3.5 space-y-2.5`}>
      <div className="flex items-center gap-2">
        <Award className="w-4 h-4 text-purple-300" />
        <p className="text-xs font-semibold text-white uppercase tracking-widest">Ambassador Instructions</p>
      </div>
      <ol className="space-y-1.5">
        {AMBASSADOR_STEPS.map((step, i) => (
          <li key={i} className="flex items-start gap-2.5 text-xs text-neutral-300 leading-relaxed">
            <span className="shrink-0 w-4 h-4 rounded-full bg-purple-500/25 border border-purple-400/30 text-[9px] font-bold text-purple-100 flex items-center justify-center mt-0.5">
              {i + 1}
            </span>
            {step}
          </li>
        ))}
      </ol>
    </div>
  );
}

// ─── Onboarding (Ambassador Mode off) ────────────────────────────────────────
function Onboarding({ token, onEnabled }: { token: string; onEnabled: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const enable = async () => {
    setBusy(true); setError("");
    try {
      const res = await api("/creator-portal/ambassador/enable", { method: "POST", body: JSON.stringify({ token }) });
      if (!res.ok) { setError((await res.json().catch(() => null))?.error || "Could not enable Ambassador Mode."); setBusy(false); return; }
      onEnabled();
    } catch { setError("Could not reach the server."); }
    setBusy(false);
  };

  const benefits = [
    {
      icon: DollarSign, title: "Earn Referral Rewards",
      body: `Earn $${REFERRAL_REWARD} for every successful business referral.`,
      rules: [
        "Business must be fully onboarded.",
        "Business must remain active for 30 days.",
        `After requirements are completed, you earn $${REFERRAL_REWARD}.`,
      ],
    },
    { icon: Sparkles, title: "Exclusive Opportunities", body: "Get access to special campaigns, opportunities, and creator programs." },
    { icon: Building2, title: "Help Local Businesses Grow", body: "Use your local influence to connect businesses with authentic creator marketing." },
  ];

  return (
    <div className="space-y-5">
      <div className="text-center space-y-2">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-purple-500/20 border border-purple-400/30">
          <Award className="w-6 h-6 text-purple-300" />
        </div>
        <h2 className="text-xl font-bold text-white">Become an Ambassador</h2>
        <p className="text-sm text-neutral-400 leading-relaxed max-w-md mx-auto">
          Ambassador Mode gives selected creators the ability to represent CONTYNT, help local
          businesses discover the platform, and earn additional rewards by onboarding new businesses.
        </p>
      </div>

      <div className="space-y-3">
        {benefits.map(b => (
          <div key={b.title} className={`${PURPLE_CARD} p-4 space-y-2`}>
            <div className="flex items-center gap-2">
              <b.icon className="w-4 h-4 text-purple-300" />
              <p className="text-sm font-semibold text-white">{b.title}</p>
            </div>
            <p className="text-xs text-neutral-400 leading-relaxed">{b.body}</p>
            {b.rules && (
              <ul className="space-y-1 pt-1">
                {b.rules.map(r => (
                  <li key={r} className="flex items-start gap-2 text-xs text-neutral-500">
                    <span className="w-1 h-1 rounded-full bg-purple-400/60 shrink-0 mt-1.5" />{r}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>

      {error && <p className="text-xs text-red-400 text-center">{error}</p>}
      <button onClick={enable} disabled={busy}
        className="w-full py-3.5 text-sm font-bold rounded-xl bg-purple-500 text-white hover:bg-purple-400 transition-all disabled:opacity-50 shadow-lg shadow-purple-500/20">
        {busy ? "Enabling…" : "Enable Ambassador Mode"}
      </button>
    </div>
  );
}

// ─── Ambassador cards (per approved Feature) ─────────────────────────────────
export interface AmbassadorCard {
  id: string; featureId: string; code: string;
  printedAt: string | null; handedOffAt: string | null;
  handoffStatus: string; isAttributed: boolean;
}

export function useCards(token: string, enabled: boolean) {
  const [cards, setCards] = useState<Record<string, AmbassadorCard>>({});
  const [meta, setMeta] = useState<{ handoffScript: string; attributionRule: string; unprintedCount: number } | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      const res = await api(`/portal/cards?t=${encodeURIComponent(token)}`);
      if (!res.ok) return;
      const d = await res.json();
      const byFeature: Record<string, AmbassadorCard> = {};
      for (const c of (d.cards ?? [])) byFeature[c.featureId] = c;
      setCards(byFeature);
      setMeta({ handoffScript: d.handoffScript, attributionRule: d.attributionRule, unprintedCount: d.unprintedCount ?? 0 });
    } catch { /* leave previous state */ }
  }, [token, enabled]);

  useEffect(() => { refresh(); }, [refresh]);
  return { cards, meta, refresh };
}

// Shown before the shoot checklist, because the card has to be in the creator's
// hand before they go, not remembered on the way out.
export function AmbassadorCardStep({ card, token, script, rule, unprintedCount, onPrinted }: {
  card: AmbassadorCard; token: string; script: string; rule: string;
  unprintedCount: number; onPrinted: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const q = `?t=${encodeURIComponent(token)}`;
  const open = (path: string) => {
    window.open(`${BASE}${path}`, "_blank", "noopener");
    // printed_at is stamped server-side on first download; refresh so the step
    // stops nagging once they have actually printed it.
    setTimeout(onPrinted, 1200);
  };

  return (
    <div className={`${PURPLE_CARD} px-4 py-3.5 space-y-3`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Printer className="w-4 h-4 text-purple-300" />
          <p className="text-xs font-semibold text-white uppercase tracking-widest">Print your card</p>
        </div>
        {card.printedAt && (
          <span className="text-[10px] text-green-400 flex items-center gap-1">
            <Check className="w-3 h-3" />Printed
          </span>
        )}
      </div>

      <div className="flex items-center gap-2">
        <code className="flex-1 text-center text-lg font-bold tracking-[0.2em] bg-black/30 border border-white/10 rounded-lg py-2 text-purple-200">
          {card.code}
        </code>
        <button onClick={() => { navigator.clipboard.writeText(card.code); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
          className="shrink-0 px-3 py-2 rounded-lg bg-white/10 text-neutral-200 hover:bg-white/15 transition-all">
          {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <button onClick={() => open(`/portal/cards/${card.id}/print${q}`)}
          className="flex items-center justify-center gap-2 py-2.5 text-xs rounded-xl bg-white/5 border border-white/10 text-neutral-200 hover:border-purple-400/40 transition-all">
          <Printer className="w-3.5 h-3.5" />Print card
        </button>
        <button onClick={() => open(`/portal/cards/${card.id}/screen${q}`)}
          className="flex items-center justify-center gap-2 py-2.5 text-xs rounded-xl bg-white/5 border border-white/10 text-neutral-200 hover:border-purple-400/40 transition-all">
          <QrCode className="w-3.5 h-3.5" />Show on screen
        </button>
      </div>

      {unprintedCount > 1 && (
        <button onClick={() => open(`/portal/cards/${card.id}/print${q}&batch=1`)}
          className="w-full py-2 text-[11px] text-purple-300 hover:text-purple-200">
          Print all {unprintedCount} unprinted cards on one sheet
        </button>
      )}

      <div className="bg-black/20 border border-white/10 rounded-xl px-3 py-2.5">
        <p className="text-[10px] uppercase tracking-widest text-neutral-500 mb-1.5">Say this</p>
        <p className="text-xs text-neutral-300 leading-relaxed italic">"{script}"</p>
      </div>

      <p className="text-[11px] text-neutral-500 leading-relaxed">{rule}</p>
    </div>
  );
}

// Required on submission when a card exists for this Feature.
export function HandoffQuestion({ value, onChange, reason, onReason }: {
  value: boolean | null; onChange: (v: boolean) => void;
  reason: string; onReason: (v: string) => void;
}) {
  return (
    <div className={`${PURPLE_CARD} px-4 py-3.5 space-y-2.5`}>
      <p className="text-xs font-semibold text-white">Did you hand off the card?</p>
      <div className="grid grid-cols-2 gap-2">
        <button type="button" onClick={() => onChange(true)}
          className={`py-2.5 text-xs rounded-xl border transition-all ${
            value === true ? "bg-white text-neutral-900 border-white font-semibold"
                           : "bg-white/5 text-neutral-300 border-white/15 hover:border-white/30"
          }`}>Yes</button>
        <button type="button" onClick={() => onChange(false)}
          className={`py-2.5 text-xs rounded-xl border transition-all ${
            value === false ? "bg-white text-neutral-900 border-white font-semibold"
                            : "bg-white/5 text-neutral-300 border-white/15 hover:border-white/30"
          }`}>No, couldn't</button>
      </div>
      {value === false && (
        <input value={reason} onChange={e => onReason(e.target.value)}
          placeholder="What got in the way?"
          className="w-full px-3 py-2.5 bg-white/10 border border-white/20 rounded-xl text-white text-sm placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-white/20" />
      )}
    </div>
  );
}

// ─── Printable flyer ─────────────────────────────────────────────────────────
function buildPrintable(instagram: string, url: string, qrDataUri: string): string {
  const handle = (instagram || "creator").replace(/^@+/, "");
  // Self-contained so it prints identically from a new window with no styles.
  return `<!doctype html><html><head><meta charset="utf-8"><title>CONTYNT Ambassador — @${handle}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;background:#fff;color:#0a0a0a;
       display:flex;align-items:center;justify-content:center;min-height:100vh;padding:32px}
  .card{width:100%;max-width:640px;border:2px solid #111;border-radius:24px;padding:48px;text-align:center}
  .brand{font-size:13px;font-weight:700;letter-spacing:.42em;margin-bottom:32px}
  h1{font-size:32px;line-height:1.2;font-weight:800;margin-bottom:14px}
  p.lead{font-size:16px;line-height:1.55;color:#444;margin-bottom:28px}
  .qr{width:200px;height:200px;margin:0 auto 12px}
  .scan{font-size:14px;font-weight:600;margin-bottom:26px}
  .creator{border-top:1px solid #e5e5e5;padding-top:22px;font-size:14px;color:#444}
  .creator strong{display:block;font-size:17px;color:#0a0a0a;margin-bottom:3px}
  .url{margin-top:10px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:#666;word-break:break-all}
  @media print{body{padding:0}.card{border:none}}
</style></head><body>
  <div class="card">
    <div class="brand">C O N T Y N T</div>
    <h1>Grow your business with authentic local creators.</h1>
    <p class="lead">Join CONTYNT and connect with creators who help businesses get discovered.</p>
    <img class="qr" src="${qrDataUri}" alt="Scan to join CONTYNT">
    <p class="scan">Scan to get started.</p>
    <div class="creator">
      <strong>Referred by @${handle}</strong>
      Your local CONTYNT Ambassador
      <div class="url">${url}</div>
    </div>
  </div>
</body></html>`;
}

// ─── Ambassador dashboard (Ambassador Mode on) ───────────────────────────────
function Dashboard({ state, instagram }: { state: AmbassadorState; instagram: string }) {
  const amb = state.ambassador!;
  const [qr, setQr] = useState("");
  const [copied, setCopied] = useState(false);
  const [showQr, setShowQr] = useState(false);

  useEffect(() => {
    // Generated from the referral URL itself, so the code and the QR can never
    // disagree.
    QRCode.toDataURL(amb.referralUrl, { width: 480, margin: 1 })
      .then(setQr).catch(() => setQr(""));
  }, [amb.referralUrl]);

  const copy = () => {
    navigator.clipboard.writeText(amb.referralUrl);
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  };

  const openPrintable = (print: boolean) => {
    if (!qr) return;
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(buildPrintable(instagram, amb.referralUrl, qr));
    w.document.close();
    if (print) setTimeout(() => w.print(), 400);
  };

  const share = async () => {
    const data = { title: "Join CONTYNT", text: "Grow your business with authentic local creators.", url: amb.referralUrl };
    // Web Share only exists on most mobile browsers; fall back to copying.
    if (navigator.share) { try { await navigator.share(data); return; } catch { /* cancelled */ } }
    copy();
  };

  const downloadQr = () => {
    if (!qr) return;
    const a = document.createElement("a");
    a.href = qr; a.download = `contynt-ambassador-${amb.referralCode}.png`; a.click();
  };

  const s = state.stats!;
  const cards = [
    { label: "Businesses Referred", value: s.businessesReferred, icon: Building2 },
    { label: "Pending Referrals", value: s.pendingReferrals, icon: Clock },
    { label: "Active Businesses", value: s.activeBusinesses, icon: Users },
    { label: "Rewards Earned", value: `$${s.rewardsEarned}`, icon: DollarSign },
    { label: "Rewards Pending", value: `$${s.rewardsPending}`, icon: Clock },
  ];

  return (
    <div className="space-y-5">
      <div className={`${PURPLE_CARD} p-5 space-y-4`}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Award className="w-5 h-5 text-purple-300" />
            <div>
              <p className="text-sm font-bold text-white">Ambassador</p>
              <p className="text-[11px] text-neutral-500">
                Since {new Date(amb.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
              </p>
            </div>
          </div>
          {qr && (
            <button onClick={() => setShowQr(v => !v)}
              className="p-2 rounded-lg bg-white/5 border border-white/10 hover:border-purple-400/40 transition-all">
              <QrCode className="w-4 h-4 text-purple-200" />
            </button>
          )}
        </div>

        {showQr && qr && (
          <div className="flex flex-col items-center gap-3 py-2">
            <img src={qr} alt="Your referral QR code" className="w-44 h-44 rounded-xl bg-white p-2" />
            <button onClick={downloadQr} className="text-xs text-purple-300 hover:text-purple-200">Download QR code</button>
          </div>
        )}

        <div className="space-y-1.5">
          <p className="text-[10px] uppercase tracking-widest text-neutral-500">Your referral link</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 min-w-0 truncate text-xs bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-purple-200">
              {amb.referralUrl}
            </code>
            <button onClick={copy}
              className="shrink-0 px-3 py-2 text-xs rounded-lg bg-white/10 text-neutral-200 hover:bg-white/15 transition-all">
              {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {cards.map(c => (
          <div key={c.label} className="bg-white/5 border border-white/10 rounded-2xl p-4">
            <div className="flex items-center gap-1.5 mb-1">
              <c.icon className="w-3.5 h-3.5 text-purple-300" />
              <span className="text-[11px] text-neutral-400 leading-tight">{c.label}</span>
            </div>
            <p className="text-xl font-bold text-white">{c.value}</p>
          </div>
        ))}
      </div>

      <div className="space-y-2">
        <p className="text-[10px] uppercase tracking-widest text-neutral-500">Quick actions</p>
        <div className="grid grid-cols-2 gap-2">
          <button onClick={() => openPrintable(true)} disabled={!qr}
            className="flex items-center justify-center gap-2 py-2.5 text-xs rounded-xl bg-white/5 border border-white/10 text-neutral-200 hover:border-purple-400/40 transition-all disabled:opacity-40">
            <Printer className="w-3.5 h-3.5" />Print Printable
          </button>
          <button onClick={() => openPrintable(false)} disabled={!qr}
            className="flex items-center justify-center gap-2 py-2.5 text-xs rounded-xl bg-white/5 border border-white/10 text-neutral-200 hover:border-purple-400/40 transition-all disabled:opacity-40">
            <Download className="w-3.5 h-3.5" />Open Printable
          </button>
          <button onClick={copy}
            className="flex items-center justify-center gap-2 py-2.5 text-xs rounded-xl bg-white/5 border border-white/10 text-neutral-200 hover:border-purple-400/40 transition-all">
            <Copy className="w-3.5 h-3.5" />Copy Link
          </button>
          <button onClick={share}
            className="flex items-center justify-center gap-2 py-2.5 text-xs rounded-xl bg-white/5 border border-white/10 text-neutral-200 hover:border-purple-400/40 transition-all">
            <Share2 className="w-3.5 h-3.5" />Share Link
          </button>
        </div>
      </div>

      {state.referrals.length > 0 && (
        <div className="space-y-2">
          <p className="text-[10px] uppercase tracking-widest text-neutral-500">Your referrals</p>
          <div className="space-y-2">
            {state.referrals.map(r => (
              <div key={r.id} className="bg-white/5 border border-white/10 rounded-xl px-4 py-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm text-white truncate">{r.businessName}</p>
                  <p className="text-[11px] text-neutral-500">{r.status.replace(/_/g, " ")}</p>
                </div>
                <span className={`text-xs px-2 py-0.5 rounded-full border shrink-0 ${
                  r.rewardStatus === "paid"
                    ? "bg-green-500/15 text-green-400 border-green-500/25"
                    : "bg-yellow-500/10 text-yellow-400 border-yellow-500/25"
                }`}>
                  ${r.rewardAmount} {r.rewardStatus}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function AmbassadorPanel({ token, instagram, state, loading, onRefresh }: {
  token: string; instagram: string;
  state: AmbassadorState | null; loading: boolean; onRefresh: () => void;
}) {
  if (loading) return <p className="text-sm text-neutral-500 text-center py-8">Loading…</p>;
  if (!state) return <p className="text-sm text-neutral-500 text-center py-8">Could not load Ambassador details.</p>;
  return state.enabled && state.ambassador
    ? <Dashboard state={state} instagram={instagram} />
    : <Onboarding token={token} onEnabled={onRefresh} />;
}
