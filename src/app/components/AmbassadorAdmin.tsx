import { useState, useMemo } from "react";
import { Award, ExternalLink, Copy, Check } from "lucide-react";

export interface AmbassadorAdminData {
  overview: {
    totalAmbassadors: number; activeAmbassadors: number; totalReferrals: number;
    businessesCreated: number; businessesActivated: number; totalRewardsPaid: number;
  };
  ambassadors: {
    ambassadorId: string; creatorId: string; creatorInstagram: string; creatorEmail: string;
    referralCode: string; referralUrl: string; enabled: boolean; createdAt: string;
    businessesReferred: number; conversionRate: number; rewardsEarned: number;
  }[];
  referrals: {
    id: string; ambassadorId: string; businessName: string; businessEmail: string;
    creatorInstagram: string; referralCode: string; status: string;
    rewardStatus: string; rewardAmount: number; createdAt: string; unrecorded?: boolean;
    subscriptionActiveAt: string | null; firstPaymentAt: string | null;
    retained30dAt: string | null; rewardEarnedAt: string | null; rewardPaidAt: string | null;
  }[];
}

// The stages an admin can record. Onboarding and profile completion are
// informational; payment and retention are what actually unlock the reward.
const STAGES: { key: string; label: string; field: keyof AmbassadorAdminData["referrals"][0] }[] = [
  { key: "subscription_activated", label: "Subscription", field: "subscriptionActiveAt" },
  { key: "first_payment", label: "First payment", field: "firstPaymentAt" },
  { key: "retained_30d", label: "30d retained", field: "retained30dAt" },
];

const money = (n: number) => `$${(n ?? 0).toFixed(2).replace(/\.00$/, "")}`;
const pretty = (s: string) => (s || "").replace(/_/g, " ");

