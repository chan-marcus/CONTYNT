import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { Check, Award, Loader2, AlertCircle, X } from "lucide-react";
import { projectId, publicAnonKey } from "/utils/supabase/info";
import { REFERRAL_REWARD } from "./Ambassador";

const BASE = `https://${projectId}.supabase.co/functions/v1/make-server-f5961d0c`;
const AUTH = { Authorization: `Bearer ${publicAnonKey}`, "Content-Type": "application/json" };
const api = (path: string, opts?: RequestInit) =>
  fetch(`${BASE}${path}`, { ...opts, headers: { ...AUTH, ...(opts?.headers ?? {}) } });

// Matches the Ambassador panel so the block reads as the same tier, not a new
// section bolted onto the form.
const PURPLE_CARD = "bg-purple-500/10 border border-purple-400/25 rounded-2xl";
const FIELD = "w-full px-3 py-2.5 bg-white/10 border border-white/20 rounded-xl text-white text-sm placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-white/20";

const AMBASSADOR_COPY =
  "When you shoot a Feature, print a card from your portal and hand it to staff on your way out. " +
  "The card doesn't have your name on it, just a code. If that spot signs up, you get $" +
  REFERRAL_REWARD + ". No pitching, no follow up, no DMs to manage.";

interface ConfirmData {
  neighborhoods: string[];
  verificationStatus: string;
  confirmedAt: string | null;
  profile: {
    instagramHandle: string; serviceAreas: string[]; maxFeaturesPerWeek: number | null;
    notifyEmail: boolean; notifySms: boolean; phone: string;
    portfolioUrl: string; dietaryNotes: string; email: string;
  };
  ambassador: { optedIn: boolean; optedInAt: string | null };
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    // type="button" is load bearing: inside a <form> the default is submit, so
    // flipping this toggle would fire the whole confirmation.
    <button type="button" role="switch" aria-checked={on} aria-label={label}
      onClick={() => onChange(!on)}
      className={`shrink-0 w-11 h-6 rounded-full border transition-all relative ${
        on ? "bg-purple-500 border-purple-400" : "bg-white/10 border-white/20"
      }`}>
      <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${on ? "left-[22px]" : "left-0.5"}`} />
    </button>
  );
}

export function ConfirmProfile({ token }: { token: string }) {
  const [data, setData] = useState<ConfirmData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<{ optedIn: boolean } | null>(null);
  const [dismissedOffer, setDismissedOffer] = useState(false);
  const [togglingAfter, setTogglingAfter] = useState(false);

  const [handle, setHandle] = useState("");
  const [areas, setAreas] = useState<string[]>([]);
  const [capacity, setCapacity] = useState<number | null>(null);
  const [notifyEmail, setNotifyEmail] = useState(true);
  const [notifySms, setNotifySms] = useState(false);
  const [phone, setPhone] = useState("");
  const [portfolio, setPortfolio] = useState("");
  const [dietary, setDietary] = useState("");
  const [ambassador, setAmbassador] = useState(false);

  useEffect(() => {
    api(`/creator-portal/confirm-data?t=${encodeURIComponent(token)}`)
      .then(r => r.json())
      .then((d: ConfirmData) => {
        if (d?.profile) {
          setData(d);
          setHandle(d.profile.instagramHandle || "");
          setAreas(d.profile.serviceAreas || []);
          setCapacity(d.profile.maxFeaturesPerWeek ?? null);
          setNotifyEmail(d.profile.notifyEmail !== false);
          setNotifySms(!!d.profile.notifySms);
          setPhone(d.profile.phone || "");
          setPortfolio(d.profile.portfolioUrl || "");
          setDietary(d.profile.dietaryNotes || "");
          // Default off, per the brief. Reading the stored value rather than
          // hardcoding false matters on a re-confirm: an existing Ambassador
          // who edits their neighborhoods must not be silently opted out.
          setAmbassador(!!d.ambassador?.optedIn);
        } else {
          setError(d && (d as any).error ? (d as any).error : "Could not load your profile.");
        }
      })
      .catch(() => setError("Could not reach the server."))
      .finally(() => setLoading(false));
  }, [token]);

  const toggleArea = (n: string) =>
    setAreas(prev => prev.includes(n) ? prev.filter(a => a !== n) : [...prev, n]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true); setError("");
    try {
      const res = await api("/creator-portal/confirm", {
        method: "POST",
        body: JSON.stringify({
          token, instagramHandle: handle, serviceAreas: areas,
          maxFeaturesPerWeek: capacity, notifyEmail, notifySms, phone,
          portfolioUrl: portfolio, dietaryNotes: dietary, ambassadorOptIn: ambassador,
        }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok || !d?.success) { setError(d?.error || "Could not save your profile."); setSaving(false); return; }
      setDone({ optedIn: !!d.ambassador?.optedIn });
    } catch { setError("Could not reach the server."); }
    setSaving(false);
  };

  // The success card offers the toggle without a second trip through the form.
  const turnOnAfter = async () => {
    setTogglingAfter(true);
    try {
      const res = await api("/creator-portal/ambassador/toggle", {
        method: "POST", body: JSON.stringify({ token, optIn: true }),
      });
      if (res.ok) setDone({ optedIn: true });
    } catch { /* leave the offer up so they can retry */ }
    setTogglingAfter(false);
  };

  if (loading) {
    return (
      <Shell>
        <div className="flex items-center justify-center py-20 text-neutral-500">
          <Loader2 className="w-5 h-5 animate-spin" />
        </div>
      </Shell>
    );
  }

  if (done) {
    return (
      <Shell>
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}
          className="space-y-6 text-center">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-green-500/15 border border-green-400/30">
            <Check className="w-7 h-7 text-green-400" />
          </div>
          <div className="space-y-2">
            <h1 className="text-2xl font-bold">You're confirmed</h1>
            <p className="text-sm text-neutral-400 leading-relaxed">
              You're in the first drop. We'll email you the moment Features open in your neighborhoods.
            </p>
          </div>

          {done.optedIn ? (
            <div className={`${PURPLE_CARD} p-5 space-y-3 text-left`}>
              <div className="flex items-center gap-2">
                <Award className="w-5 h-5 text-purple-300" />
                <h2 className="text-base font-bold text-white">You're an Ambassador</h2>
              </div>
              <p className="text-sm text-neutral-400 leading-relaxed">
                On every Feature you shoot, your portal will show a card to print before the
                shoot checklist. Hand it to staff on your way out. If that spot signs up,
                you earn ${REFERRAL_REWARD}.
              </p>
              <p className="text-xs text-neutral-500 leading-relaxed">
                The card carries a code, not your name. You can turn this off any time in
                your profile settings.
              </p>
            </div>
          ) : !dismissedOffer ? (
            <div className={`${PURPLE_CARD} p-5 space-y-3 text-left relative`}>
              <button type="button" onClick={() => setDismissedOffer(true)} aria-label="Dismiss"
                className="absolute top-3 right-3 p-1 rounded-lg text-neutral-500 hover:text-neutral-300">
                <X className="w-4 h-4" />
              </button>
              <div className="flex items-center gap-2">
                <Award className="w-5 h-5 text-purple-300" />
                <h2 className="text-base font-bold text-white">Want to earn ${REFERRAL_REWARD} more per shoot?</h2>
              </div>
              <p className="text-sm text-neutral-400 leading-relaxed">{AMBASSADOR_COPY}</p>
              <button type="button" onClick={turnOnAfter} disabled={togglingAfter}
                className="w-full py-2.5 text-sm font-semibold rounded-xl bg-purple-500 text-white hover:bg-purple-400 transition-all disabled:opacity-50">
                {togglingAfter ? "Turning on..." : "Turn on Ambassador Mode"}
              </button>
            </div>
          ) : null}

          <a href={`${window.location.origin}/?creator=${encodeURIComponent(token)}`}
            className="inline-block text-sm text-neutral-400 hover:text-white underline underline-offset-4">
            Go to your portal
          </a>
        </motion.div>
      </Shell>
    );
  }

  const capacityOptions = [1, 2, 3, 4];

  return (
    <Shell>
      <form onSubmit={submit} className="space-y-6">
        <div className="space-y-2">
          <h1 className="text-2xl font-bold leading-snug">Confirm your profile</h1>
          <p className="text-sm text-neutral-400 leading-relaxed">
            This is how we match you to Features. It takes about a minute.
          </p>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-neutral-300">Instagram handle</label>
          <div className="flex items-center gap-2">
            <span className="text-neutral-500 text-sm">@</span>
            <input value={handle} onChange={e => setHandle(e.target.value)} required
              placeholder="yourhandle" autoCapitalize="none" autoCorrect="off" spellCheck={false}
              className={FIELD} />
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-xs font-medium text-neutral-300">
            Neighborhoods you can shoot in
            <span className="text-neutral-500 font-normal"> ({areas.length} selected)</span>
          </label>
          <div className="flex flex-wrap gap-2">
            {(data?.neighborhoods ?? []).map(n => {
              const on = areas.includes(n);
              return (
                <button key={n} type="button" onClick={() => toggleArea(n)}
                  className={`px-3 py-1.5 text-xs rounded-full border transition-all ${
                    on ? "bg-white text-neutral-900 border-white font-medium"
                       : "bg-white/5 text-neutral-300 border-white/15 hover:border-white/30"
                  }`}>
                  {n}
                </button>
              );
            })}
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-xs font-medium text-neutral-300">Features per week</label>
          <div className="grid grid-cols-4 gap-2">
            {capacityOptions.map(n => (
              <button key={n} type="button" onClick={() => setCapacity(n)}
                className={`py-2.5 text-sm rounded-xl border transition-all ${
                  capacity === n ? "bg-white text-neutral-900 border-white font-semibold"
                                 : "bg-white/5 text-neutral-300 border-white/15 hover:border-white/30"
                }`}>
                {n === 4 ? "4+" : n}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-3 bg-white/5 border border-white/10 rounded-2xl p-4">
          <p className="text-xs font-medium text-neutral-300">How should we reach you?</p>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm text-white">Email</p>
              <p className="text-xs text-neutral-500 truncate">{data?.profile.email || "your address on file"}</p>
            </div>
            <Toggle on={notifyEmail} onChange={setNotifyEmail} label="Email notifications" />
          </div>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm text-white">Text messages</p>
              <p className="text-xs text-neutral-500">Faster for time sensitive Features.</p>
            </div>
            <Toggle on={notifySms} onChange={setNotifySms} label="SMS notifications" />
          </div>
          {notifySms && (
            <input value={phone} onChange={e => setPhone(e.target.value)} type="tel"
              placeholder="(415) 555 0123" className={FIELD} />
          )}
        </div>

        <details className="group">
          <summary className="text-xs text-neutral-400 cursor-pointer list-none flex items-center gap-1.5 py-1">
            <span className="group-open:rotate-90 transition-transform">›</span>
            Optional details
          </summary>
          <div className="space-y-3 pt-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-neutral-300">Portfolio link</label>
              <input value={portfolio} onChange={e => setPortfolio(e.target.value)}
                placeholder="yoursite.com" autoCapitalize="none" className={FIELD} />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-neutral-300">Dietary notes</label>
              <input value={dietary} onChange={e => setDietary(e.target.value)}
                placeholder="Anything a restaurant should know" className={FIELD} />
            </div>
          </div>
        </details>

        {/* Separated from the form above by a rule: this is an offer, not a field. */}
        <div className="pt-5 border-t border-white/10">
          <div className={`${PURPLE_CARD} p-4 space-y-3`}>
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                <Award className="w-4 h-4 text-purple-300 shrink-0" />
                <p className="text-sm font-semibold text-white">Ambassador Mode</p>
              </div>
              <Toggle on={ambassador} onChange={setAmbassador} label="Ambassador Mode" />
            </div>
            <p className="text-xs text-neutral-400 leading-relaxed">{AMBASSADOR_COPY}</p>
          </div>
        </div>

        {error && (
          <p className="text-xs text-red-400 flex items-start gap-1.5">
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />{error}
          </p>
        )}

        <button type="submit" disabled={saving}
          className="w-full py-3.5 text-sm font-bold rounded-xl bg-white text-neutral-900 hover:bg-neutral-100 transition-all disabled:opacity-40">
          {saving ? "Saving..." : "Confirm my profile"}
        </button>
      </form>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-neutral-950 text-white flex flex-col">
      <header className="border-b border-white/10 px-5 py-4">
        <div className="max-w-lg mx-auto flex items-center justify-between">
          <span className="text-sm font-semibold tracking-[0.2em]">C O N T Y N T</span>
          <span className="text-xs text-neutral-500">For Creators</span>
        </div>
      </header>
      <main className="flex-1 w-full max-w-lg mx-auto px-5 py-8">{children}</main>
      <footer className="border-t border-white/10 px-5 py-5 text-center">
        <p className="text-xs text-neutral-600">© {new Date().getFullYear()} Contynt</p>
      </footer>
    </div>
  );
}
