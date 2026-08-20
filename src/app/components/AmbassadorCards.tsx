import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { projectId, publicAnonKey } from "/utils/supabase/info";

// The printable sheet and the on-screen QR are rendered here, in the browser,
// rather than by the edge function.
//
// Supabase Edge Functions may not serve HTML: whatever Content-Type the handler
// sets, the platform rewrites the response to text/plain and attaches
// `content-security-policy: default-src 'none'; sandbox`. A browser opening
// such a link therefore shows the markup as text instead of a page. That is a
// platform policy, not something a header can work around, so anything a person
// is meant to *look at* has to be rendered by the site.

const BASE = `https://${projectId}.supabase.co/functions/v1/make-server-f5961d0c`;
const AUTH = { Authorization: `Bearer ${publicAnonKey}`, "Content-Type": "application/json" };

function useAmbassadorCode(token: string) {
  const [state, setState] = useState<{ code: string; url: string } | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`${BASE}/creator-portal/ambassador?t=${encodeURIComponent(token)}`, { headers: AUTH });
        const d = await res.json().catch(() => null);
        if (!alive) return;
        if (!res.ok) { setError("Your session expired. Open the creator portal again."); return; }
        const code = d?.ambassadorCode;
        if (!code) { setError("Ambassador Mode is not enabled yet."); return; }
        setState({ code, url: d.cardUrl || `https://getcontynt.com/${code}` });
      } catch { if (alive) setError("Could not reach the server."); }
    })();
    return () => { alive = false; };
  }, [token]);

  return { state, error };
}

// Display only. Hosts are case-insensitive, so capitalising the words makes the
// link easier to read off a card and type; the QR and the stored URL keep the
// real lowercase form.
const prettyUrl = (u: string) =>
  u.replace(/^https?:\/\//, "").replace(/^getcontynt\.com/i, "GetContynt.com");

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
                  background: "#0a0a0a", color: "#fff", padding: 24, textAlign: "center",
                  fontFamily: "-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif" }}>
      <div style={{ maxWidth: 380 }}>{children}</div>
    </div>
  );
}