export function AmbassadorAdmin({ data, onAdvance, onPayReward, onToggle, busy }: {
  data: AmbassadorAdminData;
  onAdvance: (referralId: string, stage: string) => void;
  onPayReward: (referralId: string) => void;
  onToggle: (ambassadorId: string, enabled: boolean) => void;
  busy: string | null;
}) {
  const [creatorFilter, setCreatorFilter] = useState("");
  const [rewardFilter, setRewardFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [search, setSearch] = useState("");
  const [copied, setCopied] = useState<string | null>(null);

  const copyLink = (url: string, id: string) => {
    navigator.clipboard.writeText(url);
    setCopied(id); setTimeout(() => setCopied(null), 2000);
  };

  const statuses = useMemo(
    () => [...new Set(data.referrals.map(r => r.status))].sort(),
    [data.referrals]);

  // The referrals list below is filterable and can be scrolled past; the row
  // itself should say who this creator actually brought in without making an
  // admin go looking for it.
  const byAmbassador = useMemo(() => {
    const by: Record<string, AmbassadorAdminData["referrals"]> = {};
    for (const r of data.referrals) (by[r.ambassadorId] ??= []).push(r);
    return by;
  }, [data.referrals]);

  const referrals = useMemo(() => data.referrals.filter(r =>
    (!creatorFilter || r.creatorInstagram === creatorFilter) &&
    (!rewardFilter || r.rewardStatus === rewardFilter) &&
    (!statusFilter || r.status === statusFilter) &&
    (!search || `${r.businessName} ${r.businessEmail}`.toLowerCase().includes(search.toLowerCase()))
  ), [data.referrals, creatorFilter, rewardFilter, statusFilter, search]);

  const o = data.overview;
  const overviewCards = [
    { label: "Total Ambassadors", value: o.totalAmbassadors },
    { label: "Active", value: o.activeAmbassadors },
    { label: "Total Referrals", value: o.totalReferrals },
    { label: "Businesses Created", value: o.businessesCreated },
    { label: "Businesses Activated", value: o.businessesActivated },
    { label: "Rewards Paid", value: money(o.totalRewardsPaid) },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Award className="w-5 h-5 text-purple-300" />
        <h2 className="text-lg font-semibold text-white">Ambassador Management</h2>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {overviewCards.map(c => (
          <div key={c.label} className="bg-white/5 border border-white/10 rounded-xl p-3">
            <p className="text-[11px] text-neutral-500 leading-tight">{c.label}</p>
            <p className="text-xl font-bold text-white mt-1">{c.value}</p>
          </div>
        ))}
      </div>

      {/* ── Ambassadors ── */}
      <div className="space-y-2">
        <p className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">Ambassadors</p>
        {data.ambassadors.length === 0 ? (
          <p className="text-sm text-neutral-500">No creators have enabled Ambassador Mode yet.</p>
        ) : data.ambassadors.map(a => (
          <div key={a.ambassadorId} className={`border rounded-xl px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3 ${
            a.enabled ? "bg-purple-500/5 border-purple-400/25" : "bg-white/5 border-white/10 opacity-70"
          }`}>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <a href={`https://instagram.com/${a.creatorInstagram.replace(/^@+/, "")}`} target="_blank" rel="noopener noreferrer"
                  className="font-semibold text-white hover:text-purple-200 transition-colors">@{a.creatorInstagram.replace(/^@+/, "")}</a>
                <span className={`text-[10px] px-2 py-0.5 rounded-full border ${
                  a.enabled ? "bg-purple-500/15 text-purple-200 border-purple-400/30" : "bg-white/10 text-neutral-400 border-white/15"
                }`}>{a.enabled ? "Ambassador" : "Disabled"}</span>
              </div>
              <div className="flex items-center gap-2 mt-1">
                <code className="text-[11px] text-neutral-500 font-mono truncate">{a.referralUrl}</code>
                <button onClick={() => copyLink(a.referralUrl, a.ambassadorId)} className="text-neutral-500 hover:text-white transition-colors shrink-0">
                  {copied === a.ambassadorId ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                </button>
              </div>
              {(byAmbassador[a.ambassadorId] ?? []).length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 mt-2">
                  {(byAmbassador[a.ambassadorId] ?? []).map(r => (
                    // Paid is the only state worth colouring: it is the one that
                    // has cost money and cannot be undone.
                    <span key={r.id}
                      title={`${pretty(r.status)} · reward ${r.rewardStatus}${r.unrecorded ? " · inferred from the business, no referral row" : ""}`}
                      className={`text-[10px] px-2 py-0.5 rounded-md border ${
                        r.rewardStatus === "paid"
                          ? "bg-green-500/10 text-green-300 border-green-500/25"
                          : "bg-white/5 text-neutral-300 border-white/15"
                      }`}>
                      {r.businessName || r.businessEmail || "Unnamed business"}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div className="flex items-center gap-4 text-xs shrink-0">
              <span className="text-neutral-500">Referred <span className="text-white font-semibold">{a.businessesReferred}</span></span>
              <span className="text-neutral-500">Conv. <span className="text-white font-semibold">{a.conversionRate}%</span></span>
              <span className="text-neutral-500">Earned <span className="text-green-400 font-semibold">{money(a.rewardsEarned)}</span></span>
              <button onClick={() => onToggle(a.ambassadorId, !a.enabled)} disabled={busy === a.ambassadorId}
                className="px-3 py-1.5 rounded-lg bg-white/10 text-neutral-200 hover:bg-white/15 transition-all disabled:opacity-50 whitespace-nowrap">
                {a.enabled ? "Disable" : "Enable"}
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* ── Referrals ── */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <p className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">Referrals</p>
          <div className="flex items-center gap-2 flex-wrap">
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search business…"
              className="px-2.5 py-1.5 text-xs bg-neutral-800 border border-white/15 rounded-lg text-white placeholder:text-neutral-600 focus:outline-none" />
            <select value={creatorFilter} onChange={e => setCreatorFilter(e.target.value)}
              className="px-2.5 py-1.5 text-xs bg-neutral-800 border border-white/15 rounded-lg text-white focus:outline-none">
              <option value="">All creators</option>
              {data.ambassadors.map(a => <option key={a.ambassadorId} value={a.creatorInstagram}>@{a.creatorInstagram.replace(/^@+/, "")}</option>)}
            </select>
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
              className="px-2.5 py-1.5 text-xs bg-neutral-800 border border-white/15 rounded-lg text-white focus:outline-none">
              <option value="">All stages</option>
              {statuses.map(s => <option key={s} value={s}>{pretty(s)}</option>)}
            </select>
            <select value={rewardFilter} onChange={e => setRewardFilter(e.target.value)}
              className="px-2.5 py-1.5 text-xs bg-neutral-800 border border-white/15 rounded-lg text-white focus:outline-none">
              <option value="">All rewards</option>
              {["pending", "earned", "paid"].map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>

        {referrals.length === 0 ? (
          <p className="text-sm text-neutral-500">No referrals match these filters.</p>
        ) : referrals.map(r => (
          <div key={r.id} className="bg-white/5 border border-white/10 rounded-xl px-4 py-3 space-y-3">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <p className="font-semibold text-white truncate">{r.businessName || "—"}</p>
                <p className="text-xs text-neutral-500 truncate">{r.businessEmail}</p>
                <p className="text-[11px] text-neutral-600 mt-0.5">
                  via @{r.creatorInstagram.replace(/^@+/, "")} · {new Date(r.createdAt).toLocaleDateString()}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-white/10 text-neutral-300 border border-white/15">{pretty(r.status)}</span>
                <span className={`text-[11px] px-2 py-0.5 rounded-full border ${
                  r.rewardStatus === "paid" ? "bg-green-500/15 text-green-400 border-green-500/25"
                  : r.rewardStatus === "earned" ? "bg-blue-500/15 text-blue-400 border-blue-500/25"
                  : "bg-yellow-500/10 text-yellow-400 border-yellow-500/25"
                }`}>{money(r.rewardAmount)} {r.rewardStatus}</span>
              </div>
            </div>

            {/* Pipeline — each stage is recorded by hand until billing is wired up. */}
            <div className="flex items-center gap-2 flex-wrap">
              {STAGES.map(st => {
                const done = !!r[st.field];
                return (
                  <button key={st.key} onClick={() => onAdvance(r.id, st.key)} disabled={done || busy === r.id}
                    title={done ? `Recorded ${new Date(r[st.field] as string).toLocaleDateString()}` : `Mark ${st.label}`}
                    className={`px-2.5 py-1 text-[11px] rounded-lg border transition-all disabled:cursor-default ${
                      done ? "bg-green-500/15 text-green-400 border-green-500/25"
                           : "bg-white/5 text-neutral-300 border-white/15 hover:border-white/30"
                    }`}>
                    {done ? "✓ " : ""}{st.label}
                  </button>
                );
              })}
              {r.rewardStatus === "earned" && (
                <button onClick={() => onPayReward(r.id)} disabled={busy === r.id}
                  className="ml-auto px-3 py-1 text-[11px] rounded-lg bg-green-600 text-white hover:bg-green-500 transition-all disabled:opacity-50">
                  {busy === r.id ? "Paying…" : `Pay ${money(r.rewardAmount)} reward`}
                </button>
              )}
              {r.rewardStatus === "paid" && (
                <span className="ml-auto text-[11px] text-neutral-500">
                  Credited {r.rewardPaidAt ? new Date(r.rewardPaidAt).toLocaleDateString() : ""}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
