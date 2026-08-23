import { Fragment, useMemo, useState } from "react";
import { Download, Send, Loader2, Check, X, AlertTriangle, CheckCircle2, MailCheck, Megaphone, Clock } from "lucide-react";

export interface ReadinessCreator {
  id: string; handle: string; email: string; city: string;
  tier: "Ready+" | "Ready" | "Warm" | "Cold";
  status: string;
  sentAt: string | null; openedAt: string | null; openCount: number; confirmedAt: string | null;
  neighborhoods: string[]; capacity: number | null;
  notifyEmail: boolean; notifyDm: boolean; notifySms: boolean;
  ambassadorOptedIn: boolean; payoutsConnected: boolean;
  delivered: boolean; bounced: boolean;
}

export interface ReadinessData {
  funnel: { sent: number; delivered: number; linkOpened: number; confirmed: number; ambassadorOptedIn: number; bounced: number };
  neighborhoods: string[];
  creators: ReadinessCreator[];
}

// Every send on this screen fails quietly by design -- the batch skips a creator
// when Postmark is not configured and reports "skipped", which looks a lot like
// the 24 hour cooldown. This panel is the difference between the two, and it
// asks Postmark rather than trusting our own environment variables.
export interface EmailHealth {
  ok: boolean;
  problem: string | null;
  config: {
    serverToken: boolean; webhookSecret: boolean; loginCodeSalt: boolean;
    from: string; broadcastStream: string; transactionalStream: string;
    siteOrigin: string; verifyLinkOrigin: string; webhookUrl: string;
  };
  server?: { name: string | null; id: number | null };
  streams?: string[];
}

