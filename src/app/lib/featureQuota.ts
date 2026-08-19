// One rule for the monthly Reel quota, shared so the admin card and the
// business portal cannot drift apart. They previously each carried their own
// copy of the status list.
//
// Three kinds of feature, three behaviours:
//
//   free (isTrial)     a giveaway. Never counts, and never raises the total.
//   one-off (isOneOff) bought on top of the subscription. Raises the total by
//                      one AND holds that one, so the Reels the business
//                      already pays for stay free for them to request.
//   everything else    a subscription Reel. Counts against the tier allowance.
//
// So a Growth business (2/mo) holding one one-off offer reads "2 of 3": the
// purchase added the third, the one-off card is holding it, and both
// subscription Reels are still theirs to spend.

export const QUOTA_STATUSES = ["offered", "pending", "available", "completed"];

export interface QuotaFeature { status?: string; isTrial?: boolean; isOneOff?: boolean }

// Allocated means the feature is holding a Reel: it exists and has not been
// withdrawn. Free features are excluded because they are never funded from the
// allowance in the first place.
const isAllocated = (f: QuotaFeature): boolean =>
  !f.isTrial && QUOTA_STATUSES.includes(f.status || "");

export const countsTowardQuota = isAllocated;

export const countQuotaUsed = (features: QuotaFeature[] = []): number =>
  features.filter(isAllocated).length;

// Each purchased one-off adds one Reel to the month's entitlement.
export const countOneOffGrants = (features: QuotaFeature[] = []): number =>
  features.filter(f => !!f.isOneOff && isAllocated(f)).length;

// The denominator in "Available Reels: N of M".
export const quotaLimit = (tierLimit: number, features: QuotaFeature[] = []): number =>
  (tierLimit || 0) + countOneOffGrants(features);

// The numerator. Never negative: an admin can hand out more than the tier
// allows, and the display should read 0 rather than a negative count.
export const quotaRemaining = (tierLimit: number, features: QuotaFeature[] = []): number =>
  Math.max(0, quotaLimit(tierLimit, features) - countQuotaUsed(features));
