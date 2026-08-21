-- The confirm screen swapped text messages for Instagram DMs. The handle is the
-- one contact detail every creator has already given us, so this defaults on,
-- unlike notify_sms which needed a phone number before it could mean anything.
-- notify_sms and phone stay put: creators who already opted in are still opted
-- in, the screen simply no longer offers it.
alter table creator_signups_f5961d0c
  add column if not exists notify_dm boolean not null default true;