// ─── Printable: 4 identical cards, 2x2 on a letter sheet ─────────────────────
export function AmbassadorPrintSheet({ token }: { token: string }) {
  const { state, error } = useAmbassadorCode(token);
  const [qr, setQr] = useState("");

  useEffect(() => {
    document.title = "CONTYNT | Ambassador cards";
    if (!state) return;
    QRCode.toDataURL(state.url, { width: 640, margin: 1 }).then(setQr).catch(() => setQr(""));
  }, [state]);

  if (error) return <Centered><h1 style={{ fontSize: 20, marginBottom: 8 }}>Can't print yet</h1><p style={{ color: "#a3a3a3", fontSize: 14 }}>{error}</p></Centered>;
  if (!state || !qr) return <Centered><p style={{ color: "#a3a3a3", fontSize: 14 }}>Preparing your cards…</p></Centered>;

  const card = (i: number) => (
    <div className="amb-card" key={i}>
      <div className="amb-inner">
        <div className="amb-brand">C O N T Y N T</div>
        <div className="amb-lead">A creator filmed a Reel here.</div>
        <div className="amb-cta">Claim your business dashboard</div>
        <img className="amb-qr" src={qr} alt="" />
        <div className="amb-or">Scan the code, or go to</div>
        <div className="amb-url">{prettyUrl(state.url)}</div>
      </div>
    </div>
  );

  return (
    <>
      <style>{`
        /* No page margin, so the four cards tile the whole sheet. Cutting the
           two midlines then gives four identical cards and no leftover strips
           -- with a margin the sheet floated in the middle of the paper and
           every cut card carried a different amount of blank edge. */
        @page { size: letter; margin: 0; }
        html,body{background:#fff;margin:0;padding:0;width:100%;height:100%}
        body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;color:#0a0a0a}
        .amb-sheet{position:relative;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;
                   width:216mm;height:279mm;margin:0 auto;box-sizing:border-box}
        .amb-card{position:relative;page-break-inside:avoid;break-inside:avoid}
        .amb-inner{position:absolute;inset:9mm;border:1pt solid #d4d4d4;border-radius:4mm;
                   display:flex;flex-direction:column;align-items:center;justify-content:center;
                   text-align:center;padding:6mm;box-sizing:border-box}
        .amb-brand{font-size:9pt;font-weight:700;letter-spacing:.34em;color:#111}
        .amb-lead{font-size:10pt;color:#525252;margin-top:2mm}
        /* The reason to scan, set darker than the lead so it reads as the ask. */
        .amb-cta{font-size:10.5pt;font-weight:600;color:#111;margin-top:1.5mm}
        .amb-qr{width:50mm;height:50mm;margin:4mm 0 0;display:block}
        /* The URL is the fallback when a camera will not focus, and it carries
           the code inside it, so there is no separate code to print. Set large
           and monospaced to survive being read and typed across a counter. */
        .amb-or{font-size:8pt;color:#737373;margin-top:4mm}
        .amb-url{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:15pt;font-weight:700;
                 letter-spacing:.01em;color:#0a0a0a;line-height:1.2;margin-top:1.5mm;
                 white-space:nowrap}
        /* Perforation guides down both midlines, scissors at each midpoint. */
        .amb-perf{position:absolute;color:#a3a3a3;pointer-events:none}
        .amb-perf.v{left:50%;top:0;bottom:0;border-left:1pt dashed #bdbdbd;transform:translateX(-.5pt)}
        .amb-perf.h{top:50%;left:0;right:0;border-top:1pt dashed #bdbdbd;transform:translateY(-.5pt)}
        .amb-sc{position:absolute;font-size:10pt;line-height:1;color:#9ca3af;background:#fff;padding:1mm}
        .amb-sc.t{left:50%;top:-1mm;transform:translateX(-50%)}
        .amb-sc.b{left:50%;bottom:-1mm;transform:translateX(-50%)}
        .amb-sc.l{top:50%;left:-1mm;transform:translateY(-50%)}
        .amb-sc.r{top:50%;right:-1mm;transform:translateY(-50%)}
        .amb-bar{max-width:216mm;margin:14px auto 0;display:flex;gap:10px;justify-content:center}
        .amb-bar button{padding:10px 18px;border-radius:10px;border:1px solid #d4d4d4;background:#111;color:#fff;
                        font-size:13px;font-weight:600;cursor:pointer}
        .amb-note{max-width:216mm;margin:8px auto 14px;font-size:11px;color:#737373;text-align:center}
        @media print{
          /* Keep the guide lines exactly as designed rather than letting the
             browser drop "background" ink to save toner. */
          html,body{-webkit-print-color-adjust:exact;print-color-adjust:exact}
          .amb-noprint{display:none !important}
        }
      `}</style>
      <div className="amb-bar amb-noprint">
        <button onClick={() => window.print()}>Print this sheet</button>
      </div>
      <p className="amb-note amb-noprint">
        Cut along the dashed lines. Every card carries the same code, so any one of them works at any business.
        If your printer adds a margin, choose <strong>Margins: None</strong> in the print dialog.
      </p>
      <div className="amb-sheet">
        {[0, 1, 2, 3].map(card)}
        <div className="amb-perf v"><span className="amb-sc t">&#9986;</span><span className="amb-sc b">&#9986;</span></div>
        <div className="amb-perf h"><span className="amb-sc l">&#9986;</span><span className="amb-sc r">&#9986;</span></div>
      </div>
    </>
  );
}

// ─── On-screen QR, sized for another phone's camera ──────────────────────────
export function AmbassadorQrScreen({ token }: { token: string }) {
  const { state, error } = useAmbassadorCode(token);
  const [qr, setQr] = useState("");

  useEffect(() => {
    document.title = "CONTYNT | Your QR code";
    if (!state) return;
    QRCode.toDataURL(state.url, { width: 1000, margin: 1 }).then(setQr).catch(() => setQr(""));
  }, [state]);

  if (error) return <Centered><h1 style={{ fontSize: 20, marginBottom: 8 }}>Can't show your code</h1><p style={{ color: "#a3a3a3", fontSize: 14 }}>{error}</p></Centered>;
  if (!state || !qr) return <Centered><p style={{ color: "#a3a3a3", fontSize: 14 }}>Preparing your code…</p></Centered>;

  return (
    <div style={{ minHeight: "100vh", background: "#fff", color: "#0a0a0a", display: "flex",
                  flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 16,
                  fontFamily: "-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif" }}>
      {/* Sized off the viewport: the point is for someone else's phone to lock
          onto this from across a counter. */}
      <img src={qr} alt="" style={{ width: "min(88vw, 88vh)", height: "auto", display: "block" }} />
      <div style={{ fontFamily: "ui-monospace,SFMono-Regular,Menlo,monospace", fontWeight: 700,
                    fontSize: "clamp(28px,9vw,52px)", letterSpacing: ".18em", marginTop: 14 }}>
        {state.code}
      </div>
      <p style={{ marginTop: 10, fontSize: 13, color: "#6b7280", textAlign: "center", maxWidth: "34ch", lineHeight: 1.5 }}>
        Turn your screen brightness all the way up, then have them scan it.
      </p>
    </div>
  );
}
