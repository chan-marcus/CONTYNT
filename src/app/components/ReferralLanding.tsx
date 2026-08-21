import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { CheckCircle, ArrowRight } from "lucide-react";
import { projectId, publicAnonKey } from "/utils/supabase/info";
import { CITY_OPTIONS } from "../lib/cities";

const BASE = `https://${projectId}.supabase.co/functions/v1/make-server-f5961d0c`;
const AUTH = { Authorization: `Bearer ${publicAnonKey}`, "Content-Type": "application/json" };
const api = (path: string, opts?: RequestInit) =>
  fetch(`${BASE}${path}`, { ...opts, headers: { ...AUTH, ...(opts?.headers ?? {}) } });

/**
 * Landing page for a business that scanned an Ambassador's QR code or opened
 * their referral link. The owner is typically standing in their own shop with
 * the creator, so this stays to two fields and never leaves them stuck: an
 * unrecognised code still lets them sign up, just without attribution.
 */
export function ReferralLanding({ code }: { code: string }) {
  const [creator, setCreator] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [city, setCity] = useState("");
  const [otherCity, setOtherCity] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api(`/referral/${encodeURIComponent(code)}`)
      .then(r => r.json())
      .then(d => { if (d?.valid) setCreator(d.creatorInstagram || ""); })
      .catch(() => {})
      .finally(() => setChecked(true));
  }, [code]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cityValue = city === "other" ? otherCity.trim() : city;
    if (!name.trim() || !email.trim() || !cityValue) return;
    setBusy(true); setError("");
    try {
      const res = await api(`/referral/${encodeURIComponent(code)}/business`, {
        method: "POST",
        body: JSON.stringify({ businessName: name.trim(), businessEmail: email.trim(), city: cityValue }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok || !d?.portalToken) {
        setError(d?.error || "Something went wrong. Please try again.");
        setBusy(false);
        return;
      }
      // Straight into the portal — the owner should not have to wait for a link.
      window.location.href = `${window.location.origin}?biz=${d.portalToken}`;
    } catch {
      setError("Could not reach the server. Please try again.");
      setBusy(false);
    }
  };

  const handle = (creator || "").replace(/^@+/, "");

  return (
    <div className="min-h-screen bg-neutral-950 text-white flex flex-col">
      <header className="border-b border-white/10 px-6 py-4">
        <div className="max-w-md mx-auto flex items-center justify-between">
          <span className="text-sm font-semibold tracking-[0.2em]">C O N T Y N T</span>
          <span className="text-xs text-neutral-500">For Businesses</span>
        </div>
      </header>

      {/* One screen, in the order an owner reads it: what happened, who from,
          what they get, then the two fields. The pitch sits above the form
          rather than in a separate step, because this link is usually opened
          on a phone with the creator still standing there. */}
      <main className="flex-1 w-full max-w-md mx-auto px-5 py-8 space-y-5">
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }} className="space-y-2 text-center">
          <h1 className="text-2xl font-bold leading-snug">
            {/* Second half glued together so the wrap lands after "by". */}
            A local creator stopped by <span className="whitespace-nowrap">to shoot a Reel</span>
          </h1>
          {checked && handle && (
            <p className="text-xs text-neutral-500">Invited by @{handle}</p>
          )}
          <p className="text-sm text-neutral-400 leading-relaxed pt-1 text-balance">
            Claim your dashboard and we'll send you the Reel the moment it goes live.
          </p>
        </motion.div>

        <div className="space-y-2">
          {["Filmed and posted by a vetted local creator",
            "Posted as a collab, so it lives on your profile too",
            "Location tagged so nearby customers find you",
            "Yours to keep. Request more anytime."].map(b => (
            <div key={b} className="flex items-start gap-2.5 text-[13px] text-neutral-300 leading-snug">
              <CheckCircle className="w-4 h-4 text-green-400 shrink-0 mt-0.5" />{b}
            </div>
          ))}
        </div>

        <form onSubmit={submit} className="space-y-2.5 bg-white/5 border border-white/10 rounded-2xl p-4">
          <input value={name} onChange={e => setName(e.target.value)} required
            placeholder="Business name"
            className="w-full px-3.5 py-3 bg-white/10 border border-white/20 rounded-xl text-white text-[15px] placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-white/25" />
          {/* Businesses were created with an empty city, which is the field
              feature matching runs on. */}
          <select value={city} onChange={e => setCity(e.target.value)} required
            className={`w-full px-3.5 py-3 bg-white/10 border border-white/20 rounded-xl text-[15px] focus:outline-none focus:ring-2 focus:ring-white/25 ${city ? "text-white" : "text-neutral-500"}`}>
            <option value="" disabled className="bg-neutral-900 text-neutral-400">City</option>
            {CITY_OPTIONS.map(c => (
              <option key={c.value} value={c.value} className="bg-neutral-900 text-white">{c.label}</option>
            ))}
            <option value="other" className="bg-neutral-900 text-white">Other</option>
          </select>
          {city === "other" && (
            <input value={otherCity} onChange={e => setOtherCity(e.target.value)} required
              placeholder="Which city?" autoCapitalize="words"
              className="w-full px-3.5 py-3 bg-white/10 border border-white/20 rounded-xl text-white text-[15px] placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-white/25" />
          )}
          <input value={email} onChange={e => setEmail(e.target.value)} required type="email"
            placeholder="you@yourbusiness.com"
            className="w-full px-3.5 py-3 bg-white/10 border border-white/20 rounded-xl text-white text-[15px] placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-white/25" />
          {error && <p className="text-xs text-red-400">{error}</p>}
          <button type="submit" disabled={busy || !name.trim() || !email.trim() || !city || (city === "other" && !otherCity.trim())}
            className="w-full py-3.5 bg-white text-neutral-900 text-sm font-semibold rounded-xl hover:bg-neutral-100 transition-all disabled:opacity-40 flex items-center justify-center gap-2">
            {busy ? "Setting up…" : <>Claim your dashboard <ArrowRight className="w-4 h-4" /></>}
          </button>
          <p className="text-[11px] text-neutral-600 text-center">
            No payment details needed.
          </p>
        </form>
      </main>

      <footer className="border-t border-white/10 px-6 py-5 text-center">
        <p className="text-xs text-neutral-600">© {new Date().getFullYear()} Contynt</p>
      </footer>
    </div>
  );
}
