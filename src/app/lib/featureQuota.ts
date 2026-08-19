// One rule for the monthly Reel quota, shared so the admin card and the
// business portal cannot drift apart.
//
// "Available Reels: X of Y" means: Y Reels exist for the business this month,
// X of them are still theirs to spend.
//
// Three kinds of feature:
//
//   free (isTrial)     a giveaway. Never spends a Reel, never grants one.
//   one-off (isOneOff) bought on top of the subscription. Grants one Reel.
//   everything else    a subscription Reel drawn from the tier allowance.
//
// An *offered* feature has not been spent. It is an offer the business has not
// accepted, so it still counts as available to them -- otherwise a business
// with one purchased Reel reads "0 of 1" while staring at a card labelled
// Available. It does reduce the number of blank request slots, so the same
// Reel cannot be taken twice.

// Spent: the business accepted the offer or requested the Reel outright.
const SPENT_STATUSES = ["pending", "available", "completed"];
// Exists at all (as opposed to withdrawn).
const LIVE_STATUSES = ["offered", ...SPENT_STATUSES];

export interface QuotaFeature { status?: string; isTrial?: boolean; isOneOff?: boolean }

const isLive = (f: QuotaFeature): boolean =>
  !f.isTrial && LIVE_STATUSES.includes(f.status || "");

/** Reels the business has already committed. */
export const countQuotaUsed = (features: QuotaFeature[] = []): number =>
  features.filter(f => !f.isTrial && SPENT_STATUSES.includes(f.status || "")).length;

/** Each purchased one-off adds a Reel to the month's entitlement. */
export const countOneOffGrants = (features: QuotaFeature[] = []): number =>
  features.filter(f => !!f.isOneOff && isLive(f)).length;

/** Offers waiting to be accepted. They hold a Reel without having spent it. */
export const countOpenOffers = (features: QuotaFeature[] = []): number =>
  features.filter(f => !f.isTrial && f.status === "offered").length;

/** The "of Y" -- every Reel available to the business this month. */
export const quotaLimit = (tierLimit: number, features: QuotaFeature[] = []): number =>
  (tierLimit || 0) + countOneOffGrants(features);

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
