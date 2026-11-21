-- InterviewPilot: interviews that never connected give their credit back. Run after hardening.sql.
--
-- A grant's calls_used now counts only video calls that actually started (the web app's server
-- records the call after Nuance hands out a session). A grant that expires with no started call
-- is refunded: one credit back, or the monthly-plan interview no longer counts. Refunds happen
-- the next time the account's status is read or an interview starts.

alter table public.ip_grants add column if not exists refunded boolean not null default false;

-- Check without counting, for before the call starts.
create or replace function ip_private.ip_use_grant(grant_id uuid, kind text)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  g public.ip_grants%rowtype;
begin
  if me is null then return false; end if;
  select * into g from public.ip_grants where id = grant_id and user_id = me for update;
  if not found or g.refunded then return false; end if;
  if kind = 'answer' then
    if g.created_at < now() - interval '90 days' or g.answers_used >= 15 then return false; end if;
    update public.ip_grants set answers_used = answers_used + 1 where id = grant_id;
    return true;
  end if;
  if g.expires_at < now() then return false; end if;
  if kind = 'call_check' then
    return g.calls_used < 3;
  elsif kind = 'plan' and g.plans_used < 2 then
    update public.ip_grants set plans_used = plans_used + 1 where id = grant_id; return true;
  elsif kind = 'score' and g.scores_used < 40 then
    update public.ip_grants set scores_used = scores_used + 1 where id = grant_id; return true;
  elsif kind = 'call' and g.calls_used < 3 then
    update public.ip_grants set calls_used = calls_used + 1 where id = grant_id; return true;
  end if;
  return false;
end;
$$;

-- Refunds this person's expired interviews that never connected.
create or replace function ip_private.settle_grants(me uuid)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare
  back integer;
begin
  with done as (
    update public.ip_grants set refunded = true
      where user_id = me and not refunded and calls_used = 0 and expires_at < now()
      returning via_plan
  )
  select count(*) filter (where not via_plan) into back from done;
  if back > 0 and not ip_private.is_admin() then
    update public.ip_accounts set credits = credits + back, updated_at = now() where user_id = me;
  end if;
end;
$$;
revoke all on function ip_private.settle_grants(uuid) from public, anon, authenticated;

-- Plan interviews that were refunded don't count toward the monthly cap.
create or replace function ip_private.plan_uses(me uuid, period_end timestamptz)
returns integer language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.ip_grants
  where user_id = me and via_plan and not refunded and created_at > period_end - interval '1 month';
$$;

create or replace function ip_private.ip_account_status()
returns json language plpgsql volatile security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  sub public.ip_subscriptions%rowtype;
  plan json := null;
begin
  if me is null then raise exception 'not_signed_in' using errcode = '28000'; end if;
  perform ip_private.settle_grants(me);
  select * into sub from public.ip_subscriptions where user_id = me;
  if found then
    plan := json_build_object(
      'status', sub.status,
      'active', sub.status in ('active', 'trialing') and sub.current_period_end > now(),
      'renews_at', sub.current_period_end,
      'cancel_at_period_end', sub.cancel_at_period_end,
      'used', ip_private.plan_uses(me, sub.current_period_end),
      'limit', coalesce((select value::int from ip_private.settings where key = 'monthly_limit'), 60),
      'customer_id', sub.customer_id
    );
  end if;
  return json_build_object(
    'credits', coalesce((select credits from public.ip_accounts where user_id = me), 0),
    'unlimited', ip_private.is_admin(),
    'plan', plan
  );
end;
$$;

create or replace function public.ip_account_status()
returns json language sql volatile security invoker set search_path = '' as $$
  select ip_private.ip_account_status();
$$;

create or replace function ip_private.ip_start_interview()
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  grant_id uuid;
  sub public.ip_subscriptions%rowtype;
  on_plan boolean := false;
begin
  if me is null then raise exception 'not_signed_in' using errcode = '28000'; end if;
  perform ip_private.settle_grants(me);
  if not ip_private.is_admin() then
    perform 1 from public.ip_accounts where user_id = me for update;
    select * into sub from ip_private.active_plan(me);
    if sub.user_id is not null and ip_private.plan_uses(me, sub.current_period_end)
        < coalesce((select value::int from ip_private.settings where key = 'monthly_limit'), 60) then
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

-- One-off: before this change a call was counted even when Nuance refused to start it.
-- Interviews with no answers scored are treated as never connected.
update public.ip_grants set calls_used = 0
  where scores_used = 0 and not refunded and coalesce(
    (select value from ip_private.settings where key = 'refund_backfill_done'), '') <> 'yes';
insert into ip_private.settings values ('refund_backfill_done', 'yes')
  on conflict (key) do update set value = 'yes';
