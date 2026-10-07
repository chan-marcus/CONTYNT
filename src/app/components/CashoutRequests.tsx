import { Banknote } from "lucide-react";

// Everything about money owed to creators, in the order it needs attention.
//
// Two of these sections used to sit at the top of the Creators tab, and only
// when they had rows -- so with nothing pending the screen said nothing, and
// the question "has this creator asked to be paid yet?" had no place to be
// answered. You had to read a balance on a creator row and infer it.
//
// So the tab is the whole lifecycle rather than the queue: what has gone
// wrong, what is waiting on you, what is owed but unasked for, and what is
// settled. A creator sitting on an available balance having never requested it
// is a normal state, and it is now a visible one.

export interface PayoutRequest {
  id: string;
  creatorToken: string;
  creatorId: string;
  creatorInstagram: string;
  amount: number;
  method: string;
  handle: string;
  status: string;
  requestedAt: string;
  paidAt: string | null;
  notReceivedAt: string | null;
  notReceivedNote: string;
  issueResolvedAt: string | null;
  issueResolution: string;
}

export interface OwedCreator {
  id: string;
  instagram: string;
  availableEarnings: number;
  pendingEarnings: number;
}

const money = (n: number) => `$${(n ?? 0).toFixed(2).replace(/\.00$/, "")}`;
const day = (d: string) => new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });

function Section({ tone, title, count, children }: {
  tone: "red" | "yellow" | "neutral" | "green";
  title: string; count: number; children: React.ReactNode;
}) {
  const colour = { red: "text-red-400", yellow: "text-yellow-400", neutral: "text-neutral-500", green: "text-green-400" }[tone];
  return (
    <div className="space-y-2">
      <p className={`text-xs font-semibold uppercase tracking-wider ${colour}`}>{title} · {count}</p>
      {children}
    </div>
  );
}

