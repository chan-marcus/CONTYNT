import { useEffect, useState } from "react";
import { projectId, publicAnonKey } from "/utils/supabase/info";

// The page a business owner lands on after scanning an Ambassador card.
//
// Rendered by the site rather than the edge function: Supabase rewrites any
// HTML a function returns to text/plain with a sandbox CSP, so a server-rendered
// version showed the owner raw markup. The function now answers with JSON at
// /scan/:code and this renders it.
//
// Nothing here identifies the creator until their Reel is live.

const BASE = `https://${projectId}.supabase.co/functions/v1/make-server-f5961d0c`;
const AUTH = { Authorization: `Bearer ${publicAnonKey}`, "Content-Type": "application/json" };

interface ScanState {
  state: "A" | "B" | "C" | "unknown" | "throttled" | "error";
  code?: string;
  businessName?: string;
  reelUrl?: string;
  creatorInstagram?: string;
  metrics?: { thumbnail?: string };
  placesKey?: string;
  siteOrigin?: string;
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

// Loaded only when a key is configured. Without one the field is still a
// required text input; the lead is captured, just without a place_id to match
// on, and the server falls back to matching by name.
function usePlacesAutocomplete(key: string | undefined, onPlace: (p: { placeId: string; address: string; name: string }) => void) {
  useEffect(() => {
    if (!key) return;
    const id = "contynt-places";
    const attach = () => {
      const g = (window as any).google;
      const input = document.getElementById("bizname") as HTMLInputElement | null;
      if (!g?.maps?.places || !input) return;
      const ac = new g.maps.places.Autocomplete(input, {
        fields: ["place_id", "name", "formatted_address"],
        types: ["establishment"],
        // Biased, not restricted: a spot just outside the box should still be
        // findable rather than silently missing.
        locationBias: { center: { lat: 37.7749, lng: -122.4194 }, radius: 30000 },
      });
      ac.addListener("place_changed", () => {
        const p = ac.getPlace() || {};
        onPlace({ placeId: p.place_id || "", address: p.formatted_address || "", name: p.name || "" });
      });
    };
    if (document.getElementById(id)) { setTimeout(attach, 300); return; }
    const sc = document.createElement("script");
    sc.id = id;
    sc.async = true;
    sc.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&libraries=places&loading=async`;
    sc.onload = () => setTimeout(attach, 200);
    document.head.appendChild(sc);
  }, [key]);
}

export function ScanPage({ code }: { code: string }) {
  const [data, setData] = useState<ScanState | null>(null);
  const [businessName, setBusinessName] = useState("");
  const [placeId, setPlaceId] = useState("");
  const [placeAddress, setPlaceAddress] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  usePlacesAutocomplete(data?.placesKey || undefined, (p) => {
    setPlaceId(p.placeId); setPlaceAddress(p.address);
    if (p.name) setBusinessName(p.name);
  });

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

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!businessName.trim() || !email.trim()) return;
    setBusy(true); setError("");
    try {
      const res = await fetch(`${BASE}/scan/${encodeURIComponent(code)}/lead`, {
        method: "POST", headers: AUTH,
        body: JSON.stringify({ businessName, email, placeId, placeAddress }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) { setError(d?.error || "Could not send that. Try again."); setBusy(false); return; }
      setDone(true);
    } catch { setError("Could not reach the server. Try again."); }
    setBusy(false);
  };

  if (!data) return <Shell><p className="text-sm text-neutral-400">Loading…</p></Shell>;

  if (data.state === "unknown") {
    return <Shell>
      <h1 className="text-xl font-bold mb-2">This card is not active</h1>
      <p className="text-sm text-neutral-400">Double check the code, or visit contynt.com to get started.</p>
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

  // The Reel is live, so the creator is public now and can be named.
  if (data.state === "B") {
    return <Shell>
      <h1 className="text-xl font-bold mb-2">The Reel is live</h1>
      <p className="text-sm text-neutral-400 mb-4">
        Filmed at {data.businessName} by @{(data.creatorInstagram || "").replace(/^@+/, "")}.
      </p>
      {data.metrics?.thumbnail && (
        <img src={data.metrics.thumbnail} alt="" className="w-full rounded-2xl my-4" />
      )}
      <a href={data.reelUrl} target="_blank" rel="noopener noreferrer"
        className="block w-full py-3 rounded-xl bg-white text-neutral-900 text-sm font-semibold">
        Watch it on Instagram
      </a>
      <a href={`${data.siteOrigin || ""}/?ref=${encodeURIComponent(data.code || "")}`}
        className="block w-full py-3 mt-2 rounded-xl bg-white/10 border border-white/20 text-sm font-semibold">
        Create a business account
      </a>
    </Shell>;
  }

  if (data.state === "C") {
    return <Shell>
      <h1 className="text-xl font-bold mb-2">Contynt</h1>
      <p className="text-sm text-neutral-400 mb-4">
        Local creators film short Reels at local businesses and post them to their own audience.
      </p>
      <a href={`${data.siteOrigin || ""}/`}
        className="block w-full py-3 rounded-xl bg-white text-neutral-900 text-sm font-semibold">
        See how it works
      </a>
    </Shell>;
  }

  if (done) {
    return <Shell>
      <h1 className="text-xl font-bold mb-2">Thanks</h1>
      <p className="text-sm text-neutral-400">
        We'll email you your dashboard link, and the Reel as soon as it goes live.
      </p>
    </Shell>;
  }

  // ── State A ────────────────────────────────────────────────────────────────
  // The code no longer knows which business this is, so the owner names it.
  return <Shell>
    <h1 className="text-xl font-bold mb-2">A creator filmed a Reel here</h1>
    <p className="text-sm text-neutral-400 mb-5">
      Tell us where this is and we'll set up your business dashboard. You'll get the Reel
      as soon as it goes live, and you can request more from there.
    </p>
    <form onSubmit={submit} className="flex flex-col gap-2.5 text-left">
      <input id="bizname" value={businessName} onChange={e => { setBusinessName(e.target.value); setPlaceId(""); }}
        placeholder="Business name" required autoComplete="off" autoCapitalize="words"
        className="w-full px-3.5 py-3 bg-white/10 border border-white/20 rounded-xl text-white text-[15px] placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-white/25" />
      <input type="email" value={email} onChange={e => setEmail(e.target.value)}
        placeholder="you@yourbusiness.com" required autoComplete="email"
        className="w-full px-3.5 py-3 bg-white/10 border border-white/20 rounded-xl text-white text-[15px] placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-white/25" />
      {error && <p className="text-xs text-red-400">{error}</p>}
      <button type="submit" disabled={busy}
        className="w-full py-3.5 rounded-xl bg-white text-neutral-900 text-sm font-semibold disabled:opacity-50">
        {busy ? "Claiming…" : "Claim your dashboard"}
      </button>
    </form>
  </Shell>;
}
