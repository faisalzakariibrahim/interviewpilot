-- Cost guard: each account (except admins) may start at most `daily_limit` interviews in any
-- 24 hours. Refunded interviews (they never connected) don't count.
insert into ip_private.settings values ('daily_limit', '3') on conflict do nothing;

create or replace function ip_private.ip_start_interview()
returns uuid
language plpgsql
security definer
set search_path to ''
as $$
declare
  me uuid := auth.uid();
  grant_id uuid;
  sub public.ip_subscriptions%rowtype;
  on_plan boolean := false;
  started_today int;
begin
  if me is null then raise exception 'not_signed_in' using errcode = '28000'; end if;
  perform ip_private.settle_grants(me);
  if not ip_private.is_admin() then
    perform 1 from public.ip_accounts where user_id = me for update;
    select count(*) into started_today from public.ip_grants
      where user_id = me and not refunded and created_at > now() - interval '24 hours';
    if started_today >= coalesce((select value::int from ip_private.settings where key = 'daily_limit'), 3) then
      raise exception 'daily_limit' using errcode = 'P0429';
    end if;
    select * into sub from ip_private.active_plan(me);
    if sub.user_id is not null and ip_private.plan_uses(me, sub.current_period_end)
        < coalesce((select value::int from ip_private.settings where key = 'monthly_limit'), 15) then
      on_plan := true;
    else
      update public.ip_accounts set credits = credits - 1, updated_at = now()
        where user_id = me and credits > 0;
      if not found then
        if sub.user_id is not null then raise exception 'plan_limit' using errcode = 'P0402'; end if;
        raise exception 'no_credits' using errcode = 'P0402';
      end if;
    end if;
  end if;
  insert into public.ip_grants (user_id, expires_at, via_plan) values (me, now() + interval '45 minutes', on_plan)
    returning id into grant_id;
  return grant_id;
end;
$$;

create index if not exists ip_grants_user_created on public.ip_grants (user_id, created_at desc);
