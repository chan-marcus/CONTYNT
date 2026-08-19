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

// Spent: the business accepted the offer, or requested the Reel outright.
const SPENT_STATUSES = ["pending", "available", "completed"];
// Exists at all, as opposed to withdrawn.
const LIVE_STATUSES = ["offered", ...SPENT_STATUSES];

export interface QuotaFeature { status?: string; isTrial?: boolean; isOneOff?: boolean }

const isLive = (f: QuotaFeature): boolean => LIVE_STATUSES.includes(f.status || "");

/** Reels granted on top of the tier allowance: every free and one-off feature. */
export const countGrants = (features: QuotaFeature[] = []): number =>
  features.filter(f => (!!f.isTrial || !!f.isOneOff) && isLive(f)).length;

/** Reels the business has already committed. */
export const countQuotaUsed = (features: QuotaFeature[] = []): number =>
  features.filter(f => SPENT_STATUSES.includes(f.status || "")).length;

/** Offers waiting to be accepted. They hold a Reel without having spent it. */
export const countOpenOffers = (features: QuotaFeature[] = []): number =>
  features.filter(f => f.status === "offered").length;

/** The "of Y" -- every Reel available to the business this month. */
export const quotaLimit = (tierLimit: number, features: QuotaFeature[] = []): number =>
  (tierLimit || 0) + countGrants(features);

/** The "X of" -- never negative, since an admin may over-allocate. */
export const quotaRemaining = (tierLimit: number, features: QuotaFeature[] = []): number =>
  Math.max(0, quotaLimit(tierLimit, features) - countQuotaUsed(features));

/**
 * Blank "request a Reel" slots to render. Open offers are subtracted because
 * each already occupies one of the remaining Reels; without this a business
 * would see an offer card *and* a full set of slots, and could claim both.
 */
export const openRequestSlots = (tierLimit: number, features: QuotaFeature[] = []): number =>
  Math.max(0, quotaRemaining(tierLimit, features) - countOpenOffers(features));
