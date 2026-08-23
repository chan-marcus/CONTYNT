-- Atomic increment for the pricing-plan click counter.
--
-- /business-portal/track-plan-click read plan_clicks and wrote back value + 1.
-- Two clicks arriving together both read the same number and both wrote the
-- same number, so one of them was lost -- which makes a metric that exists to
-- tell you how interested a business is quietly report less interest than there
-- was. PostgREST has no atomic increment, so it goes through a function.
--
-- security definer because the edge function calls it with the service role
-- anyway; search_path is pinned so the body cannot be redirected by a caller's
-- search_path.

create or replace function public.increment_plan_clicks_f5961d0c(p_business_id uuid)
returns integer
language sql
security definer
set search_path = public
as $$
  update public.business_signups_f5961d0c
     set plan_clicks = coalesce(plan_clicks, 0) + 1
   where id = p_business_id
  returning plan_clicks;
$$;

-- Nothing but the service role should be able to move this counter. The edge
-- function bypasses grants; anon and authenticated have no business here.
revoke all on function public.increment_plan_clicks_f5961d0c(uuid) from public, anon, authenticated;
