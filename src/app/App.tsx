import { useEffect, useState } from "react";
import { Hero } from "./components/Hero";
import { SocialProof } from "./components/SocialProof";
import { HowItWorks } from "./components/HowItWorks";
import { Features } from "./components/Features";
import { ValueSection } from "./components/ValueSection";
import { TrustSection } from "./components/TrustSection";
import { BusinessCTA } from "./components/BusinessCTA";
import { FAQ } from "./components/FAQ";
import { FinalCTA } from "./components/FinalCTA";
import { Footer } from "./components/Footer";
import { Header } from "./components/Header";
import { Analytics } from "./components/Analytics";
import { Info } from "./components/Info";
import { CreatorPortal } from "./components/CreatorPortal";
import { ConfirmProfile } from "./components/ConfirmProfile";
import { CreatorLogin, CREATOR_TOKEN_KEY } from "./components/CreatorLogin";
import { ReferralLanding } from "./components/ReferralLanding";
import { CreatorSubmissionPending } from "./components/CreatorSubmissionPending";
import { BusinessPortal } from "./components/BusinessPortal";
import { BusinessLogin, BIZ_TOKEN_KEY } from "./components/BusinessLogin";
import { LoginChooser } from "./components/LoginChooser";
import { AmbassadorPrintSheet, AmbassadorQrScreen } from "./components/AmbassadorCards";
import { ScanPage } from "./components/ScanPage";
import { projectId, publicAnonKey } from "/utils/supabase/info";

