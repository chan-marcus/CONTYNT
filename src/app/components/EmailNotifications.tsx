import { useState, useEffect, useMemo } from "react";
import { Mail, Megaphone, Send, AlertTriangle } from "lucide-react";
import type { ReadinessCreator, EmailHealth } from "./CreatorReadiness";

// Everything that mails a creator on purpose, in one place.
//
// These controls used to live along the bottom of the Readiness tab, where nine
// buttons sat in a row and the only way to choose who got a message was to tick
// creators in a table by hand. That worked while there was one message and a
// dozen creators. It does not describe what an operator is actually doing,
// which is picking an audience and picking a message.
//
// So the tab is those two choices and nothing else: a segment on the left, a
// message on the right, and the same three actions every send here supports.
// Adding the next notification means adding a template and one row to MESSAGES,
// not another trio of buttons somewhere.

export interface EmailMessage {
  key: string;
  name: string;
  what: string;
  // Broadcast goes on the bulk stream and carries an unsubscribe link, so it
  // honours a creator's email preference. Transactional does not.
  kind: "broadcast" | "transactional";
}

export const MESSAGES: EmailMessage[] = [
  {
    key: "verification",
    name: "Approval and confirm",
    what: "Tells a creator they are approved and asks them to confirm their account. Also the chase email for anyone who has not.",
    kind: "transactional",
  },
  {
    key: "drop",
    name: "New features dropped",
    what: "Announces that features are open and sends them to their portal. Says how many, which you type before sending.",
    kind: "broadcast",
  },
  {
    key: "window",
    name: "Longer submit window",
    what: "One-off: the window to film and submit a Reel is longer now. Skips anyone who has already had it.",
    kind: "broadcast",
  },
];

type SegmentKey = "everyone" | "confirmed" | "unconfirmed" | "active" | "ambassadors";

const SEGMENTS: { key: SegmentKey; name: string; what: string }[] = [
  { key: "everyone", name: "Everyone", what: "Every creator who has signed up." },
  { key: "confirmed", name: "Confirmed", what: "Finished their profile. The ones who can claim a feature." },
  { key: "active", name: "Active", what: "Has requested at least one feature. Signed up and actually using it." },
  { key: "unconfirmed", name: "Not confirmed", what: "Signed up and never finished. The chase list." },
  { key: "ambassadors", name: "Ambassadors", what: "Opted in to refer businesses." },
];

// Handles are stored with and without a leading @, and cased however the
// creator typed them, so activity is matched on a normalised key.
const igKey = (raw: string) => String(raw ?? "").replace(/^@+/, "").trim().toLowerCase();

// Why a send would skip somebody, decided here so the count on the button is
// the number that will actually be mailed rather than the size of the segment.
// It mirrors the batch's own guards; a creator failing any of them is told
// which one in the table below.
function blockedReason(c: ReadinessCreator, kind: EmailMessage["kind"]): string | null {
  if (!c.email) return "no email";
  if (c.bounced) return "bounced";
  if (kind === "broadcast" && !c.notifyEmail) return "email off";
  return null;
}

