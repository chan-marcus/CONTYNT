// One rule for "does this feature consume one of the business's monthly Reels?",
// shared so the admin card and the business portal cannot drift apart. They
// previously each carried their own copy of the status list.
//
// Free features never count — that is what makes them free.
//
// "offered" counts. It used to be excluded, so an offered feature sat alongside
// a full set of empty request slots: a business could request its whole monthly
// allowance on top of an offer it had not accepted yet, and the admin card and
// portal both under-reported usage until the offer was accepted.
export const QUOTA_STATUSES = ["offered", "pending", "available", "completed"];

export interface QuotaFeature { status?: string; isTrial?: boolean }

export const countsTowardQuota = (f: QuotaFeature): boolean =>
  !f.isTrial && QUOTA_STATUSES.includes(f.status || "");

export const countQuotaUsed = (features: QuotaFeature[] = []): number =>
  features.filter(countsTowardQuota).length;
