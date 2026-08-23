import { useEffect, useState } from "react";
import { loadGoogleMaps } from "./loadGoogleMaps";

// Google closed the legacy google.maps.places.Autocomplete widget to new
// customers on 1 March 2025: it loads without error and simply returns no
// predictions. This uses PlaceAutocompleteElement, the supported replacement,
// which is a web component rather than something bound to an existing input.
//
// Loaded only when a key is configured. Without one the plain input below is
// used, the lead is still captured, and the server falls back to matching the
// business by name instead of by place_id.
export function usePlacesElement(
  key: string | undefined,
  host: React.RefObject<HTMLDivElement | null>,
  onPlace: (p: { placeId: string; address: string; name: string }) => void,
  onText: (v: string) => void,
  // The widget declares color-scheme: light dark on itself, so it follows the
  // machine's setting and a parent's color-scheme cannot override it. On a
  // dark-mode machine that put a black bar inside the white business modal.
  // Passed as a primitive rather than an options object so it can go in the
  // dependency array without re-running the effect on every render.
  colorScheme?: "light" | "dark",
) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!key) return;
    let cancelled = false;

    (async () => {
      try {
        await loadGoogleMaps(key);
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
        if (colorScheme) el.style.colorScheme = colorScheme;
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
  }, [key, colorScheme]);

  return ready;
}