// Generate or retrieve visitor ID
function getVisitorId() {
  let visitorId = localStorage.getItem("contynt_visitor_id");
  if (!visitorId) {
    visitorId = `visitor_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    localStorage.setItem("contynt_visitor_id", visitorId);
  }
  return visitorId;
}

export default function App() {
  const [showAnalytics, setShowAnalytics] = useState(false);
  const [showInfo, setShowInfo] = useState(false);

  // Routing via query params
  const params = new URLSearchParams(window.location.search);
  const creatorToken = params.get("creator");
  const bizToken = params.get("biz");
  const adminToken = params.get("admin");
  const view = params.get("view");
  const referralCode = params.get("ref");
  // Admin impersonation. Never persisted as a session, so an admin looking at a
  // creator's portal does not end up stuck in it on their next visit.
  const impersonating = params.get("imp") === "1";

  // A verified login is remembered, so creators do not sign in every visit and
  // never need a unique link. Tokens arriving in the URL are persisted too, but
  // an impersonation token never is.
  if (creatorToken && !impersonating) {
    try { localStorage.setItem(CREATOR_TOKEN_KEY, creatorToken); } catch { /* private mode */ }
  }
  let storedCreator: string | null = null;
  try { storedCreator = localStorage.getItem(CREATOR_TOKEN_KEY); } catch { /* private mode */ }
  const activeCreator = creatorToken || storedCreator;

  // Businesses now sign in with an emailed code too, so their token is
  // remembered on exactly the same terms: persisted unless an admin is
  // impersonating, and never for an impersonation token.
  if (bizToken && !impersonating) {
    try { localStorage.setItem(BIZ_TOKEN_KEY, bizToken); } catch { /* private mode */ }
  }
  let storedBiz: string | null = null;
  try { storedBiz = localStorage.getItem(BIZ_TOKEN_KEY); } catch { /* private mode */ }
  const activeBiz = bizToken || storedBiz;

  // /app is the creator entrance, /business the owner's, /login the chooser
  // between them. Trailing slashes are stripped so /app/ is not treated as a
  // different route.
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  const isAppPath = path === "/app";
  const isBusinessPath = path === "/business";
  const isLoginPath = path === "/login";

  // Every hook must run on every render, so these route tests are computed up
  // front and the effect below is hoisted above the returns that follow.
  const creatorRedirect = !isAppPath && !!(creatorToken || view === "login" || view === "confirm" || view === "cards" || view === "qr");
  const businessRedirect = !isBusinessPath && !!bizToken;
  const isRedirecting = creatorRedirect || businessRedirect;
  const isLanding = !referralCode && !adminToken && !isRedirecting
    && !isAppPath && !isBusinessPath && !isLoginPath
    && view !== "submission"
    && !/^\/[ABCDEFGHJKMNPQRSTVWXYZ23456789]{6}$/i.test(path);

  useEffect(() => {
    // Guarded in the body rather than by placement, so the hook itself always
    // runs. Effects fire child-first, so an unguarded parent effect here would
    // land after each portal's own title effect and overwrite it.
    if (!isLanding) return;
    document.title = "CONTYNT | Local Creator Network";

    // Helper to upsert a <meta> tag
    const setMeta = (attrs: Record<string, string>) => {
      const selector = Object.entries(attrs)
        .filter(([k]) => k !== "content")
        .map(([k, v]) => `[${k}="${v}"]`)
        .join("");
      let el = document.head.querySelector(`meta${selector}`) as HTMLMetaElement | null;
      if (!el) {
        el = document.createElement("meta");
        Object.entries(attrs).forEach(([k, v]) => el!.setAttribute(k, v));
        document.head.appendChild(el);
      } else {
        el.setAttribute("content", attrs.content);
      }
    };

    const description =
      "CONTYNT connects Instagram Reels creators with local businesses that pay per post. No follower minimum. Sign up for early access in San Francisco, Los Angeles, and New York City.";
    const siteUrl = window.location.origin;
    const ogImage = `${siteUrl}/og-image.png`;

    // Core
    setMeta({ name: "description", content: description });
    setMeta({ name: "keywords", content: "creator platform, get paid to post, instagram reels, local business marketing, content creator jobs, contynt" });
    setMeta({ name: "robots", content: "index, follow" });

    // Open Graph
    setMeta({ property: "og:type", content: "website" });
    setMeta({ property: "og:url", content: siteUrl });
    setMeta({ property: "og:title", content: "CONTYNT — Get Paid to Post" });
    setMeta({ property: "og:description", content: description });
    setMeta({ property: "og:image", content: ogImage });
    setMeta({ property: "og:site_name", content: "CONTYNT" });

    // Twitter Card
    setMeta({ name: "twitter:card", content: "summary_large_image" });
    setMeta({ name: "twitter:title", content: "CONTYNT — Get Paid to Post" });
    setMeta({ name: "twitter:description", content: description });
    setMeta({ name: "twitter:image", content: ogImage });

    // Canonical
    let canonical = document.head.querySelector("link[rel='canonical']") as HTMLLinkElement | null;
    if (!canonical) {
      canonical = document.createElement("link");
      canonical.rel = "canonical";
      document.head.appendChild(canonical);
    }
    canonical.href = siteUrl;

    // JSON-LD structured data
    const existing = document.getElementById("contynt-jsonld");
    if (existing) existing.remove();
    const script = document.createElement("script");
    script.id = "contynt-jsonld";
    script.type = "application/ld+json";
    script.text = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Organization",
      name: "CONTYNT",
      url: siteUrl,
      description,
      areaServed: ["San Francisco", "Los Angeles", "New York City"],
      sameAs: [],
    });
    document.head.appendChild(script);

    // Check URL hash for analytics and businesses
    const checkHash = () => {
      setShowAnalytics(window.location.hash === "#analytics");
      setShowInfo(window.location.hash === "#businesses");
    };
    checkHash();
    window.addEventListener("hashchange", checkHash);

    // Track page view (only on main site)
    if (window.location.hash !== "#analytics" && window.location.hash !== "#businesses") {
      const trackPageView = async () => {
        try {
          const response = await fetch(
            `https://${projectId}.supabase.co/functions/v1/make-server-f5961d0c/analytics/pageview`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${publicAnonKey}`,
              },
              body: JSON.stringify({
                visitorId: getVisitorId(),
                userAgent: navigator.userAgent,
                referrer: document.referrer,
              }),
            }
          );

          if (!response.ok) {
            console.warn("Analytics tracking returned non-OK status:", response.status);
          }
        } catch (error) {
          // Silently fail - analytics should not break the site
          // Error likely means server not deployed yet
          console.debug("Analytics not yet available - deploy the Supabase server to enable tracking");
        }
      };

      trackPageView();
    }

    return () => window.removeEventListener("hashchange", checkHash);
  }, [isLanding]);

  // Ambassador card scans live at the bare code, getcontynt.com/4JEAZ7. The
  // match is deliberately narrow -- exactly six characters from the code
  // alphabet, which has no I, L, O, U, 0 or 1 -- and it is tested after every
  // real route (below), so a path that merely looks like a code can never take
  // one. An unknown code renders "this card is not active".
  const CODE_RE = /^\/([ABCDEFGHJKMNPQRSTVWXYZ23456789]{6})$/i;

  if (referralCode) return <ReferralLanding code={referralCode} />;
  if (adminToken) return <Analytics adminToken={adminToken} />;

  // Links minted before /app and /business existed still arrive at the root.
  // Forward them once, query string intact -- imp=1 has to survive, or an
  // impersonation token would be persisted as a real session on arrival. No loop
  // is possible: each target sets the path flag that produced the redirect.
  if (isRedirecting) {
    window.location.replace(`${creatorRedirect ? "/app" : "/business"}${window.location.search}`);
    return null;
  }

  if (isAppPath) {
    // Checked before the portal so ?view=confirm opens the confirmation screen
    // rather than dropping straight into the portal.
    // Rendered by the site, not the edge function: Supabase rewrites any HTML a
    // function returns to text/plain, so a server-rendered sheet opens as
    // source text in the browser.
    if (activeCreator && view === "cards") return <AmbassadorPrintSheet token={activeCreator} />;
    if (activeCreator && view === "qr") return <AmbassadorQrScreen token={activeCreator} />;
    if (activeCreator && view === "confirm") return <ConfirmProfile token={activeCreator} />;
    if (activeCreator) return <CreatorPortal token={activeCreator} impersonating={impersonating} />;
    return <CreatorLogin />;
  }

  // Signed out owners get the code form; a stored session goes straight in.
  // Reached only via /business, because every ?biz= link is redirected there.
  if (isBusinessPath) {
    if (activeBiz) return <BusinessPortal token={activeBiz} />;
    return <BusinessLogin />;
  }
  if (isLoginPath) return <LoginChooser />;
  if (view === "submission") return <CreatorSubmissionPending />;

  // Bare code last, so any real route added later wins over a string that
  // merely looks like a code.
  const bareScan = path.match(CODE_RE);
  if (bareScan) return <ScanPage code={bareScan[1].toUpperCase()} />;

  // Show analytics dashboard
  if (showAnalytics) {
    return <Analytics />;
  }

  // Show main landing page
  return (
    <div className="min-h-screen">
      <Header />
      <Hero />
      <SocialProof />
      <HowItWorks />
      <Features />
      <ValueSection />
      <FAQ />
      <TrustSection />
      <BusinessCTA />
      <FinalCTA />
      <Footer />

      {/* Info overlay */}
      {showInfo && <Info />}
    </div>
  );
}