export function CashoutRequests({ requests, owed, onSettle, onResolve, settling }: {
  requests: PayoutRequest[];
  owed: OwedCreator[];
  onSettle: (r: PayoutRequest) => void;
  onResolve: (r: PayoutRequest) => void;
  settling: string | null;
}) {
  // Money the app says it sent that never arrived. First, because it is the
  // only one of these where something has already gone wrong.
  const broken = requests.filter(r => r.notReceivedAt && !r.issueResolvedAt);
  const pending = requests.filter(r => r.status === "requested");
  const settled = requests.filter(r => r.paidAt && !(r.notReceivedAt && !r.issueResolvedAt));
  const owedNow = owed.filter(c => c.availableEarnings > 0);

  const owedTotal = owedNow.reduce((s, c) => s + c.availableEarnings, 0);
  const pendingTotal = pending.reduce((s, r) => s + r.amount, 0);

  const empty = !broken.length && !pending.length && !settled.length && !owedNow.length;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Banknote className="w-5 h-5 text-green-300" />
        <h2 className="text-lg font-semibold text-white">Cash Outs</h2>
      </div>

      {/* The two numbers worth knowing before reading anything: what you owe
          and have been asked for, and what you owe and have not. */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "Awaiting payment", value: money(pendingTotal), tone: "text-yellow-300" },
          { label: "Owed, not requested", value: money(owedTotal), tone: "text-neutral-200" },
          { label: "Open requests", value: String(pending.length), tone: "text-neutral-200" },
          { label: "Reported missing", value: String(broken.length), tone: broken.length ? "text-red-300" : "text-neutral-200" },
        ].map(s => (
          <div key={s.label} className="bg-white/5 border border-white/10 rounded-xl p-3">
            <p className="text-[11px] text-neutral-500 leading-tight">{s.label}</p>
            <p className={`text-xl font-bold mt-1 ${s.tone}`}>{s.value}</p>
          </div>
        ))}
      </div>

      {empty && (
        <p className="text-neutral-400 text-sm bg-white/5 border border-white/10 rounded-xl px-4 py-3">
          No creator has earned anything yet, so there is nothing to pay out.
        </p>
      )}

      {broken.length > 0 && (
        <Section tone="red" title="Reported not received" count={broken.length}>
          {broken.map(r => (
            <div key={r.id} className="bg-red-500/5 border border-red-500/30 rounded-xl px-4 py-3 space-y-2">
              <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-white">
                    @{r.creatorInstagram.replace(/^@+/, "")}
                    <span className="ml-2 text-red-300">{money(r.amount)}</span>
                  </p>
                  <p className="text-xs text-neutral-400 mt-0.5">
                    Sent {r.method} to <span className="font-mono text-neutral-300">{r.handle}</span>
                    {r.paidAt && <span className="text-neutral-600"> · marked sent {day(r.paidAt)}</span>}
                  </p>
                  <p className="text-xs text-red-300/80 mt-0.5">Reported {day(r.notReceivedAt!)}</p>
                </div>
                <button onClick={() => onResolve(r)} disabled={settling === r.id}
                  className="shrink-0 px-3 py-1.5 text-xs bg-white/10 text-neutral-200 rounded-lg hover:bg-white/20 transition-all disabled:opacity-50 whitespace-nowrap">
                  {settling === r.id ? "Closing…" : "Close report"}
                </button>
              </div>
              {r.notReceivedNote && (
                <p className="text-xs text-neutral-300 bg-black/30 border border-white/10 rounded-lg px-3 py-2 whitespace-pre-wrap break-words">
                  {r.notReceivedNote}
                </p>
              )}
            </div>
          ))}
        </Section>
      )}

      {pending.length > 0 && (
        <Section tone="yellow" title="Requested, awaiting payment" count={pending.length}>
          {pending.map(r => (
            <div key={r.id} className="bg-yellow-500/5 border border-yellow-500/25 rounded-xl px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3">
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-white">
                  @{r.creatorInstagram.replace(/^@+/, "")}
                  <span className="ml-2 text-green-400">{money(r.amount)}</span>
                </p>
                <p className="text-xs text-neutral-400 mt-0.5">
                  {r.method} · <span className="font-mono text-neutral-300">{r.handle}</span>
                  <span className="text-neutral-600"> · asked {day(r.requestedAt)}</span>
                </p>
              </div>
              <button onClick={() => onSettle(r)} disabled={settling === r.id}
                className="shrink-0 px-3 py-1.5 text-xs bg-green-600 text-white rounded-lg hover:bg-green-500 transition-all disabled:opacity-50 whitespace-nowrap">
                {settling === r.id ? "Settling…" : "Mark as Sent"}
              </button>
            </div>
          ))}
        </Section>
      )}

      {/* The question this tab was built to answer without being asked. A
          balance sitting here is not a problem -- a creator cashes out when
          they feel like it -- but it is the difference between "they have not
          asked" and "we have not paid", which a balance on a creator row does
          not distinguish. */}
      {owedNow.length > 0 && (
        <Section tone="neutral" title="Owed, no request yet" count={owedNow.length}>
          {owedNow.map(c => (
            <div key={c.id} className="bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 flex items-center gap-3">
              <p className="flex-1 min-w-0 font-semibold text-white truncate">
                @{c.instagram.replace(/^@+/, "")}
              </p>
              {c.pendingEarnings > 0 && (
                <span className="text-xs text-yellow-400/80 shrink-0">{money(c.pendingEarnings)} pending</span>
              )}
              <span className="text-sm font-semibold text-neutral-200 shrink-0">{money(c.availableEarnings)}</span>
              <span className="text-[11px] text-neutral-600 shrink-0 hidden sm:inline">not requested</span>
            </div>
          ))}
        </Section>
      )}

      {settled.length > 0 && (
        <Section tone="green" title="Paid" count={settled.length}>
          {settled.map(r => (
            <div key={r.id} className="bg-white/[0.03] border border-white/10 rounded-xl px-4 py-2.5 flex items-center gap-3">
              <p className="flex-1 min-w-0 text-neutral-300 truncate">
                @{r.creatorInstagram.replace(/^@+/, "")}
              </p>
              <span className="text-xs text-neutral-500 shrink-0 hidden sm:inline">
                {r.method} · {r.handle}
              </span>
              <span className="text-sm font-semibold text-green-400/90 shrink-0">{money(r.amount)}</span>
              <span className="text-[11px] text-neutral-600 shrink-0">{r.paidAt ? day(r.paidAt) : ""}</span>
            </div>
          ))}
        </Section>
      )}
    </div>
  );
}
