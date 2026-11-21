-- InterviewPilot paid accounts. Run after schema.sql.
--
-- Every account starts with 3 free interviews (credits); after that, a monthly plan with a fair-use cap.
-- Credits and plans can only change inside the security-definer functions below:
--   ip_start_interview()   uses the monthly plan if active, else one credit (admins: free), and opens a grant
--   ip_use_grant()         counts calls made under a grant, within fixed limits
--   ip_grant_credits()     adds credits for a paid Stripe session, once per session;
--   ip_set_subscription()  records a Stripe subscription's state (service role only)
--                          only the service role (the Stripe webhook) may call these
-- Signed-in users can read their own balance and purchases and nothing else.

create table if not exists public.ip_admins (
  email text primary key check (email = lower(email))
);
alter table public.ip_admins enable row level security;
revoke all on public.ip_admins from anon, authenticated;

create table if not exists public.ip_accounts (
  user_id uuid primary key references auth.users (id) on delete cascade,
  credits integer not null default 0 check (credits >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ip_purchases (
  id text primary key,                     -- Stripe Checkout Session id
  user_id uuid not null references auth.users (id) on delete cascade,
  credits integer not null check (credits > 0),
  amount_cents integer not null check (amount_cents >= 0),
  currency text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.ip_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  plans_used integer not null default 0,
  scores_used integer not null default 0,
  calls_used integer not null default 0,
  answers_used integer not null default 0,
  via_plan boolean not null default false
);
alter table public.ip_grants add column if not exists via_plan boolean not null default false;

create table if not exists public.ip_subscriptions (
  user_id uuid primary key references auth.users (id) on delete cascade,
  subscription_id text not null unique,
  customer_id text not null,
  status text not null,
  current_period_end timestamptz not null,
  cancel_at_period_end boolean not null default false,
  last_event_at timestamptz not null,
  updated_at timestamptz not null default now()
);
create index if not exists ip_grants_user_idx on public.ip_grants (user_id, created_at desc);

create table if not exists public.ip_usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null,
  job_fetches integer not null default 0,
  primary key (user_id, day)
);

do $$
declare t text;
begin
  foreach t in array array['ip_accounts', 'ip_purchases', 'ip_grants', 'ip_usage', 'ip_subscriptions'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('drop policy if exists own_rows_read on public.%I', t);
  end loop;
  -- Read-only views of your own balance and purchases.
  grant select on public.ip_accounts, public.ip_purchases to authenticated;
  create policy own_rows_read on public.ip_accounts for select to authenticated using (user_id = (select auth.uid()));
  create policy own_rows_read on public.ip_purchases for select to authenticated using (user_id = (select auth.uid()));
end $$;

-- Paid product: anyone who signs in may store their own data (the allowlist is retired).
do $$
declare t text;
begin
  foreach t in array array['ip_sessions', 'ip_profiles', 'ip_interviews'] loop
    execute format('drop policy if exists own_rows on public.%I', t);
    execute format(
      'create policy own_rows on public.%I for all to authenticated '
      'using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))',
      t
    );
  end loop;
end $$;

create schema if not exists ip_private;
revoke all on schema ip_private from public, anon;
grant usage on schema ip_private to authenticated;

create or replace function ip_private.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.ip_admins a where a.email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;
revoke all on function ip_private.is_admin() from public, anon;
grant execute on function ip_private.is_admin() to authenticated;

-- Every new sign-up gets an account row with the free interviews configured (default 3).
create table if not exists ip_private.settings (key text primary key, value text not null);
insert into ip_private.settings values ('free_credits', '3') on conflict do nothing;
insert into ip_private.settings values ('monthly_limit', '60') on conflict do nothing;
revoke all on ip_private.settings from public, anon, authenticated;

create or replace function ip_private.on_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.ip_accounts (user_id, credits)
  values (new.id, coalesce((select value::int from ip_private.settings where key = 'free_credits'), 0))
  on conflict (user_id) do nothing;
  return new;
end;
$$;
drop trigger if exists ip_on_new_user on auth.users;
create trigger ip_on_new_user after insert on auth.users
  for each row execute function ip_private.on_new_user();
insert into public.ip_accounts (user_id, credits)
  select id, coalesce((select value::int from ip_private.settings where key = 'free_credits'), 0) from auth.users
  on conflict do nothing;

-- The current billing period of an active plan, if any.
create or replace function ip_private.active_plan(me uuid)
returns public.ip_subscriptions language sql stable security definer set search_path = '' as $$
  select * from public.ip_subscriptions
  where user_id = me and status in ('active', 'trialing') and current_period_end > now();
$$;
revoke all on function ip_private.active_plan(uuid) from public, anon, authenticated;

create or replace function ip_private.plan_uses(me uuid, period_end timestamptz)
returns integer language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.ip_grants
  where user_id = me and via_plan and created_at > period_end - interval '1 month';
$$;
revoke all on function ip_private.plan_uses(uuid, timestamptz) from public, anon, authenticated;

create or replace function public.ip_account_status()
returns json language plpgsql stable security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  sub public.ip_subscriptions%rowtype;
  plan json := null;
begin
  if me is null then raise exception 'not_signed_in' using errcode = '28000'; end if;
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

create or replace function public.ip_start_interview()
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  grant_id uuid;
  sub public.ip_subscriptions%rowtype;
  on_plan boolean := false;
begin
  if me is null then raise exception 'not_signed_in' using errcode = '28000'; end if;
  if not ip_private.is_admin() then
    -- One start at a time per user, so two tabs can't both squeeze under the cap.
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

-- kind: plan (2 per interview), score (40), call (3 tries to connect), answer (15 stronger answers, for 90 days)
create or replace function public.ip_use_grant(grant_id uuid, kind text)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  g public.ip_grants%rowtype;
begin
  if me is null then return false; end if;
  select * into g from public.ip_grants where id = grant_id and user_id = me for update;
  if not found then return false; end if;
  if kind = 'answer' then
    if g.created_at < now() - interval '90 days' or g.answers_used >= 15 then return false; end if;
    update public.ip_grants set answers_used = answers_used + 1 where id = grant_id;
    return true;
  end if;
  if g.expires_at < now() then return false; end if;
  if kind = 'plan' and g.plans_used < 2 then
    update public.ip_grants set plans_used = plans_used + 1 where id = grant_id; return true;
  elsif kind = 'score' and g.scores_used < 40 then
    update public.ip_grants set scores_used = scores_used + 1 where id = grant_id; return true;
  elsif kind = 'call' and g.calls_used < 3 then
    update public.ip_grants set calls_used = calls_used + 1 where id = grant_id; return true;
  end if;
  return false;
end;
$$;

create or replace function public.ip_count_job_fetch()
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  used integer;
begin
  if me is null then return false; end if;
  insert into public.ip_usage (user_id, day, job_fetches) values (me, current_date, 1)
    on conflict (user_id, day) do update set job_fetches = public.ip_usage.job_fetches + 1
    returning job_fetches into used;
  return used <= (case when ip_private.is_admin() then 200 else 15 end);
end;
$$;

-- Called only by the Stripe webhook (service role). Idempotent per Checkout Session.
create or replace function public.ip_grant_credits(
  p_session_id text, p_user_id uuid, p_credits integer, p_amount_cents integer, p_currency text
)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_credits <= 0 or p_credits > 500 then raise exception 'bad_credits'; end if;
  insert into public.ip_purchases (id, user_id, credits, amount_cents, currency)
    values (p_session_id, p_user_id, p_credits, p_amount_cents, lower(p_currency))
    on conflict (id) do nothing;
  if not found then return false; end if;  -- already counted
  insert into public.ip_accounts (user_id, credits) values (p_user_id, p_credits)
    on conflict (user_id) do update set credits = public.ip_accounts.credits + p_credits, updated_at = now();
  return true;
end;
$$;

-- Called only by the Stripe webhook. Events can arrive out of order: older ones are ignored,
-- and a stale event about an old subscription never replaces a newer active one.
create or replace function public.ip_set_subscription(
  p_user_id uuid, p_subscription_id text, p_customer_id text, p_status text,
  p_period_end timestamptz, p_cancel_at_period_end boolean, p_event_at timestamptz
)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare cur public.ip_subscriptions%rowtype;
begin
  select * into cur from public.ip_subscriptions where user_id = p_user_id for update;
  if found then
    if cur.subscription_id = p_subscription_id and p_event_at < cur.last_event_at then return false; end if;
    if cur.subscription_id <> p_subscription_id and cur.status in ('active', 'trialing')
       and cur.current_period_end > now() and p_status not in ('active', 'trialing') then
      return false;
    end if;
    update public.ip_subscriptions set subscription_id = p_subscription_id, customer_id = p_customer_id,
      status = p_status, current_period_end = p_period_end, cancel_at_period_end = p_cancel_at_period_end,
      last_event_at = p_event_at, updated_at = now()
      where user_id = p_user_id;
  else
    insert into public.ip_subscriptions (user_id, subscription_id, customer_id, status, current_period_end,
      cancel_at_period_end, last_event_at)
      values (p_user_id, p_subscription_id, p_customer_id, p_status, p_period_end, p_cancel_at_period_end, p_event_at);
  end if;
  return true;
end;
$$;

revoke all on function public.ip_set_subscription(uuid, text, text, text, timestamptz, boolean, timestamptz) from public, anon, authenticated;
grant execute on function public.ip_set_subscription(uuid, text, text, text, timestamptz, boolean, timestamptz) to service_role;
revoke all on function public.ip_account_status() from public, anon;
revoke all on function public.ip_start_interview() from public, anon;
revoke all on function public.ip_use_grant(uuid, text) from public, anon;
revoke all on function public.ip_count_job_fetch() from public, anon;
revoke all on function public.ip_grant_credits(text, uuid, integer, integer, text) from public, anon, authenticated;
grant execute on function public.ip_account_status() to authenticated;
grant execute on function public.ip_start_interview() to authenticated;
grant execute on function public.ip_use_grant(uuid, text) to authenticated;
grant execute on function public.ip_count_job_fetch() to authenticated;
grant execute on function public.ip_grant_credits(text, uuid, integer, integer, text) to service_role;
