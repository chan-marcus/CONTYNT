import { useEffect, useRef, useState } from "react";
import { CheckCircle } from "lucide-react";
import { CITY_OPTIONS } from "../lib/cities";
import { projectId, publicAnonKey } from "/utils/supabase/info";

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
        <p className="text-xs text-neutral-600 mt-6">CONTYNT connects local creators with local businesses.</p>
      </div>
    </div>
  );
}

// Google closed the legacy google.maps.places.Autocomplete widget to new
// customers on 1 March 2025: it loads without error and simply returns no
// predictions. This uses PlaceAutocompleteElement, the supported replacement,
// which is a web component rather than something bound to an existing input.
//
// Loaded only when a key is configured. Without one the plain input below is
// used, the lead is still captured, and the server falls back to matching the
// business by name instead of by place_id.
function usePlacesElement(
  key: string | undefined,
  host: React.RefObject<HTMLDivElement | null>,
  onPlace: (p: { placeId: string; address: string; name: string }) => void,
  onText: (v: string) => void,
) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!key) return;
    let cancelled = false;

    // With loading=async the script's onload fires before the bootstrap has
    // attached google.maps.importLibrary, so waiting on onload alone gives
    // "importLibrary is not a function". Google's documented answer is the
    // callback parameter, which fires once the API is genuinely ready.
    const ready = () => typeof (window as any).google?.maps?.importLibrary === "function";
    const loadScript = () => new Promise<void>((resolve, reject) => {
      if (ready()) return resolve();
      const cbName = "__contyntMapsReady";
      const prev = (window as any)[cbName];
      (window as any)[cbName] = () => { prev?.(); resolve(); };

      const id = "contynt-places";
      if (document.getElementById(id)) {
        // Already loading from an earlier mount: the callback above is chained
        // onto the pending one, so this resolves when that finishes.
        return;
      }
      const sc = document.createElement("script");
      sc.id = id; sc.async = true;
      sc.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}`
             + `&libraries=places&loading=async&v=weekly&callback=${cbName}`;
      sc.onerror = () => reject(new Error("maps script failed to load"));
      document.head.appendChild(sc);
    });

    (async () => {
      try {
        await loadScript();
        const g = (window as any).google;
        const { PlaceAutocompleteElement } = await g.maps.importLibrary("places");
        if (cancelled) return;
        const mount = host.current;
        if (!mount) { console.error("[places] host element missing at mount time"); return; }

        const el = new PlaceAutocompleteElement({
          // Biased, not restricted: a spot just outside the box should still be
          // findable rather than silently missing.
          locationBias: { center: { lat: 37.7749, lng: -122.4194 }, radius: 30000 },
          includedPrimaryTypes: ["establishment"],
        });
        el.style.width = "100%";
        // Without this the widget renders as a bare magnifier with no prompt,
        // which reads as a broken field next to the email input.
        el.placeholder = "Business name";
        mount.innerHTML = "";
        mount.appendChild(el);

        // Free text still has to reach the form: someone may type a name that
        // has no Places match and submit it anyway.
        const inner = el.querySelector?.("input") as HTMLInputElement | null;
        inner?.addEventListener("input", () => onText(inner.value));
        el.addEventListener("input", (e: any) => {
          const v = e?.target?.value; if (typeof v === "string") onText(v);
        });

        const handle = async (ev: any) => {
          const pred = ev?.placePrediction ?? ev?.detail?.placePrediction;
          if (!pred) return;
          const place = pred.toPlace();
          await place.fetchFields({ fields: ["id", "displayName", "formattedAddress"] });
          onPlace({
            placeId: place.id || "",
            address: place.formattedAddress || "",
            name: (place.displayName as any) || "",
          });
        };
        // The event was renamed; listen for both so a version bump cannot
        // silently stop capturing place_id.
        el.addEventListener("gmp-select", handle);
        el.addEventListener("gmp-placeselect", handle);

        setReady(true);
      } catch (e) {
        // Leaves the plain input in place, which still captures the lead. Logged
        // rather than swallowed: a silent failure here looks identical to "no
        // key configured", and the two need different fixes.
        console.error("[places] autocomplete unavailable:", e);
      }
    })();

    return () => { cancelled = true; };
  }, [key]);

  return ready;
}

export function ScanPage({ code }: { code: string }) {
  const [data, setData] = useState<ScanState | null>(null);
  const [businessName, setBusinessName] = useState("");
  const [placeId, setPlaceId] = useState("");
  const [placeAddress, setPlaceAddress] = useState("");
  const [email, setEmail] = useState("");
  const [city, setCity] = useState("");
  const [otherCity, setOtherCity] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
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

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cityValue = city === "other" ? otherCity.trim() : city;
    if (!businessName.trim() || !email.trim() || !cityValue) return;
    setBusy(true); setError("");
    try {
      const res = await fetch(`${BASE}/scan/${encodeURIComponent(code)}/lead`, {
        method: "POST", headers: AUTH,
        body: JSON.stringify({ businessName, email, city: cityValue, placeId, placeAddress }),
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

  if (done) {
    return <Shell>
      <h1 className="text-xl font-bold mb-2">You're in</h1>
      <p className="text-sm text-neutral-400">
        We'll email your dashboard link, and the Reel as soon as it goes live.
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

    <form onSubmit={submit} className="flex flex-col gap-2.5 text-left mt-5">
      {/* The Places component mounts here when a key is configured. Until then,
          and if it fails to load, the plain input below carries the field. */}
      <div ref={placesHost} className={placesReady ? "contynt-places-host" : "hidden"} />
      {!placesReady && (
        <input id="bizname" value={businessName} onChange={e => { setBusinessName(e.target.value); setPlaceId(""); }}
          placeholder="Business name" required autoComplete="off" autoCapitalize="words"
          className="w-full px-3.5 py-3 bg-white/10 border border-white/20 rounded-xl text-white text-[15px] placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-white/25" />
      )}
      {/* City is asked for rather than inferred. A scan lead used to inherit
          the creator's city, which is wrong the moment a creator films outside
          their own, and it is what feature matching runs on. */}
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
  </Shell>;
}