function EmailHealthPanel({ health, onTest, testing, testResult }: {
  health: EmailHealth | null;
  onTest: (to: string) => void;
  testing: boolean;
  testResult: string;
}) {
  const [to, setTo] = useState("");
  const [open, setOpen] = useState(false);

  if (!health) {
    return (
      <div className="bg-white/5 border border-white/10 rounded-2xl px-4 py-3 text-xs text-neutral-500">
        Checking email configuration…
      </div>
    );
  }

  const { config } = health;
  // Sending is the hard requirement. The webhook only feeds the Delivered and
  // Bounced columns, so its absence is a warning rather than a blocker, and
  // saying so keeps the red state meaningful.
  const canSend = config.serverToken && health.ok;
  const tone = canSend
    ? (config.webhookSecret ? "border-green-500/25 bg-green-500/[0.07]" : "border-yellow-500/25 bg-yellow-500/[0.06]")
    : "border-red-500/30 bg-red-500/[0.07]";

  const notes: string[] = [];
  if (health.problem) notes.push(health.problem);
  if (config.serverToken && !config.webhookSecret) {
    notes.push("POSTMARK_WEBHOOK_SECRET is not set, so Delivered and Bounced below will stay at zero.");
  }

  const rows: [string, string, boolean][] = [
    ["Sending", config.serverToken ? `Postmark${health.server?.name ? ` · ${health.server.name}` : ""}` : "POSTMARK_SERVER_TOKEN not set", config.serverToken],
    ["From", config.from, !!config.from],
    ["Announcement stream", config.broadcastStream, !health.streams?.length || health.streams.includes(config.broadcastStream)],
    ["Login code stream", config.transactionalStream, !health.streams?.length || health.streams.includes(config.transactionalStream)],
    ["Delivery webhook", config.webhookSecret ? "Secret set" : "POSTMARK_WEBHOOK_SECRET not set", config.webhookSecret],
    ["Login code salt", config.loginCodeSalt ? "Set" : "Falling back to ADMIN_SECRET", config.loginCodeSalt],
  ];

  return (
    <div className={`border rounded-2xl px-4 py-3.5 space-y-3 ${tone}`}>
      <div className="flex items-start gap-2.5">
        {canSend
          ? <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0 mt-0.5" />
          : <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />}
        <div className="flex-1 min-w-0 space-y-1">
          <p className="text-xs font-semibold text-white">
            {canSend ? "Email is live" : "Email is not sending"}
          </p>
          {notes.map(n => <p key={n} className="text-[11px] text-neutral-300 leading-relaxed">{n}</p>)}
          {canSend && !notes.length && (
            <p className="text-[11px] text-neutral-400 leading-relaxed">
              Verification emails and login codes are both going out through Postmark.
            </p>
          )}
        </div>
        <button onClick={() => setOpen(o => !o)}
          className="text-[11px] text-neutral-400 hover:text-neutral-200 shrink-0">
          {open ? "Hide" : "Details"}
        </button>
      </div>

      {open && (
        <div className="space-y-2 pt-1">
          <div className="grid sm:grid-cols-2 gap-x-5 gap-y-1.5">
            {rows.map(([label, value, ok]) => (
              <div key={label} className="flex items-start gap-2 min-w-0">
                {ok
                  ? <Check className="w-3 h-3 text-green-400 shrink-0 mt-[3px]" />
                  : <X className="w-3 h-3 text-red-400 shrink-0 mt-[3px]" />}
                <span className="text-[11px] text-neutral-500 shrink-0">{label}</span>
                <span className="text-[11px] text-neutral-300 truncate" title={value}>{value}</span>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-neutral-500 break-all pt-1">
            Webhook URL for Postmark: <span className="text-neutral-400">{config.webhookUrl}</span>
          </p>

          {/* A real send is the only thing that surfaces an unconfirmed sender
              signature, which is the failure everyone hits first. */}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <input value={to} onChange={e => setTo(e.target.value)} type="email"
              placeholder="you@example.com"
              className="flex-1 min-w-[180px] bg-white/5 border border-white/15 rounded-lg px-2.5 py-1.5 text-xs text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-white/30" />
            <button onClick={() => onTest(to.trim())} disabled={testing || !to.includes("@")}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-white/5 border border-white/15 text-neutral-200 hover:border-white/30 transition-all disabled:opacity-40">
              {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <MailCheck className="w-3.5 h-3.5" />}
              Send test
            </button>
          </div>
          {testResult && <p className="text-[11px] text-neutral-300 leading-relaxed">{testResult}</p>}
        </div>
      )}
    </div>
  );
}

const TIER_STYLE: Record<string, string> = {
  "Ready+": "bg-purple-500/15 text-purple-300 border-purple-400/30",
  "Ready":  "bg-green-500/15 text-green-400 border-green-500/25",
  "Warm":   "bg-yellow-500/10 text-yellow-400 border-yellow-500/25",
  "Cold":   "bg-white/5 text-neutral-400 border-white/15",
};

const NO_CITY = "No location on file";
// Pinned to the top of the grouping below.
const HOME_CITY = "San Francisco";

// The creator signup form stores its dropdown as a slug -- "san-francisco",
// "los-angeles", "new-york" -- and whatever was typed into its Other field,
// "Ludhiana", in whatever casing. The business form stores proper names for the
// same places. All of it has to collapse into one group per city, so the key is
// normalised and the label is rebuilt from the key rather than from the raw
// value, which would otherwise show a slug on screen.
const CITY_LABELS: Record<string, string> = {
  "san francisco": "San Francisco",
  "los angeles": "Los Angeles",
  "new york": "New York City",
  "new york city": "New York City",
};

const cityKey = (c: string) =>
  (c || "").trim().toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ");

const cityLabel = (c: string) => {
  const k = cityKey(c);
  if (!k) return NO_CITY;
  // Unicode-aware, so a non-ASCII city name is not left lowercased.
  return CITY_LABELS[k] ?? k.replace(/(^|\s)\p{L}/gu, m => m.toUpperCase());
};

// The number the email will state, typed rather than counted: a Feature can be
// published moments after the send, so the admin is the one who knows what the
// drop actually is. Returns null when cancelled or unusable, which is also how
// the send is called off -- there is no separate confirm.
function askFeatureCount(recipients: number, preview: boolean): number | null {
  const what = preview
    ? `Preview the drop for ${recipients} selected creator${recipients === 1 ? "" : "s"}.`
    : `Send the drop to ${recipients} selected creator${recipients === 1 ? "" : "s"}. This is real email and cannot be recalled.`;
  const raw = window.prompt(`How many features are in this drop?\n\nThis is the number the email will say.\n\n${what}`, "");
  if (raw === null) return null;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 0 || n > 999) {
    window.alert("Enter a whole number of features, 0 to 999.");
    return null;
  }
  return n;
}

const fmt = (d: string | null) =>
  d ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—";

// The two answers to "How should we reach you?" on the confirm screen. Both
// slots are always drawn rather than listing only what is on, so a creator
// reachable by DM alone reads differently from one who answered nothing -- and
// neither channel on is called out, because that creator is unreachable and no
// Feature offer will ever land.
function ReachChips({ email, dm }: { email: boolean; dm: boolean }) {
  const slots: [string, boolean, string][] = [
    ["Email", email, "Email notifications"],
    ["DM", dm, "Instagram DM notifications"],
  ];
  return (
    <span className="flex items-center gap-1">
      {slots.map(([label, on, title]) => (
        <span key={label} title={`${title}: ${on ? "on" : "off"}`}
          className={`px-1.5 py-0.5 rounded text-[10px] border ${
            on ? "bg-green-500/15 border-green-500/30 text-green-300"
               : "bg-white/[0.03] border-white/10 text-neutral-600"
          }`}>{label}</span>
      ))}
      {!email && !dm && (
        <AlertTriangle className="w-3 h-3 text-red-400 shrink-0" aria-label="No way to reach this creator" />
      )}
    </span>
  );
}

export function CreatorReadiness({ data, onSend, onSendFeatureDrop, onTestFeatureDrop, onRemindExpiring, busy, health, onTest, testing, testResult }: {
  data: ReadinessData;
  onSend: (creatorIds: string[], reminderOnly: boolean, dryRun: boolean) => void;
  onSendFeatureDrop: (creatorIds: string[], dryRun: boolean, featureCount: number) => void;
  onTestFeatureDrop: (to: string, featureCount: number) => void;
  onRemindExpiring: (dryRun: boolean) => void;
  busy: boolean;
  health: EmailHealth | null;
  onTest: (to: string) => void;
  testing: boolean;
  testResult: string;
}) {
  const [tier, setTier] = useState("");
  const [status, setStatus] = useState("");
  const [amb, setAmb] = useState("");
  const [days, setDays] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const rows = useMemo(() => data.creators.filter(c => {
    if (tier && c.tier !== tier) return false;
    if (status && c.status !== status) return false;
    if (amb === "on" && !c.ambassadorOptedIn) return false;
    if (amb === "off" && c.ambassadorOptedIn) return false;
    if (days) {
      if (!c.confirmedAt) return false;
      const ageDays = (Date.now() - new Date(c.confirmedAt).getTime()) / 864e5;
      if (ageDays > Number(days)) return false;
    }
    return true;
  }), [data.creators, tier, status, amb, days]);

  // Grouped off `rows`, not `data.creators`, so the groups reflect the filters
  // rather than the whole table. A creator with no city signed up before the
  // field existed or skipped it, and is grouped rather than hidden.
  const groups = useMemo(() => {
    const by = new Map<string, ReadinessCreator[]>();
    for (const r of rows) {
      // Keyed on the normalised city so "san-francisco" and "San Francisco"
      // are one group, then labelled once at render.
      const key = cityLabel(r.city);
      const list = by.get(key);
      list ? list.push(r) : by.set(key, [r]);
    }
    // San Francisco first because it is the market being run, then alphabetical,
    // with the unknowns last however they sort. The Creators tab already pins SF
    // the same way, so the two screens agree on what the first group is.
    const rank = (c: string) => c === HOME_CITY ? 0 : c === NO_CITY ? 2 : 1;
    return [...by.entries()].sort(([a], [b]) =>
      rank(a) - rank(b) || a.localeCompare(b));
  }, [rows]);

  const allShown = rows.length > 0 && rows.every(r => selected.has(r.id));
  const toggleAll = () =>
    setSelected(allShown ? new Set() : new Set(rows.map(r => r.id)));
  const toggle = (id: string) =>
    setSelected(prev => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  // Exports what is on screen, not the whole table: the filters are the point.
  const exportCsv = () => {
    const cols = ["handle", "email", "city", "tier", "status", "sentAt", "openedAt", "confirmedAt",
                  "notifyEmail", "notifyDm", "notifySms",
                  "neighborhoods", "capacity", "ambassadorOptedIn", "payoutsConnected", "bounced"];
    const cell = (v: any) => {
      const s = Array.isArray(v) ? v.join("; ") : v === null || v === undefined ? "" : String(v);
      // Quote always, and double any embedded quote. A neighborhood list with a
      // comma would otherwise split into extra columns.
      return `"${s.replace(/"/g, '""')}"`;
    };
    const csv = [cols.join(","), ...rows.map(r => cols.map(c => cell((r as any)[c])).join(","))].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `contynt-readiness-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const ids = [...selected];
  // Dry run stays available whatever the configuration -- it sends nothing and
  // rendering the links is exactly how you check them before Postmark is live.
  const canSend = !health || (health.config.serverToken && health.ok);
  const sendBlocked = canSend ? undefined : "Email is not configured, so this would send nothing.";
  const funnel: [string, number][] = [
    ["Sent", data.funnel.sent], ["Delivered", data.funnel.delivered],
    ["Link opened", data.funnel.linkOpened], ["Confirmed", data.funnel.confirmed],
    ["Ambassador", data.funnel.ambassadorOptedIn], ["Bounced", data.funnel.bounced],
  ];

  const SELECT = "bg-white/5 border border-white/15 rounded-lg px-2 py-1.5 text-xs text-neutral-200 focus:outline-none focus:ring-1 focus:ring-white/30";

  return (
    <div className="space-y-5">
      <EmailHealthPanel health={health} onTest={onTest} testing={testing} testResult={testResult} />

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {funnel.map(([label, n]) => (
          <div key={label} className="bg-white/5 border border-white/10 rounded-2xl p-4">
            <p className="text-[11px] text-neutral-400 leading-tight mb-1">{label}</p>
            <p className={`text-xl font-bold ${label === "Bounced" && n > 0 ? "text-red-400" : "text-white"}`}>{n}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select value={tier} onChange={e => setTier(e.target.value)} className={SELECT}>
          <option value="">All tiers</option>
          {["Ready+", "Ready", "Warm", "Cold"].map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <select value={status} onChange={e => setStatus(e.target.value)} className={SELECT}>
          <option value="">All statuses</option>
          {["pending", "opened", "confirmed", "expired"].map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={amb} onChange={e => setAmb(e.target.value)} className={SELECT}>
          <option value="">Ambassador: any</option>
          <option value="on">Ambassador: on</option>
          <option value="off">Ambassador: off</option>
        </select>
        <select value={days} onChange={e => setDays(e.target.value)} className={SELECT}>
          <option value="">Confirmed: any time</option>
          {[7, 14, 30, 90].map(d => <option key={d} value={d}>Confirmed within {d}d</option>)}
        </select>
        <span className="text-xs text-neutral-500 ml-auto">{rows.length} shown</span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => onSend(ids, false, true)} disabled={busy || !ids.length}
          className="flex items-center gap-1.5 px-3 py-2 text-xs rounded-xl bg-white/5 border border-white/15 text-neutral-200 hover:border-white/30 transition-all disabled:opacity-40">
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
          Dry run ({ids.length})
        </button>
        <button onClick={() => onSend(ids, false, false)} disabled={busy || !ids.length || !canSend} title={sendBlocked}
          className="flex items-center gap-1.5 px-3 py-2 text-xs rounded-xl bg-white text-neutral-900 font-semibold hover:bg-neutral-100 transition-all disabled:opacity-40">
          <Send className="w-3.5 h-3.5" />Send verification email
        </button>
        <button onClick={() => onSend(ids, true, false)} disabled={busy || !ids.length || !canSend} title={sendBlocked}
          className="flex items-center gap-1.5 px-3 py-2 text-xs rounded-xl bg-white/5 border border-white/15 text-neutral-200 hover:border-white/30 transition-all disabled:opacity-40">
          <Send className="w-3.5 h-3.5" />Remind non-confirmers
        </button>
        {/* Preview first, then send. Both ask for the number, because a preview
            of a different email than the one that sends is worth nothing.
            Cancelling the prompt is the way out -- it is the confirm step too,
            since this is the one button here that mails people already on board
            and cannot be recalled. */}
        {/* Proves the whole path -- template, Postmark, stream, signature -- on
            one address, before it is pointed at creators. Needs no selection,
            because it mails nobody on the list. */}
        <button
          onClick={() => {
            const to = window.prompt("Send a test drop to which address?\n\nThe real email, to you only. No creator is touched.", "");
            if (to === null || !to.trim()) return;
            const n = askFeatureCount(1, true);
            if (n !== null) onTestFeatureDrop(to.trim(), n);
          }}
          disabled={busy || !canSend} title={sendBlocked}
          className="flex items-center gap-1.5 px-3 py-2 text-xs rounded-xl bg-white/5 border border-white/15 text-neutral-200 hover:border-white/30 transition-all disabled:opacity-40">
          <Megaphone className="w-3.5 h-3.5" />Test drop on me
        </button>
        <button onClick={() => { const n = askFeatureCount(ids.length, true); if (n !== null) onSendFeatureDrop(ids, true, n); }}
          disabled={busy || !ids.length}
          title="Show what would go out, without sending"
          className="flex items-center gap-1.5 px-3 py-2 text-xs rounded-xl bg-white/5 border border-white/15 text-neutral-200 hover:border-white/30 transition-all disabled:opacity-40">
          <Megaphone className="w-3.5 h-3.5" />Preview drop ({ids.length})
        </button>
        <button onClick={() => { const n = askFeatureCount(ids.length, false); if (n !== null) onSendFeatureDrop(ids, false, n); }}
          disabled={busy || !ids.length || !canSend} title={sendBlocked}
          className="flex items-center gap-1.5 px-3 py-2 text-xs rounded-xl bg-purple-500 text-white font-semibold hover:bg-purple-400 transition-all disabled:opacity-40">
          <Megaphone className="w-3.5 h-3.5" />Send feature drop
        </button>

        {/* Nothing in this project schedules anything, so a deadline only gets
            chased when somebody runs this. Idempotent, so running it twice in a
            day costs nothing. */}
        <button onClick={() => onRemindExpiring(true)} disabled={busy}
          title="Show who is close to a deadline, without emailing them"
          className="flex items-center gap-1.5 px-3 py-2 text-xs rounded-xl bg-white/5 border border-white/15 text-neutral-200 hover:border-white/30 transition-all disabled:opacity-40">
          <Clock className="w-3.5 h-3.5" />Preview expiry reminders
        </button>
        <button onClick={() => onRemindExpiring(false)} disabled={busy || !canSend} title={sendBlocked}
          className="flex items-center gap-1.5 px-3 py-2 text-xs rounded-xl bg-white/5 border border-white/15 text-neutral-200 hover:border-white/30 transition-all disabled:opacity-40">
          <Clock className="w-3.5 h-3.5" />Send expiry reminders
        </button>

        <button onClick={exportCsv} disabled={!rows.length}
          className="flex items-center gap-1.5 px-3 py-2 text-xs rounded-xl bg-white/5 border border-white/15 text-neutral-200 hover:border-white/30 transition-all disabled:opacity-40 ml-auto">
          <Download className="w-3.5 h-3.5" />Export CSV
        </button>
      </div>

      <div className="overflow-x-auto border border-white/10 rounded-2xl">
        <table className="w-full text-xs whitespace-nowrap">
          <thead className="bg-white/5 text-neutral-400">
            <tr>
              <th className="px-3 py-2.5 text-left">
                <input type="checkbox" checked={allShown} onChange={toggleAll} aria-label="Select all shown" />
              </th>
              {["Handle", "Email", "Tier", "Status", "Sent", "Opened", "Confirmed", "Reach", "Amb"].map(h => (
                <th key={h} className="px-3 py-2.5 text-left font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map(([city, members]) => (
              <Fragment key={city}>
                <tr className="border-t border-white/10 bg-white/[0.04]">
                  <td colSpan={10} className="px-3 py-2">
                    <span className="text-[10px] font-semibold uppercase tracking-widest text-neutral-400">
                      {city}
                    </span>
                    <span className="ml-2 text-[10px] text-neutral-600">{members.length}</span>
                  </td>
                </tr>
                {members.map(r => (
              <tr key={r.id} className="border-t border-white/5 hover:bg-white/[0.03]">
                <td className="px-3 py-2.5">
                  <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)}
                    aria-label={`Select ${r.handle}`} />
                </td>
                <td className="px-3 py-2.5">
                  <span className="text-white">@{r.handle || "—"}</span>
                  {r.bounced && <span className="ml-1.5 text-[10px] text-red-400">bounced</span>}
                </td>
                <td className="px-3 py-2.5 text-neutral-400 max-w-[220px] truncate" title={r.email}>
                  {r.email || "—"}
                </td>
                <td className="px-3 py-2.5">
                  <span className={`px-2 py-0.5 rounded-full border text-[10px] ${TIER_STYLE[r.tier]}`}>{r.tier}</span>
                </td>
                <td className="px-3 py-2.5 text-neutral-400">{r.status}</td>
                <td className="px-3 py-2.5 text-neutral-400">{fmt(r.sentAt)}</td>
                <td className="px-3 py-2.5 text-neutral-400">
                  {fmt(r.openedAt)}{r.openCount > 1 && <span className="text-neutral-600"> ×{r.openCount}</span>}
                </td>
                <td className="px-3 py-2.5 text-neutral-400">{fmt(r.confirmedAt)}</td>
                <td className="px-3 py-2.5">
                  <ReachChips email={r.notifyEmail} dm={r.notifyDm} />
                </td>
                <td className="px-3 py-2.5">
                  {r.ambassadorOptedIn
                    ? <Check className="w-3.5 h-3.5 text-purple-300" />
                    : <X className="w-3.5 h-3.5 text-neutral-700" />}
                </td>
              </tr>
                ))}
              </Fragment>
            ))}
            {!rows.length && (
              <tr><td colSpan={10} className="px-3 py-8 text-center text-neutral-500">No creators match these filters.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
