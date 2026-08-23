// One rule for the monthly Reel quota, shared so the admin card and the
// business portal cannot drift apart.
//
// "Available Reels: X of Y" means: Y Reels exist for the business this month,
// X of them are still theirs to spend.
//
// Y is the tier allowance plus one for every Reel granted outside it:
//
//   free (isTrial)     a giveaway from CONTYNT. Grants a Reel.
//   one-off (isOneOff) bought on top of the subscription. Grants a Reel.
//   everything else    drawn from the tier allowance. Grants nothing.
//
// So a Growth business (2/mo) sent one free and one one-time feature reads
// "4 of 4". Free and one-off differ only in who pays; the quota treats them
// the same.
//
// An *offered* feature has not been spent -- it is an offer the business has
// not accepted -- so it stays available to them. It does reduce the number of
// blank request slots, so the same Reel cannot be taken twice.
//
// The allowance is per MONTH, and every count below is scoped to the current
// one. It was not, for a while: the stored monthly counter was dropped in
// migration 20260819010000 and the derived rule that replaced it had no date
// bound at all, so a Starter business got one Reel *ever* while being billed
// every month, and read "0 of 1" forever after using it.
//
// The month is the UTC calendar month, not the subscription's billing
// anniversary. The portal has always said "this month", and the server has to
// reach the identical answer to enforce what the client renders -- a calendar
// month is the only boundary both can compute without another Stripe round
// trip. A business that subscribes on the 28th therefore sees its allowance
// refresh on the 1st. If that ever needs to be the anniversary instead, the
// period start has to be stored on the business row from the subscription and
// passed to `now` below; nothing else here changes.

// Spent: the business accepted the offer, or requested the Reel outright.
const SPENT_STATUSES = ["pending", "available", "completed"];
// Exists at all, as opposed to withdrawn.
const LIVE_STATUSES = ["offered", ...SPENT_STATUSES];

export interface QuotaFeature {
  status?: string; isTrial?: boolean; isOneOff?: boolean;
  /** When the Reel was granted. Stamped by every path that creates a Feature. */
  offeredAt?: string | null;
  /** Fallback for rows written before offered_at was set on every path. */
  approvedAt?: string | null;
}

const isLive = (f: QuotaFeature): boolean => LIVE_STATUSES.includes(f.status || "");

/**
 * Does this Feature belong to the month being counted?
 *
 * A Feature with no usable date counts as current: dropping it would hand out a
 * free Reel every time a timestamp went missing, which is the wrong way for
 * this to fail.
 */
export const inQuotaMonth = (f: QuotaFeature, now: Date = new Date()): boolean => {
  const raw = f.offeredAt || f.approvedAt;
  if (!raw) return true;
  const d = new Date(raw);
  if (isNaN(d.getTime())) return true;
  return d.getUTCFullYear() === now.getUTCFullYear() && d.getUTCMonth() === now.getUTCMonth();
};

/** This month's Features. Every count below runs on this, never the raw list. */
export const thisMonth = (features: QuotaFeature[] = [], now: Date = new Date()): QuotaFeature[] =>
  features.filter(f => inQuotaMonth(f, now));

/** Reels granted on top of the tier allowance: every free and one-off feature. */
export const countGrants = (features: QuotaFeature[] = [], now?: Date): number =>
  thisMonth(features, now).filter(f => (!!f.isTrial || !!f.isOneOff) && isLive(f)).length;

/** Reels the business has already committed this month. */
export const countQuotaUsed = (features: QuotaFeature[] = [], now?: Date): number =>
  thisMonth(features, now).filter(f => SPENT_STATUSES.includes(f.status || "")).length;

/** Offers waiting to be accepted. They hold a Reel without having spent it. */
export const countOpenOffers = (features: QuotaFeature[] = [], now?: Date): number =>
  thisMonth(features, now).filter(f => f.status === "offered").length;

/** The "of Y" -- every Reel available to the business this month. */
export const quotaLimit = (tierLimit: number, features: QuotaFeature[] = [], now?: Date): number =>
  (tierLimit || 0) + countGrants(features, now);

/** The "X of" -- never negative, since an admin may over-allocate. */
export const quotaRemaining = (tierLimit: number, features: QuotaFeature[] = [], now?: Date): number =>
  Math.max(0, quotaLimit(tierLimit, features, now) - countQuotaUsed(features, now));

/**
 * Blank "request a Reel" slots to render. Open offers are subtracted because
 * each already occupies one of the remaining Reels; without this a business
 * would see an offer card *and* a full set of slots, and could claim both.
 */
export const openRequestSlots = (tierLimit: number, features: QuotaFeature[] = [], now?: Date): number =>
  Math.max(0, quotaRemaining(tierLimit, features, now) - countOpenOffers(features, now));
