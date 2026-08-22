import { useEffect, useState } from "react";
import { Award, Loader2, AlertCircle } from "lucide-react";
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
  "When you shoot a Feature, print a card from your portal or pull up your QR code, and hand it " +
  "to the owner or whoever is working on your way out. If that spot comes on board, you earn an " +
  "extra $" + REFERRAL_REWARD + "!";

interface ConfirmData {
  neighborhoods: string[];
  verificationStatus: string;
  confirmedAt: string | null;
  profile: {
    instagramHandle: string;
    notifyEmail: boolean; notifyDm: boolean;
    email: string;
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

// Reach is one choice, not two switches. Two independent booleans allowed
// "neither", which is a creator no Feature offer can ever arrive at -- the state
// Creator Readiness now flags in red. A single choice cannot express it.
type Reach = "" | "instagram" | "email" | "both";

const REACH_OPTIONS: [Exclude<Reach, "">, string][] = [
  ["instagram", "Instagram DM"],
  ["email", "Email"],
  ["both", "Both"],
];

function Segment({ value, onChange }: { value: Reach; onChange: (v: Reach) => void }) {
  return (
    <div role="radiogroup" aria-label="How should we reach you?"
      className="flex gap-1.5 bg-white/5 border border-white/10 rounded-xl p-1">
      {REACH_OPTIONS.map(([v, label]) => (
        // type="button" for the same reason the toggle carries it: inside a
        // <form> the default is submit, so choosing would fire the whole thing.
        <button key={v} type="button" role="radio" aria-checked={value === v}
          onClick={() => onChange(v)}
          className={`flex-1 py-2 text-xs rounded-lg transition-all ${
            value === v ? "bg-white text-neutral-900 font-semibold" : "text-neutral-400 hover:text-neutral-200"
          }`}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function ConfirmProfile({ token }: { token: string }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // Kept apart from `error`, which reports a failed save inside the form. A
  // profile that never loaded has no form to report into, and gating the form
  // on the shared field would have hidden it the first time a save failed.
  const [loadError, setLoadError] = useState<{ kind: "invalid" | "offline"; message: string } | null>(null);

  const [handle, setHandle] = useState("");
  const [email, setEmail] = useState("");
  // Empty until the profile loads, and deliberately still empty for a creator
  // who had both channels off: inventing a choice for them would silently opt
  // them back into mail they had turned off, so the form asks instead.
  const [reach, setReach] = useState<Reach>("");
  // Seeded from the stored value rather than hardcoded false: on a re-confirm
  // an existing Ambassador must not be silently opted back out.
  const [ambassador, setAmbassador] = useState(false);

  useEffect(() => {
    api(`/creator-portal/confirm-data?t=${encodeURIComponent(token)}`)
      .then(r => r.json())
      .then((d: ConfirmData) => {
        if (d?.profile) {
          setHandle(d.profile.instagramHandle || "");
          setEmail(d.profile.email || "");
          const dm = d.profile.notifyDm !== false, mail = d.profile.notifyEmail !== false;
          setReach(dm && mail ? "both" : dm ? "instagram" : mail ? "email" : "");
          setAmbassador(!!d.ambassador?.optedIn);
        } else {
          setLoadError({
            kind: "invalid",
            message: (d && (d as any).error) || "We could not load your profile from this link.",
          });
        }
      })
      .catch(() => setLoadError({ kind: "offline", message: "We could not reach the server." }))
      .finally(() => setLoading(false));
  }, [token]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reach) { setError("Pick how we should reach you."); return; }
    setSaving(true); setError("");
    try {
      const res = await api("/creator-portal/confirm", {
        method: "POST",
        body: JSON.stringify({
          token, instagramHandle: handle, email: email.trim(),
          // The server still takes two booleans, so the choice is expanded here
          // rather than changing a contract that other callers depend on.
          notifyEmail: reach === "email" || reach === "both",
          notifyDm: reach === "instagram" || reach === "both",
          ambassadorOptIn: ambassador,
        }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok || !d?.success) { setError(d?.error || "Could not save your profile."); setSaving(false); return; }
      // Straight into the portal. setSaving stays true on purpose, so the button
      // remains spent while the browser navigates and a second press cannot fire
      // a second confirm.
      window.location.replace(portalUrl());
      return;
    } catch { setError("Could not reach the server."); }
    setSaving(false);
  };

  // Built from the URL that got them here rather than assembled from scratch,
  // so imp=1 survives. Dropping it would let App persist an admin's short lived
  // impersonation token as a real creator session. replace(), not assign(), so
  // Back does not return to a form that has already been submitted.
  const portalUrl = () => {
    const url = new URL(window.location.href);
    url.pathname = "/app";
    url.searchParams.delete("view");
    return url.toString();
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

  // Without this the form rendered on a dead token: every field blank, the
  // reason buried under the Ambassador card, and a submit button that could
  // never save. A link that cannot load a profile is the end of the road, so
  // the page says so and hands over the one thing that helps.
  if (loadError) {
    const invalid = loadError.kind === "invalid";
    return (
      <Shell>
        <div className="space-y-6 text-center py-6">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-red-500/15 border border-red-400/30">
            <AlertCircle className="w-7 h-7 text-red-400" />
          </div>
          <div className="space-y-2">
            <h1 className="text-2xl font-bold">{invalid ? "This link is not valid" : "We could not reach the server"}</h1>
            <p className="text-sm text-neutral-400 leading-relaxed">
              {invalid
                ? "It may have expired or been replaced by a newer one. We can send you a fresh link."
                : "This is on our side, not yours. Your link is fine \u2014 try again in a moment."}
            </p>
          </div>
          {invalid ? (
            // The server already renders a resend form at this route, so the
            // recovery path is the one creators reach from a dead email link.
            <a href="/portal/verify"
              className="block w-full py-3.5 text-sm font-bold rounded-xl bg-white text-neutral-900 hover:bg-neutral-100 transition-all">
              Send me a new link
            </a>
          ) : (
            <button type="button" onClick={() => window.location.reload()}
              className="block w-full py-3.5 text-sm font-bold rounded-xl bg-white text-neutral-900 hover:bg-neutral-100 transition-all">
              Try again
            </button>
          )}
          <p className="text-xs text-neutral-600">{loadError.message}</p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <form onSubmit={submit} className="space-y-6">
        <h1 className="text-2xl font-bold leading-snug">Confirm your profile</h1>

        <div className="bg-white/5 border border-white/10 rounded-2xl divide-y divide-white/10">
          <div className="p-4 space-y-1.5">
            <label className="text-xs font-medium text-neutral-300" htmlFor="confirm-handle">Instagram handle</label>
            {/* The @ is a prefix inside the box, not a sibling beside it, so
                both inputs share one left edge. */}
            <div className="relative">
              <span aria-hidden className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-neutral-500 pointer-events-none">@</span>
              <input id="confirm-handle" value={handle} onChange={e => setHandle(e.target.value)} required
                placeholder="yourhandle" autoCapitalize="none" autoCorrect="off" spellCheck={false}
                className={`${FIELD} pl-7`} />
            </div>
          </div>

          <div className="p-4 space-y-1.5">
            <label className="text-xs font-medium text-neutral-300" htmlFor="confirm-email">Email address</label>
            <input id="confirm-email" type="email" value={email} onChange={e => setEmail(e.target.value)} required
              placeholder="you@example.com" autoCapitalize="none" autoCorrect="off" spellCheck={false}
              autoComplete="email" inputMode="email" className={FIELD} />
          </div>
        </div>

        {/* Asked after both addresses are on screen: the choice is which of the
            two above to use, so it only reads properly once they exist. */}
        <div className="space-y-2">
          <p className="text-xs font-medium text-neutral-300">How should we reach you?</p>
          <Segment value={reach} onChange={setReach} />
        </div>

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
          {saving ? "Saving\u2026" : "Go to my portal"}
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
        <p className="text-xs text-neutral-600">© {new Date().getFullYear()} CONTYNT</p>
      </footer>
    </div>
  );
}
