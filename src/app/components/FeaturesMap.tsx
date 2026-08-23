import { useEffect, useRef, useState } from "react";
import { MapPin } from "lucide-react";
import { loadGoogleMaps } from "../lib/loadGoogleMaps";

interface MapFeature {
  id: string;
  businessName: string;
  address: string;
  city: string;
  category: string;
  payoutRange: string;
  placeId?: string | null;
}

// Coordinates are resolved from the business's place_id first, and only from
// its address if there is no place_id.
//
// That order is on purpose. A place_id is what Places already captured at
// signup, and it resolves to the exact point Google holds for that business --
// where geocoding a formatted address returns a best guess at a street number,
// which for a business on a long block can sit doors away. The fallback still
// earns its place: a Feature added by hand in the admin dashboard has an
// address and no Place behind it, and a pin roughly right beats no pin.
//
// Cached in localStorage indefinitely, keyed by whichever lookup produced it.
// Neither a place_id nor a street address moves, so a second visit should not
// re-bill either lookup.
const GEO_KEY = "contynt_geo_v2";

type Cache = Record<string, { lat: number; lng: number } | null>;

function readCache(): Cache {
  try { return JSON.parse(localStorage.getItem(GEO_KEY) || "{}"); } catch { return {}; }
}
function writeCache(c: Cache) {
  try { localStorage.setItem(GEO_KEY, JSON.stringify(c)); } catch { /* private mode, or full */ }
}