export function EmailNotifications({
  creators, activeHandles, health, busy, result,
  onSendVerification, onSendDrop, onTestDrop, onSendWindow, onTestWindow, loadHistory,
}: {
  creators: ReadinessCreator[];
  activeHandles: Set<string>;
  health: EmailHealth | null;
  busy: boolean;
  result: string;
  onSendVerification: (ids: string[], reminderOnly: boolean, dryRun: boolean) => void;
  onSendDrop: (ids: string[], dryRun: boolean, featureCount: number) => void;
  onTestDrop: (to: string, featureCount: number) => void;
  onSendWindow: (ids: string[], dryRun: boolean) => void;
  onTestWindow: (to: string) => void;
  loadHistory: () => Promise<{ type: string; at: string; handle: string; reminder: boolean }[] | null>;
}) {
  const [segment, setSegment] = useState<SegmentKey>("confirmed");
  const [message, setMessage] = useState<string>("drop");
  const [history, setHistory] = useState<{ type: string; at: string; handle: string; reminder: boolean }[] | null>(null);

  const msg = MESSAGES.find(m => m.key === message)!;

  const inSegment = useMemo(() => creators.filter(c => {
    switch (segment) {
      case "everyone": return true;
      case "confirmed": return c.status === "confirmed";
      case "unconfirmed": return c.status !== "confirmed";
      case "active": return activeHandles.has(igKey(c.handle));
      case "ambassadors": return c.ambassadorOptedIn;
    }
  }), [creators, segment, activeHandles]);

  const reachable = inSegment.filter(c => !blockedReason(c, msg.kind));
  const blocked = inSegment.filter(c => blockedReason(c, msg.kind));
  const ids = reachable.map(c => c.id);

  const countFor = (k: SegmentKey) => creators.filter(c => {
    switch (k) {
      case "everyone": return true;
      case "confirmed": return c.status === "confirmed";
      case "unconfirmed": return c.status !== "confirmed";
      case "active": return activeHandles.has(igKey(c.handle));
      case "ambassadors": return c.ambassadorOptedIn;
    }
  }).length;

  // Asked once, for the message that needs it, rather than on every send.
  const askFeatureCount = () => {
    const raw = window.prompt(`How many features should the email say are open?`, String(1));
    if (raw === null) return null;
    const n = Number(raw.trim());
    return Number.isInteger(n) && n >= 0 ? n : null;
  };

  const canSend = !!health?.ok;
  const blockedTitle = canSend ? "" : (health?.problem || "Email is not configured, so nothing can be sent.");

  const send = (dryRun: boolean) => {
    if (msg.key === "verification") {
      if (!dryRun && !window.confirm(`Email ${ids.length} creator${ids.length === 1 ? "" : "s"} the approval and confirm message?`)) return;
      onSendVerification(ids, segment === "unconfirmed", dryRun);
      return;
    }
    if (msg.key === "drop") {
      const n = askFeatureCount();
      if (n === null) return;
      if (!dryRun && !window.confirm(`Email ${ids.length} creator${ids.length === 1 ? "" : "s"} to say ${n} feature${n === 1 ? " is" : "s are"} open?`)) return;
      onSendDrop(ids, dryRun, n);
      return;
    }
    if (!dryRun && !window.confirm(`Email ${ids.length} creator${ids.length === 1 ? "" : "s"} about the longer submit window?\n\nAnyone who has already had it is skipped.`)) return;
    onSendWindow(ids, dryRun);
  };

  const test = () => {
    const to = window.prompt("Send this message to which address?\n\nThe real email, to you only. No creator is touched.", "");
    if (to === null || !to.trim()) return;
    if (msg.key === "drop") { const n = askFeatureCount(); if (n !== null) onTestDrop(to.trim(), n); return; }
    if (msg.key === "window") { onTestWindow(to.trim()); return; }
    window.alert("The approval email has no test send. Preview it against one creator instead.");
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <Mail className="w-5 h-5 text-blue-300" />
        <h2 className="text-lg font-semibold text-white">Email Notifications</h2>
      </div>

      {!canSend && (
        <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/25 rounded-xl px-4 py-3">
          <AlertTriangle className="w-4 h-4 text-red-300 shrink-0 mt-0.5" />
          <p className="text-xs text-red-200">{blockedTitle} Sending is disabled until this is fixed. The Readiness tab has the details.</p>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* ── Who ── */}
        <div className="bg-white/5 border border-white/10 rounded-2xl p-4 space-y-3">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-neutral-500">Who it goes to</p>
          <div className="space-y-1.5">
            {SEGMENTS.map(s => (
              <button key={s.key} onClick={() => setSegment(s.key)}
                className={`w-full text-left px-3 py-2 rounded-xl border transition-all ${
                  segment === s.key
                    ? "bg-blue-500/15 border-blue-500/40"
                    : "bg-white/[0.03] border-white/10 hover:border-white/25"}`}>
                <span className="flex items-center justify-between gap-3">
                  <span className={`text-sm font-medium ${segment === s.key ? "text-blue-200" : "text-neutral-200"}`}>{s.name}</span>
                  <span className="text-xs text-neutral-500 tabular-nums shrink-0">{countFor(s.key)}</span>
                </span>
                <span className="block text-[11px] text-neutral-500 mt-0.5">{s.what}</span>
              </button>
            ))}
          </div>
        </div>

        {/* ── What ── */}
        <div className="bg-white/5 border border-white/10 rounded-2xl p-4 space-y-3">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-neutral-500">What they get</p>
          <div className="space-y-1.5">
            {MESSAGES.map(m => (
              <button key={m.key} onClick={() => setMessage(m.key)}
                className={`w-full text-left px-3 py-2 rounded-xl border transition-all ${
                  message === m.key
                    ? "bg-purple-500/15 border-purple-500/40"
                    : "bg-white/[0.03] border-white/10 hover:border-white/25"}`}>
                <span className="flex items-center justify-between gap-3">
                  <span className={`text-sm font-medium ${message === m.key ? "text-purple-200" : "text-neutral-200"}`}>{m.name}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 border ${
                    m.kind === "broadcast"
                      ? "bg-white/5 text-neutral-400 border-white/10"
                      : "bg-blue-500/10 text-blue-300 border-blue-500/25"}`}>{m.kind}</span>
                </span>
                <span className="block text-[11px] text-neutral-500 mt-0.5">{m.what}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── The sentence the two choices make, then the actions ── */}
      <div className="bg-white/5 border border-white/10 rounded-2xl p-4 space-y-3">
        <p className="text-sm text-neutral-300">
          <span className="font-semibold text-white">{reachable.length}</span> of{" "}
          <span className="text-neutral-400">{inSegment.length}</span> in{" "}
          <span className="text-blue-200">{SEGMENTS.find(s => s.key === segment)!.name}</span> will receive{" "}
          <span className="text-purple-200">{msg.name}</span>.
        </p>

        {/* The gap between the two numbers is the part that surprises people, so
            it is itemised rather than left as a subtraction. */}
        {blocked.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {[...new Set(blocked.map(c => blockedReason(c, msg.kind)!))].map(reason => (
              <span key={reason} className="text-[10px] px-2 py-1 rounded-md bg-yellow-500/10 text-yellow-300 border border-yellow-500/25">
                {blocked.filter(c => blockedReason(c, msg.kind) === reason).length} {reason}
              </span>
            ))}
          </div>
        )}

        <div className="flex flex-wrap gap-2 pt-1">
          <button onClick={() => send(true)} disabled={busy || !ids.length}
            title="Show exactly who would receive it, without sending"
            className="flex items-center gap-1.5 px-3 py-2 text-xs rounded-xl bg-white/5 border border-white/15 text-neutral-200 hover:border-white/30 transition-all disabled:opacity-40">
            <Megaphone className="w-3.5 h-3.5" />Preview ({ids.length})
          </button>
          <button onClick={test} disabled={busy || !canSend} title={blockedTitle}
            className="flex items-center gap-1.5 px-3 py-2 text-xs rounded-xl bg-white/5 border border-white/15 text-neutral-200 hover:border-white/30 transition-all disabled:opacity-40">
            <Send className="w-3.5 h-3.5" />Send to me only
          </button>
          <button onClick={() => send(false)} disabled={busy || !ids.length || !canSend} title={blockedTitle}
            className="flex items-center gap-1.5 px-3 py-2 text-xs rounded-xl bg-purple-500 text-white font-semibold hover:bg-purple-400 transition-all disabled:opacity-40">
            <Megaphone className="w-3.5 h-3.5" />{busy ? "Sending…" : `Send to ${ids.length}`}
          </button>
        </div>

        {result && <p className="text-xs text-neutral-300 pt-1">{result}</p>}
      </div>

      {/* ── What has already gone out ── */}
      <EmailHistory history={history} setHistory={setHistory} load={loadHistory} />
    </div>
  );
}

const HISTORY_LABELS: Record<string, string> = {
  verify_email_sent: "Approval and confirm",
  feature_drop_sent: "New features dropped",
  submit_window_notice_sent: "Longer submit window",
};

const ts = (d: string) => new Date(d).toLocaleString("en-US", {
  month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
});

// Read from the creator event log, which every send already writes. A second
// ledger kept by this screen could disagree with what was actually mailed.
type HistoryEvent = { type: string; at: string; handle: string; reminder: boolean };

function EmailHistory({ history, setHistory, load }: {
  history: HistoryEvent[] | null;
  setHistory: (h: HistoryEvent[]) => void;
  load: () => Promise<HistoryEvent[] | null>;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const events = await load();
      if (cancelled) return;
      if (!events) { setFailed(true); return; }
      setHistory(events);
    })();
    return () => { cancelled = true; };
  }, [load, setHistory]);

  return (
    <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-neutral-500 mb-2">Already sent</p>
      {failed ? <p className="text-xs text-neutral-600">Could not load the history.</p>
        : history === null ? <p className="text-xs text-neutral-600">Loading…</p>
        : history.length === 0 ? <p className="text-xs text-neutral-600">Nothing has been sent yet.</p>
        : (
          <div className="flex flex-col divide-y divide-white/5">
            {history.slice(0, 40).map((e, i) => (
              <div key={i} className="flex items-baseline gap-3 py-1.5">
                <span className="text-xs text-neutral-300 flex-1 min-w-0 truncate">
                  {HISTORY_LABELS[e.type] || e.type}
                  {e.reminder && <span className="text-neutral-500"> · reminder</span>}
                </span>
                <span className="text-xs text-neutral-500 shrink-0">@{e.handle || "—"}</span>
                <span className="text-[10px] text-neutral-600 shrink-0 tabular-nums">{ts(e.at)}</span>
              </div>
            ))}
          </div>
        )}
    </div>
  );
}
