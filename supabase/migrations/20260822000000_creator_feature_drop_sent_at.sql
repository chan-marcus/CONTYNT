-- The Feature drop announcement needs its own cooldown stamp. Reusing
-- verify_email_sent_at would have made the two sends interfere: announcing a
-- drop would suppress a verification reminder for a day, and vice versa.
alter table creator_signups_f5961d0c
  add column if not exists feature_drop_sent_at timestamptz;
