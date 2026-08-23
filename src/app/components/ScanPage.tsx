import { useEffect, useRef, useState } from "react";
import { CheckCircle } from "lucide-react";
import { projectId, publicAnonKey } from "/utils/supabase/info";
import { usePlacesElement } from "../lib/usePlacesElement";

// The page a business owner lands on after scanning an Ambassador card.
//
// Rendered by the site rather than the edge function: Supabase rewrites any
// HTML a function returns to text/plain with a sandbox CSP, so a server-rendered
// version showed the owner raw markup. The function now answers with JSON at
// /scan/:code and this renders it.
//
// One code covers every business a creator visits, so this page can never know
// which business is scanning it. It therefore never shows a Reel: a live Reel
// belongs to whichever business that creator filmed at, not to this one. What
// it does show is who left the card, and a form to claim a dashboard.

const BASE = `https://${projectId}.supabase.co/functions/v1/make-server-f5961d0c`;
const AUTH = { Authorization: `Bearer ${publicAnonKey}`, "Content-Type": "application/json" };

// The server still reports which stage the creator is at, but every active
// code renders the same signup page, so only these fields are read.
interface ScanState {
  state: "A" | "B" | "C" | "unknown" | "throttled" | "error";
  code?: string;
  creatorInstagram?: string;
  placesKey?: string;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-neutral-950 text-white flex items-center justify-center px-6 py-10">
      <div className="w-full max-w-sm text-center">
        <p className="text-xs font-semibold tracking-[0.2em] text-neutral-400 mb-7">C O N T Y N T</p>
        {children}
        <p className="text-xs text-neutral-600 mt-6">Contynt connects local creators with local businesses.</p>
      </div>
    </div>
  );
}


