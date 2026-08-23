import { useEffect, useState } from "react";

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
