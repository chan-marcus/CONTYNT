-- A second reminder on the submit clock, sent partway through rather than at
-- the end.
--
-- There was one nudge, six hours before the deadline. That was defensible when
-- creators had five days to film; at ten it means nine and a half days of
-- silence followed by a warning that arrives too late to act on -- nobody
-- books a shoot with six hours' notice. Of ten claims that were ever accepted,
-- four ran the clock out having produced nothing, and none of them heard
-- anything in between.
--
-- Its own stamp rather than reusing expiry_reminded_at, which the final
-- warning owns. One column cannot record two different sends, and collapsing
-- them would mean the midpoint nudge suppresses the warning that actually
-- matters.
--
-- Nullable with no default, like the two stamps beside it: a claim that has
-- not had it reads as null rather than as a date that means nothing.
alter table public.creator_claims_f5961d0c
  add column if not exists expiry_midpoint_reminded_at timestamptz;

comment on column public.creator_claims_f5961d0c.expiry_midpoint_reminded_at is
  'Set when the halfway nudge on the submit window was sent. expiry_reminded_at is the separate final warning.';
