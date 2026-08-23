-- A business that cancels keeps its plan until the period it paid for runs out.
-- Nothing recorded that, so a pending cancellation was invisible until the
-- business simply stopped having a tier one day.
alter table business_signups_f5961d0c
  add column if not exists subscription_ends_at timestamptz;
