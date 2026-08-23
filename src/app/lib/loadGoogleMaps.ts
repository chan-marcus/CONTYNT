// One Maps bootstrap for the whole app.
//
// This was inline in usePlacesElement, which was fine while the autocomplete on
// the referral and scan forms was the only thing that wanted Google. The
// creator portal's Features map is the second, and two components appending
// their own <script> would either load the API twice or -- worse -- have the
// second one silently do nothing because the first tag already claimed the id,
// leaving whoever lost the race waiting on a callback that already fired.
//
// So the promise is cached at module scope: every caller after the first gets
// the same one, whether it is still in flight or already settled.
let pending: Promise<void> | null = null;

const ready = () => typeof (window as any).google?.maps?.importLibrary === "function";

export function loadGoogleMaps(key: string): Promise<void> {
  if (ready()) return Promise.resolve();
  if (pending) return pending;

  pending = new Promise<void>((resolve, reject) => {
    // With loading=async the script's onload fires before the bootstrap has
    // attached google.maps.importLibrary, so waiting on onload alone gives
    // "importLibrary is not a function". Google's documented answer is the
    // callback parameter, which fires once the API is genuinely ready.
    const cbName = "__contyntMapsReady";
    (window as any)[cbName] = () => resolve();

    const sc = document.createElement("script");
    sc.id = "contynt-maps";
    sc.async = true;
    // libraries=places covers the autocomplete element. Anything else -- the
    // map itself, geocoding -- comes through importLibrary once this resolves,
    // so nothing needs adding here to load a new one.
    sc.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}`
           + `&libraries=places&loading=async&v=weekly&callback=${cbName}`;
    sc.onerror = () => {
      // Cleared so a later mount can retry rather than await a promise that
      // will never settle -- a blocked script is often a transient network
      // failure, not a permanent one.
      pending = null;
      reject(new Error("maps script failed to load"));
    };
    document.head.appendChild(sc);
  });

  return pending;
}