export function ScanPage({ code }: { code: string }) {
  const [data, setData] = useState<ScanState | null>(null);
  const [businessName, setBusinessName] = useState("");
  const [placeId, setPlaceId] = useState("");
  const [placeAddress, setPlaceAddress] = useState("");
  const [email, setEmail] = useState("");
  const [instagram, setInstagram] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  // False when the server could not write the lead. It parks the details either
  // way, so this changes what the confirmation promises, not whether one shows.
  const [savedCleanly, setSavedCleanly] = useState(true);
  // Second step, for the same reason the referral form has one: this matches
  // existing businesses, so a session handed straight over would be a way into
  // an account belonging to somebody else.
  const [step, setStep] = useState<"form" | "code">("form");
  const [otp, setOtp] = useState("");
  const [error, setError] = useState("");

  const placesHost = useRef<HTMLDivElement | null>(null);
  const placesReady = usePlacesElement(
    data?.placesKey || undefined,
    placesHost,
    (p) => { setPlaceId(p.placeId); setPlaceAddress(p.address); if (p.name) setBusinessName(p.name); },
    // Typing after a selection means they are naming something else, so the
    // stale place_id has to go with it.
    (v) => { setBusinessName(v); setPlaceId(""); setPlaceAddress(""); },
  );

  useEffect(() => {
    document.title = "CONTYNT";
    // Scan pages must never be indexed: they are per-creator links handed to one
    // business at a time. The site also sets X-Robots-Tag on /a/* for crawlers
    // that never run this script.
    const m = document.createElement("meta");
    m.name = "robots"; m.content = "noindex,nofollow";
    document.head.appendChild(m);
    return () => { m.remove(); };
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`${BASE}/scan/${encodeURIComponent(code)}`, { headers: AUTH });
        const d = await res.json().catch(() => null);
        if (alive) setData(d ?? { state: "error" });
      } catch { if (alive) setData({ state: "error" }); }
    })();
    return () => { alive = false; };
  }, [code]);

  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    const digits = otp.replace(/\D/g, "");
    if (digits.length !== 6) { setError("Enter the 6 digit code."); return; }
    setBusy(true); setError("");
    try {
      const res = await fetch(`${BASE}/business-login/verify`, {
        method: "POST", headers: AUTH,
        body: JSON.stringify({ email, code: digits }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok || !d?.token) { setError(d?.error || "That code is not right."); setBusy(false); return; }
      window.location.replace(`${window.location.origin}/business?biz=${encodeURIComponent(d.token)}`);
    } catch { setError("Could not reach the server."); setBusy(false); }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!businessName.trim() || !instagram.trim() || !email.trim()) return;
    setBusy(true); setError("");
    try {
      const res = await fetch(`${BASE}/scan/${encodeURIComponent(code)}/lead`, {
        method: "POST", headers: AUTH,
        body: JSON.stringify({ businessName, instagram: instagram.trim(), email, placeId, placeAddress }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) { setError(d?.error || "Could not send that. Try again."); setBusy(false); return; }
      // A code is on its way. The owner is standing right there, so this is one
      // extra step rather than a wait -- and it is what stops the form being a
      // way into a business that is already on file.
      if (d?.needsVerification) { setStep("code"); setBusy(false); return; }
      // saved === false means the write failed outright. The server parks the
      // details so nothing is lost and an admin can pick it up, but the owner
      // must not be told a code is on its way -- so the confirmation says we
      // have their details and stops there.
      setSavedCleanly(d?.saved !== false);
      // The lead saved but no code went out, which is a worse landing rather
      // than a lost signup: the confirmation stands.
      setDone(true);
    } catch { setError("Could not reach the server. Try again."); }
    setBusy(false);
  };

  if (!data) return <Shell><p className="text-sm text-neutral-400">Loading…</p></Shell>;

  if (data.state === "unknown") {
    return <Shell>
      <h1 className="text-xl font-bold mb-2">This card is not active</h1>
      <p className="text-sm text-neutral-400">Double check the code, or visit GetContynt.com to get started.</p>
    </Shell>;
  }

  if (data.state === "throttled") {
    return <Shell>
      <h1 className="text-xl font-bold mb-2">Give it a moment</h1>
      <p className="text-sm text-neutral-400">This code has been scanned a lot just now. Try again shortly.</p>
    </Shell>;
  }

  if (data.state === "error") {
    return <Shell>
      <h1 className="text-xl font-bold mb-2">Something went wrong</h1>
      <p className="text-sm text-neutral-400">Try again in a moment.</p>
    </Shell>;
  }

  if (done) {
    // Two endings, because there are two outcomes. When the lead saved, the
    // email is a promise we can keep. When it did not, the server has parked
    // the details for an admin -- so the owner is not dead-ended, but neither
    // is they told to wait on an inbox for something that is not coming.
    return <Shell>
      <h1 className="text-xl font-bold mb-2">{savedCleanly ? "You're in" : "Got your details"}</h1>
      <p className="text-sm text-neutral-400">
        {savedCleanly
          ? "We'll email your dashboard link, and the Reel as soon as it goes live."
          : "We've got them and someone will be in touch shortly to finish setting you up."}
      </p>
    </Shell>;
  }

  // ── The signup page ────────────────────────────────────────────────────────
  // Every active code lands here. The code no longer knows which business this
  // is, so the owner names it, and the whole thing stays on one screen: the
  // owner is usually standing at their own counter with a phone in one hand.
  const handle = (data.creatorInstagram || "").replace(/^@+/, "");

  return <Shell>
    <h1 className="text-[22px] font-bold leading-snug">
      {/* The break is placed rather than balanced: left to itself the line
          split after "stopped", and balancing picked its own point. Gluing the
          second half keeps it whole, so the wrap lands after "by". */}
      A local creator stopped by <span className="whitespace-nowrap">to shoot a Reel</span>
    </h1>
    {handle && (
      <p className="text-xs text-neutral-500 mt-2">Invited by @{handle}</p>
    )}
    <p className="text-sm text-neutral-400 mt-3 text-balance">
      Claim your dashboard and we'll send you the Reel the moment it goes live.
    </p>

    <div className="mt-5 space-y-2 text-left">
      {["Filmed and posted by a vetted local creator",
        "Posted as a collab, so it lives on your profile too",
        "Location tagged so nearby customers find you",
        "Yours to keep. Request more anytime."].map(b => (
        <div key={b} className="flex items-start gap-2.5 text-[13px] text-neutral-300 leading-snug">
          <CheckCircle className="w-4 h-4 text-green-400 shrink-0 mt-0.5" />{b}
        </div>
      ))}
    </div>

    {step === "code" ? (
    <form onSubmit={verify} className="flex flex-col gap-2.5 text-left mt-5">
      <p className="text-[15px] text-white font-semibold text-center">Check your email</p>
      <p className="text-xs text-neutral-400 leading-relaxed text-center">
        We sent a 6 digit code to <span className="text-neutral-200">{email}</span>. It expires in 10 minutes.
      </p>
      <input value={otp} onChange={e => { setOtp(e.target.value.replace(/\D/g, "").slice(0, 6)); setError(""); }}
        inputMode="numeric" autoComplete="one-time-code" placeholder="000000" autoFocus
        className="w-full px-3.5 py-3 bg-white/10 border border-white/20 rounded-xl text-white text-center text-2xl font-bold tracking-[0.4em] placeholder:text-neutral-600 focus:outline-none focus:ring-2 focus:ring-white/25" />
      {error && <p className="text-xs text-red-400">{error}</p>}
      <button type="submit" disabled={busy || otp.replace(/\D/g, "").length !== 6}
        className="w-full py-3.5 rounded-xl bg-white text-neutral-900 text-sm font-semibold disabled:opacity-50">
        {busy ? "Checking…" : "Open my dashboard"}
      </button>
      <button type="button" onClick={() => { setStep("form"); setOtp(""); setError(""); }}
        className="w-full text-xs text-neutral-500 hover:text-neutral-300">Use a different email</button>
    </form>
    ) : (
    <form onSubmit={submit} className="flex flex-col gap-2.5 text-left mt-5">
      {/* The Places component mounts here when a key is configured. Until then,
          and if it fails to load, the plain input below carries the field. */}
      <div ref={placesHost} className={placesReady ? "contynt-places-host" : "hidden"} />
      {!placesReady && (
        <input id="bizname" value={businessName} onChange={e => { setBusinessName(e.target.value); setPlaceId(""); }}
          placeholder="Business name" required autoComplete="off" autoCapitalize="words"
          className="w-full px-3.5 py-3 bg-white/10 border border-white/20 rounded-xl text-white text-[15px] placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-white/25" />
      )}
      {/* Same three questions as the referral form, in the same order. The @ is
          a prefix inside the box so the fields share a left edge and nobody
          types the @ twice. */}
      <div className="relative">
        <span aria-hidden className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[15px] text-neutral-500 pointer-events-none">@</span>
        <input value={instagram} onChange={e => setInstagram(e.target.value)} required
          placeholder="yourbusiness" autoCapitalize="none" autoCorrect="off" spellCheck={false}
          className="w-full pl-8 pr-3.5 py-3 bg-white/10 border border-white/20 rounded-xl text-white text-[15px] placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-white/25" />
      </div>
      <input type="email" value={email} onChange={e => setEmail(e.target.value)}
        placeholder="you@yourbusiness.com" required autoComplete="email"
        className="w-full px-3.5 py-3 bg-white/10 border border-white/20 rounded-xl text-white text-[15px] placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-white/25" />
      {error && <p className="text-xs text-red-400">{error}</p>}
      <button type="submit" disabled={busy}
        className="w-full py-3.5 rounded-xl bg-white text-neutral-900 text-sm font-semibold disabled:opacity-50">
        {busy ? "Claiming…" : "Claim your dashboard"}
      </button>
      <p className="text-[11px] text-neutral-600 text-center">
        No payment details needed.
      </p>
    </form>
    )}
  </Shell>;
}
