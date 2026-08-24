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
  // Three states rather than two. "Requested" is asked-for and not yet granted,
  // which is a different thing from a Feature the creator is holding -- one is
  // waiting on somebody else, the other is waiting on them.
  pinState?: "requested" | "active" | "available";
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
  // Dark to sit inside the portal rather than punch a daylight-blue hole in it,
  // but not so dark that it stops being a map. The first pass took the geometry
  // to #1c1c1f and the roads to #2a2a2e, which on a phone read as an empty box
  // with pins floating on it -- there has to be enough street structure to tell
  // you which part of the city you are looking at.
  //
  // Everything is tinted slightly blue rather than neutral grey, which is what
  // ties it to the portal's accent without colouring anything literally blue.
  { elementType: "geometry", stylers: [{ color: "#242833" }] },
  { elementType: "labels.icon", stylers: [{ visibility: "off" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#9aa3b5" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#14161b" }] },

  // Neighbourhood and city names only. They are how a creator recognises where
  // this is at a glance, and at this size there is room for nothing else.
  { featureType: "administrative", elementType: "geometry", stylers: [{ visibility: "off" }] },
  { featureType: "administrative.land_parcel", stylers: [{ visibility: "off" }] },
  { featureType: "administrative.neighborhood", elementType: "labels.text.fill", stylers: [{ color: "#6b7284" }] },
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "poi.park", elementType: "geometry", stylers: [{ color: "#1b2a22" }] },

  // Three weights, each a step lighter, so the arterials and freeways read as a
  // skeleton of the city instead of everything sitting at one flat value.
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#3d4453" }] },
  { featureType: "road", elementType: "labels", stylers: [{ visibility: "off" }] },
  { featureType: "road.arterial", elementType: "labels.text", stylers: [{ visibility: "on" }] },
  { featureType: "road.arterial", elementType: "labels.text.fill", stylers: [{ color: "#767e8f" }] },
  { featureType: "road.arterial", elementType: "geometry", stylers: [{ color: "#4e5768" }] },
  { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#616b80" }] },
  { featureType: "road.highway", elementType: "geometry.stroke", stylers: [{ color: "#343a47" }] },

  { featureType: "transit", stylers: [{ visibility: "off" }] },
  { featureType: "landscape.natural", elementType: "geometry", stylers: [{ color: "#1f222b" }] },
  // Water darker than the land it borders, so the bay and the ocean read as
  // edges. In San Francisco that outline is most of what tells you where you
  // are without a single label.
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#151922" }] },
  { featureType: "water", elementType: "labels.text.fill", stylers: [{ color: "#3f4757" }] },
];

// Three pins, because the three states are not equally interesting and they
// are not equally urgent either.
//
//   active     held, approved or submitted -- the creator owes somebody a Reel,
//              and there is a clock on it. Full-strength brand blue, biggest.
//   requested  asked for, not yet granted. Same hue so it still reads as "mine",
//              lighter because nothing is owed yet and it may not be granted.
//   available  on offer to anyone. Slate: the background the blues read against.
//
// Same hue for the first two on purpose. Two unrelated colours would say these
// are unrelated states; a lighter tint says the same thing, earlier.
const PIN_PATH = "M12 0C7.03 0 3 4.03 3 9c0 6.75 9 15 9 15s9-8.25 9-15c0-4.97-4.03-9-9-9z";

const PIN_ACTIVE = {
  path: PIN_PATH,
  fillColor: "#3b82f6",
  fillOpacity: 1,
  strokeColor: "#ffffff",
  strokeWeight: 1.6,
  scale: 1.35,
  anchor: { x: 12, y: 24 },
};

const PIN_REQUESTED = {
  path: PIN_PATH,
  fillColor: "#93c5fd",
  fillOpacity: 1,
  // Darker outline than the fill, or a pale pin on pale road geometry loses its
  // edge entirely.
  strokeColor: "#1e3a8a",
  strokeWeight: 1.2,
  scale: 1.2,
  anchor: { x: 12, y: 24 },
};

const PIN_AVAILABLE = {
  path: PIN_PATH,
  fillColor: "#64748b",
  fillOpacity: 0.92,
  strokeColor: "#cbd5e1",
  strokeWeight: 1.1,
  scale: 1.05,
  anchor: { x: 12, y: 24 },
};

const PIN_FOR = { active: PIN_ACTIVE, requested: PIN_REQUESTED, available: PIN_AVAILABLE };
// Active above requested above available, so the one with a clock on it is
// never the pin hidden behind another.
const PIN_Z = { active: 3, requested: 2, available: 1 };

export function FeaturesMap({ apiKey, features }: { apiKey?: string; features: MapFeature[] }) {
  const host = useRef<HTMLDivElement | null>(null);
  // The map is built once and kept. Constructing a second one on a div that
  // already holds a map leaves the div blank -- which is exactly what happened
  // when a Feature moved to in-progress: the redraw key changed, the effect
  // re-ran, and the whole map vanished instead of one pin changing colour.
  const mapRef = useRef<any>(null);
  const markersRef = useRef<any[]>([]);
  const infoRef = useRef<any>(null);
  const fittedRef = useRef(false);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "empty" | "failed">("idle");
  const [count, setCount] = useState(0);
  const [inProgressCount, setInProgressCount] = useState(0);

  // Only the place ids matter for whether this needs to redraw. Keyed on them
  // rather than on the array identity, which is new on every portal poll and
  // would otherwise rebuild the map every few seconds.
  const addressKey = features.map(f => `${f.placeId || f.address || ""}:${f.pinState ?? "available"}`).join("|");

  useEffect(() => {
    if (!apiKey || features.length === 0) { setState("empty"); return; }
    let cancelled = false;
    // Only the first pass shows the spinner. On a later pass the map is already
    // on screen and covering it would be a flash of nothing for no reason.
    if (!mapRef.current) setState("loading");

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

        const map = mapRef.current ?? new Map(host.current, {
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
          backgroundColor: "#242833",
        });
        mapRef.current = map;

        const bounds = new g.maps.LatLngBounds();
        const info = infoRef.current ?? new InfoWindow();
        infoRef.current = info;

        // Only the pins are rebuilt. They are cheap, they are what actually
        // changed, and detaching them by hand is the whole reason the map
        // underneath can be left alone.
        info.close();
        for (const m of markersRef.current) m.setMap(null);
        markersRef.current = [];

        for (const { f, pos } of located) {
          const st = f.pinState ?? "available";
          const marker = new Marker({
            map, position: pos, title: f.businessName,
            icon: PIN_FOR[st], zIndex: PIN_Z[st],
          });
          marker.addListener("click", () => {
            info.setContent(
              `<div style="font-family:Inter,system-ui,sans-serif;padding:2px 4px;min-width:140px">
                 <div style="font-weight:600;font-size:13px;color:#0a0a0a">${escapeHtml(f.businessName)}</div>
                 ${f.category ? `<div style="font-size:12px;color:#525252;margin-top:2px">${escapeHtml(f.category)}</div>` : ""}
                 ${f.payoutRange ? `<div style="font-size:12px;color:#2563eb;font-weight:600;margin-top:4px">${escapeHtml(f.payoutRange)}</div>` : ""}
                 ${st === "available" ? "" : `<div style="font-size:11px;color:#525252;margin-top:4px">${st === "requested" ? "Requested" : "In progress"}</div>`}
               </div>`);
            info.open({ map, anchor: marker });
          });
          markersRef.current.push(marker);
          bounds.extend(pos);
        }

        // Fitted once. Re-fitting on every change would yank the view back
        // whenever a Feature changed state, undoing wherever the creator had
        // panned to.
        if (!fittedRef.current) {
          fittedRef.current = true;
          map.fitBounds(bounds, 48);
          // fitBounds on a single pin zooms to the building. One listener,
          // removed as it fires, so a creator who zooms in afterwards is not
          // yanked back out.
          g.maps.event.addListenerOnce(map, "idle", () => {
            if (map.getZoom() > 15) map.setZoom(15);
          });
        }

        setCount(located.length);
        setInProgressCount(located.filter(l => (l.f.pinState ?? "available") !== "available").length);
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
          {state === "ready"
            ? (inProgressCount > 0
                ? `${inProgressCount} in progress · ${count - inProgressCount} available`
                : `${count} feature${count === 1 ? "" : "s"} near you`)
            : "Loading map…"}
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
