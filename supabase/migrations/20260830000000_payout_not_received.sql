-- A creator's only recourse when a cash-out never lands.
--
-- "Mark as Sent" in the admin dashboard is a human pressing a button after
-- moving money by hand through PayPal, Venmo or Zelle. Nothing verifies the
-- transfer actually arrived, so a typo'd handle, a rejected transfer, or a
-- button pressed before the sending was done all end the same way: the app
-- says paid, the creator has nothing, and there is no way for them to say so.
-- The only channel was to message somebody and hope.
--
-- Kept on the payout row rather than in a table of its own. A report is always
-- about one specific payout, and hanging it off that row means the amount, the
-- method, the handle it went to and the date it was marked sent are all already
-- there -- which is exactly what anyone investigating needs, and what a
-- separate reports table would have to duplicate or join back to.
alter table public.creator_payout_requests_f5961d0c
  add column if not exists not_received_at timestamptz,
  add column if not exists not_received_note text,
  add column if not exists issue_resolved_at timestamptz,
  add column if not exists issue_resolution text;

comment on column public.creator_payout_requests_f5961d0c.not_received_at is
  'When the creator reported this payout as never arriving. Null means no report.';
comment on column public.creator_payout_requests_f5961d0c.issue_resolved_at is
  'When an admin closed that report. A row with not_received_at set and this null is an open case.';

-- Open cases are the only ones anyone queries for, and they are a small
-- fraction of the table, so the index carries only those.
create index if not exists creator_payouts_open_issues
  on public.creator_payout_requests_f5961d0c (not_received_at desc)
  where not_received_at is not null and issue_resolved_at is null;
