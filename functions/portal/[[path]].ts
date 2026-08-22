// Serves getcontynt.com/portal/* from the Supabase edge function.
//
// The verification link goes in an email. A link to
// kskqipduwovvedcuhwre.supabase.co in a message signed CONTYNT reads like
// phishing, and the mismatch between the link domain and the From domain is a
// small deliverability drag on top of that. This makes the link
// getcontynt.com/portal/verify?t=... without moving any of the logic, which has
// to stay server side: it needs a real 302 and a real 400, neither of which the
// SPA can produce.
//
// Why a Function and not a _redirects rule: Pages will not proxy to an external
// origin. "Proxying will only support relative URLs on your site. You cannot
// proxy external domains." A 30x rule would work but would put the Supabase URL
// straight back in the address bar, which is the thing being fixed.
//
// The `/*  /index.html  200` catch-all in public/_redirects does not shadow
// this: Pages routes to Functions before it consults _redirects, and the
// auto-generated _routes.json scopes that to /portal/* so every other path is
// still served straight off the CDN.

const UPSTREAM = "https://kskqipduwovvedcuhwre.supabase.co/functions/v1/make-server-f5961d0c/portal";

interface Context {
  request: Request;
  params: { path?: string | string[] };
}

export async function onRequest(context: Context): Promise<Response> {
  const { request, params } = context;
  const url = new URL(request.url);

  const raw = params.path;
  const segments = Array.isArray(raw) ? raw : raw ? [raw] : [];

  // Pages hands these over already decoded, so a ".." would be a real path
  // segment by the time it got joined onto UPSTREAM -- and fetch would then
  // normalise /portal/../admin back out of the portal prefix. The admin routes
  // behind it check x-admin-token, so this is a second lock rather than the
  // only one, but a proxy that can be walked out of is not worth shipping.
  if (segments.some(s => !s || s === "." || s === ".." || s.includes("/"))) {
    return new Response("Not found", { status: 404 });
  }

  const target = `${UPSTREAM}${segments.length ? "/" + segments.join("/") : ""}${url.search}`;

  const headers = new Headers(request.headers);
  // Host has to go: left in place it names getcontynt.com, and Supabase routes
  // on it.
  headers.delete("host");

  // Buffered rather than streamed. The only POST through here is the resend
  // form, which is two fields, and a buffered body sidesteps the half-duplex
  // streaming rules entirely.
  const method = request.method.toUpperCase();
  const body = method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer();

  const upstream = await fetch(target, {
    method,
    headers,
    body,
    // The success path is a 302 to /app?creator=...&view=confirm. Following it
    // here would hand the browser the confirm page under /portal/verify, so the
    // address bar would keep saying "verify" and a refresh would replay a token
    // that has already been spent.
    redirect: "manual",
  });

  // Headers on a fetch response are immutable, so they are copied to be edited.
  const out = new Headers(upstream.headers);
  // Workers decompress the upstream body but leave these describing the
  // compressed bytes, which makes the browser fail to parse the response.
  out.delete("content-encoding");
  out.delete("content-length");
  // Tokenised URLs, so keep them out of indexes even if one leaks into a
  // crawler. The function sets this on its own error pages; this covers the
  // redirect too.
  out.set("x-robots-tag", "noindex, nofollow");

  // Supabase rewrites the content type of anything a function returns to
  // text/plain, so the resend and expired-link pages arrived as a wall of HTML
  // source in the browser -- which is what a creator with a dead link saw. The
  // upstream only ever answers /portal/* with an HTML page or a bodiless
  // redirect, so anything carrying a body here is HTML and is labelled as such.
  // Narrow on purpose: a real content type from upstream is left alone.
  const upstreamType = upstream.headers.get("content-type") ?? "";
  const isRedirect = upstream.status >= 300 && upstream.status < 400;
  if (!isRedirect && (!upstreamType || upstreamType.startsWith("text/plain"))) {
    out.set("content-type", "text/html; charset=utf-8");

    // Supabase also sends "default-src 'none'; sandbox" on every function
    // response. Copied through, it blocked the page's inline <style>, and the
    // bare `sandbox` -- no allow-forms -- stopped the resend form submitting at
    // all, so the one recovery a creator with a dead link has did nothing when
    // pressed. Replaced rather than deleted, and no looser than the page needs:
    // these sheets have no scripts, no images and one form that posts home.
    out.set(
      "content-security-policy",
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: out,
  });
}
