-- Reminders have to be able to run more than once without mailing the same
-- creator twice, and "did we already tell them" is a fact about the claim, not
-- about the run that sent it. Two stamps because the two deadlines are
-- different things: 24 hours to accept a Feature, then 5 days to film it.
alter table creator_claims_f5961d0c
  add column if not exists acceptance_reminded_at timestamptz,
  add column if not exists expiry_reminded_at timestamptz,
  -- Selection is sent once, when an admin approves. Stamped so a second
  -- approval of the same claim does not mail it again.
  add column if not exists selected_notified_at timestamptz;
