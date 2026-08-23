import { useState, useRef, useEffect } from "react";
import { motion } from "motion/react";
import { ArrowLeft, AlertCircle, Loader2 } from "lucide-react";
import { projectId, publicAnonKey } from "/utils/supabase/info";

const BASE = `https://${projectId}.supabase.co/functions/v1/make-server-f5961d0c`;
const AUTH = { Authorization: `Bearer ${publicAnonKey}`, "Content-Type": "application/json" };
const api = (path: string, opts?: RequestInit) =>
  fetch(`${BASE}${path}`, { ...opts, headers: { ...AUTH, ...(opts?.headers ?? {}) } });

const FIELD = "w-full px-3 py-3 bg-white/10 border border-white/20 rounded-xl text-white text-sm placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-white/20";

// Where a verified session is kept so a creator does not sign in on every visit.
export const CREATOR_TOKEN_KEY = "contynt_creator_token";

export function CreatorLogin({ onSignedIn }: { onSignedIn?: (token: string, needsConfirm: boolean) => void }) {
  // Named here too, so signing out does not flip the tab back to the marketing
  // title. App.tsx's title effect is unreachable on /app.
  useEffect(() => { document.title = "CONTYNT | Creator Sign In"; }, []);
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [resentAt, setResentAt] = useState(0);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (step === "code") codeRef.current?.focus(); }, [step]);

  const requestCode = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!email.trim()) return;
    setBusy(true); setError("");
    try {
      // The server answers the same way whether or not the address is on file,
      // so there is nothing here to branch on and nothing to leak.
      await api("/creator-login/request", { method: "POST", body: JSON.stringify({ email: email.trim() }) });
      setStep("code");
      setResentAt(Date.now());
    } catch { setError("Could not reach the server."); }
    setBusy(false);
  };

  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    const digits = code.replace(/\D/g, "");
    if (digits.length !== 6) { setError("Enter the 6 digit code."); return; }
    setBusy(true); setError("");
    try {
      const res = await api("/creator-login/verify", {
        method: "POST", body: JSON.stringify({ email: email.trim(), code: digits }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok || !d?.token) { setError(d?.error || "Could not sign you in."); setBusy(false); return; }

      // A business address is accepted here rather than rejected: the server
      // issues it a business code and says so once the code checks out. Sent to
      // their own portal, not stored as a creator session, because it is a
      // business token and nothing on the creator side can read it.
      if (d.portal === "business") {
        window.location.replace(`${window.location.origin}/business?biz=${encodeURIComponent(d.token)}`);
        return;
      }

      localStorage.setItem(CREATOR_TOKEN_KEY, d.token);
      if (onSignedIn) { onSignedIn(d.token, !!d.needsConfirm); return; }
      // Confirmed creators go to the portal, everyone else confirms first.
      const dest = d.needsConfirm
        ? `${window.location.origin}/app?creator=${encodeURIComponent(d.token)}&view=confirm`
        : `${window.location.origin}/app`;
      window.location.replace(dest);
    } catch { setError("Could not reach the server."); setBusy(false); }
  };

  return (
    <div className="min-h-screen bg-neutral-950 text-white flex flex-col">
      <header className="border-b border-white/10 px-5 py-4">
        <div className="max-w-sm mx-auto flex items-center justify-between">
          <a href="/" className="text-sm font-semibold tracking-[0.2em] hover:opacity-80 transition-opacity">C O N T Y N T</a>
          <span className="text-xs text-neutral-500">Sign In</span>
        </div>
      </header>

      <main className="flex-1 w-full max-w-sm mx-auto px-5 py-12">
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }}
          className="space-y-6">
          {step === "email" ? (
            <>
              <div className="space-y-2">
                <h1 className="text-2xl font-bold leading-snug">Sign in</h1>
                <p className="text-sm text-neutral-400 leading-relaxed">
                  Enter the email you signed up with.<br />
                  We will send you a 6 digit code.
                </p>
              </div>
              <form onSubmit={requestCode} className="space-y-3">
                <input value={email} onChange={e => setEmail(e.target.value)} type="email" required
                  placeholder="you@email.com" autoComplete="email" autoCapitalize="none"
                  autoFocus className={FIELD} />
                {error && (
                  <p className="text-xs text-red-400 flex items-start gap-1.5">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />{error}
                  </p>
                )}
                <button type="submit" disabled={busy || !email.trim()}
                  className="w-full py-3.5 text-sm font-bold rounded-xl bg-white text-neutral-900 hover:bg-neutral-100 transition-all disabled:opacity-40 flex items-center justify-center gap-2">
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : "Email me a code"}
                </button>
              </form>

              {/* The header's Log In goes straight here now, so this is the only
                  thing standing between an owner who followed it and a dead end:
                  nothing else on the site links to the business portal. */}
              <p className="text-xs text-neutral-500">
                Here for your business?{" "}
                <a href="/business" className="text-neutral-300 underline underline-offset-2 hover:text-white">
                  Sign in as a business
                </a>.
              </p>
            </>
          ) : (
            <>
              <div className="space-y-2">
                <h1 className="text-2xl font-bold leading-snug">Check your email</h1>
                <p className="text-sm text-neutral-400 leading-relaxed">
                  If <span className="text-neutral-200">{email.trim()}</span> is on file, a 6 digit code is on its way.
                  It expires in 10 minutes.
                </p>
              </div>
              <form onSubmit={verify} className="space-y-3">
                <input ref={codeRef} value={code}
                  onChange={e => { setCode(e.target.value.replace(/\D/g, "").slice(0, 6)); setError(""); }}
                  inputMode="numeric" autoComplete="one-time-code" placeholder="000000"
                  className={`${FIELD} text-center text-2xl font-bold tracking-[0.4em]`} />
                {error && (
                  <p className="text-xs text-red-400 flex items-start gap-1.5">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />{error}
                  </p>
                )}
                <button type="submit" disabled={busy || code.length !== 6}
                  className="w-full py-3.5 text-sm font-bold rounded-xl bg-white text-neutral-900 hover:bg-neutral-100 transition-all disabled:opacity-40 flex items-center justify-center gap-2">
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : "Sign in"}
                </button>
              </form>
              <div className="flex items-center justify-between">
                <button type="button" onClick={() => { setStep("email"); setCode(""); setError(""); }}
                  className="text-xs text-neutral-500 hover:text-neutral-300 flex items-center gap-1">
                  <ArrowLeft className="w-3 h-3" />Different email
                </button>
                <button type="button" onClick={() => requestCode()} disabled={busy || Date.now() - resentAt < 30000}
                  className="text-xs text-neutral-500 hover:text-neutral-300 disabled:opacity-40">
                  Resend code
                </button>
              </div>
            </>
          )}
        </motion.div>
      </main>

      <footer className="border-t border-white/10 px-5 py-5 text-center">
        <p className="text-xs text-neutral-600">© {new Date().getFullYear()} CONTYNT</p>
      </footer>
    </div>
  );
}
