import { useMemo, useState } from "react";
import { Download, Send, Loader2, Check, X } from "lucide-react";

export interface ReadinessCreator {
  id: string; handle: string; email: string;
  tier: "Ready+" | "Ready" | "Warm" | "Cold";
  status: string;
  sentAt: string | null; openedAt: string | null; openCount: number; confirmedAt: string | null;
  neighborhoods: string[]; capacity: number | null;
  notifyEmail: boolean; notifySms: boolean;
  ambassadorOptedIn: boolean; payoutsConnected: boolean;
  delivered: boolean; bounced: boolean;
}

export interface ReadinessData {
  funnel: { sent: number; delivered: number; linkOpened: number; confirmed: number; ambassadorOptedIn: number; bounced: number };
  neighborhoods: string[];
  creators: ReadinessCreator[];
}

const TIER_STYLE: Record<string, string> = {
  "Ready+": "bg-purple-500/15 text-purple-300 border-purple-400/30",
  "Ready":  "bg-green-500/15 text-green-400 border-green-500/25",
  "Warm":   "bg-yellow-500/10 text-yellow-400 border-yellow-500/25",
  "Cold":   "bg-white/5 text-neutral-400 border-white/15",
};

const fmt = (d: string | null) =>
  d ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—";

export function CreatorReadiness({ data, onSend, busy }: {
  data: ReadinessData;
  onSend: (creatorIds: string[], reminderOnly: boolean, dryRun: boolean) => void;
  busy: boolean;
}) {
  const [tier, setTier] = useState("");
  const [status, setStatus] = useState("");
  const [hood, setHood] = useState("");
  const [amb, setAmb] = useState("");
  const [days, setDays] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const rows = useMemo(() => data.creators.filter(c => {
    if (tier && c.tier !== tier) return false;
    if (status && c.status !== status) return false;
    if (hood && !c.neighborhoods.includes(hood)) return false;
    if (amb === "on" && !c.ambassadorOptedIn) return false;
    if (amb === "off" && c.ambassadorOptedIn) return false;
    if (days) {
      if (!c.confirmedAt) return false;
      const ageDays = (Date.now() - new Date(c.confirmedAt).getTime()) / 864e5;
      if (ageDays > Number(days)) return false;
    }
    return true;
  }), [data.creators, tier, status, hood, amb, days]);

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
    const cols = ["handle", "email", "tier", "status", "sentAt", "openedAt", "confirmedAt",
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
  const funnel: [string, number][] = [
    ["Sent", data.funnel.sent], ["Delivered", data.funnel.delivered],
    ["Link opened", data.funnel.linkOpened], ["Confirmed", data.funnel.confirmed],
    ["Ambassador", data.funnel.ambassadorOptedIn], ["Bounced", data.funnel.bounced],
  ];

  const SELECT = "bg-white/5 border border-white/15 rounded-lg px-2 py-1.5 text-xs text-neutral-200 focus:outline-none focus:ring-1 focus:ring-white/30";

  return (
    <div className="space-y-5">
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
        <select value={hood} onChange={e => setHood(e.target.value)} className={SELECT}>
          <option value="">All neighborhoods</option>
          {data.neighborhoods.map(n => <option key={n} value={n}>{n}</option>)}
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
        <button onClick={() => onSend(ids, false, false)} disabled={busy || !ids.length}
          className="flex items-center gap-1.5 px-3 py-2 text-xs rounded-xl bg-white text-neutral-900 font-semibold hover:bg-neutral-100 transition-all disabled:opacity-40">
          <Send className="w-3.5 h-3.5" />Send verification email
        </button>
        <button onClick={() => onSend(ids, true, false)} disabled={busy || !ids.length}
          className="flex items-center gap-1.5 px-3 py-2 text-xs rounded-xl bg-white/5 border border-white/15 text-neutral-200 hover:border-white/30 transition-all disabled:opacity-40">
          <Send className="w-3.5 h-3.5" />Remind non-confirmers
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
              {["Handle", "Tier", "Status", "Sent", "Opened", "Confirmed", "Neighborhoods", "Cap", "Amb", "Payouts"].map(h => (
                <th key={h} className="px-3 py-2.5 text-left font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id} className="border-t border-white/5 hover:bg-white/[0.03]">
                <td className="px-3 py-2.5">
                  <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)}
                    aria-label={`Select ${r.handle}`} />
                </td>
                <td className="px-3 py-2.5">
                  <span className="text-white">@{r.handle || "—"}</span>
                  {r.bounced && <span className="ml-1.5 text-[10px] text-red-400">bounced</span>}
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
                <td className="px-3 py-2.5 text-neutral-400 max-w-[220px] truncate"
                    title={r.neighborhoods.join(", ")}>
                  {r.neighborhoods.length ? r.neighborhoods.join(", ") : "—"}
                </td>
                <td className="px-3 py-2.5 text-neutral-400">{r.capacity ?? "—"}</td>
                <td className="px-3 py-2.5">
                  {r.ambassadorOptedIn
                    ? <Check className="w-3.5 h-3.5 text-purple-300" />
                    : <X className="w-3.5 h-3.5 text-neutral-700" />}
                </td>
                <td className="px-3 py-2.5">
                  {r.payoutsConnected
                    ? <Check className="w-3.5 h-3.5 text-green-400" />
                    : <X className="w-3.5 h-3.5 text-neutral-700" />}
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr><td colSpan={11} className="px-3 py-8 text-center text-neutral-500">No creators match these filters.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