// Dark to match the portal rather than Google's default daylight blue, which
// looks like an embed someone forgot to style. Deliberately low contrast: the
// pins are the content, the map is the backdrop, and every extra label is
// something competing with them.
const MAP_STYLE = [
  { elementType: "geometry", stylers: [{ color: "#1c1c1f" }] },
  { elementType: "labels.icon", stylers: [{ visibility: "off" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#8a8a8a" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#1c1c1f" }] },
  { featureType: "administrative", elementType: "geometry", stylers: [{ visibility: "off" }] },
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#2a2a2e" }] },
  { featureType: "road", elementType: "labels", stylers: [{ visibility: "off" }] },
  { featureType: "road.arterial", elementType: "geometry", stylers: [{ color: "#303035" }] },
  { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#3a3a41" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#111114" }] },
  { featureType: "landscape.natural", elementType: "geometry", stylers: [{ color: "#191a1d" }] },
];

// Blue to match the portal's accent, drawn rather than dropped in as a default
// red teardrop. Scaled at 2x and handed back at half size so it stays crisp on
// a phone screen.
const PIN = {
  path: "M12 0C7.03 0 3 4.03 3 9c0 6.75 9 15 9 15s9-8.25 9-15c0-4.97-4.03-9-9-9z",
  fillColor: "#3b82f6",
  fillOpacity: 1,
  strokeColor: "#ffffff",
  strokeWeight: 1.5,
  scale: 1.15,
  anchor: { x: 12, y: 24 },
};

export function FeaturesMap({ apiKey, features }: { apiKey?: string; features: MapFeature[] }) {
  const host = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "empty" | "failed">("idle");
  const [count, setCount] = useState(0);

  // Only the place ids matter for whether this needs to redraw. Keyed on them
  // rather than on the array identity, which is new on every portal poll and
  // would otherwise rebuild the map every few seconds.
  const addressKey = features.map(f => f.placeId || "").join("|");

  useEffect(() => {
    if (!apiKey || features.length === 0) { setState("empty"); return; }
    let cancelled = false;
    setState("loading");

    (async () => {
      try {
        await loadGoogleMaps(apiKey);
        if (cancelled) return;
        const g = (window as any).google;
        const { Map, InfoWindow } = await g.maps.importLibrary("maps");
        const { Marker } = await g.maps.importLibrary("marker");
        if (cancelled || !host.current) return;

        const { Place } = await g.maps.importLibrary("places");
        const geocoder = new g.maps.Geocoder();
        const cache = readCache();
        const located: { f: MapFeature; pos: { lat: number; lng: number } }[] = [];
        let cacheDirty = false;

        for (const f of features) {
          const pid = (f.placeId || "").trim();
          const addr = (f.address || "").trim();
          const key = pid || addr;
          if (!key) continue;
          // A null in the cache is a remembered failure, so a place_id that no
          // longer resolves -- or the junk address on a seed row -- is not
          // retried on every single load.
          if (key in cache) {
            if (cache[key]) located.push({ f, pos: cache[key]! });
            continue;
          }
          let pos: { lat: number; lng: number } | null = null;
          if (pid) {
            try {
              const place = new Place({ id: pid });
              await place.fetchFields({ fields: ["location"] });
              if (place.location) pos = { lat: place.location.lat(), lng: place.location.lng() };
            } catch { /* falls through to the address below */ }
          }
          if (!pos && addr) {
            try {
              const res: any = await new Promise((resolve, reject) =>
                geocoder.geocode({ address: addr }, (r: any, status: string) =>
                  status === "OK" && r?.[0] ? resolve(r[0]) : reject(new Error(status))));
              const loc = res.geometry.location;
              pos = { lat: loc.lat(), lng: loc.lng() };
            } catch { /* nothing more to try */ }
          }
          cache[key] = pos; cacheDirty = true;
          if (pos) located.push({ f, pos });
        }
        if (cacheDirty) writeCache(cache);
        if (cancelled) return;

        if (located.length === 0) { setState("empty"); return; }

        const map = new Map(host.current, {
          styles: MAP_STYLE,
          // Every control off. This is an orientation aid a few hundred pixels
          // tall, not something to navigate in -- the pins are the point, and
          // the cards below are where the detail lives. Pinch and ctrl-scroll
          // still work for anyone who wants a closer look.
          //
          // What cannot come off is the Google wordmark and the "Map data (c)
          // Google / Terms" line. Those are required attribution under the Maps
          // Platform terms; CSS could hide them and doing so risks the key.
          disableDefaultUI: true,
          zoomControl: false,
          keyboardShortcuts: false,
          gestureHandling: "cooperative",
          backgroundColor: "#1c1c1f",
        });

        const bounds = new g.maps.LatLngBounds();
        const info = new InfoWindow();

        for (const { f, pos } of located) {
          const marker = new Marker({ map, position: pos, icon: PIN, title: f.businessName });
          marker.addListener("click", () => {
            info.setContent(
              `<div style="font-family:Inter,system-ui,sans-serif;padding:2px 4px;min-width:140px">
                 <div style="font-weight:600;font-size:13px;color:#0a0a0a">${escapeHtml(f.businessName)}</div>
                 ${f.category ? `<div style="font-size:12px;color:#525252;margin-top:2px">${escapeHtml(f.category)}</div>` : ""}
                 ${f.payoutRange ? `<div style="font-size:12px;color:#2563eb;font-weight:600;margin-top:4px">${escapeHtml(f.payoutRange)}</div>` : ""}
               </div>`);
            info.open({ map, anchor: marker });
          });
          bounds.extend(pos);
        }

        map.fitBounds(bounds, 48);
        // fitBounds on a single pin zooms to the building. One listener, removed
        // as it fires, so a creator who zooms in afterwards is not yanked back.
        g.maps.event.addListenerOnce(map, "idle", () => {
          if (map.getZoom() > 15) map.setZoom(15);
        });

        setCount(located.length);
        setState("ready");
      } catch {
        // A referrer-restricted key, a blocked script, a CSP that forgot
        // places.googleapis.com: all of them end here, and none of them should
        // cost the creator the Features list underneath.
        if (!cancelled) setState("failed");
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, addressKey]);

  // Nothing to show and nothing worth apologising for: the list below is the
  // real content, so a map that cannot render simply is not there.
  if (!apiKey || state === "empty" || state === "failed") return null;

  return (
    <div className="w-full rounded-2xl overflow-hidden border border-white/10 bg-white/5">
      <div className="flex items-center gap-1.5 px-4 py-2.5 border-b border-white/10">
        <MapPin className="w-3.5 h-3.5 text-blue-400" strokeWidth={2} />
        <span className="text-xs text-neutral-300 font-medium">
          {state === "ready" ? `${count} feature${count === 1 ? "" : "s"} near you` : "Loading map…"}
        </span>
      </div>
      <div className="relative">
        <div ref={host} className="w-full h-[180px] sm:h-[220px] bg-neutral-900" />
        {state === "loading" && (
          <div className="absolute inset-0 flex items-center justify-center bg-neutral-900">
            <div className="w-5 h-5 border-2 border-white/20 border-t-blue-400 rounded-full animate-spin" />
          </div>
        )}
      </div>
    </div>
  );
}

function escapeHtml(s: string) {
  return String(s ?? "").replace(/[&<>"']/g, m =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m] as string));
}
