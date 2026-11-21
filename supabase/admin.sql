-- InterviewPilot owner dashboard. Run after billing.sql and hardening.sql.
--
-- One read-only function returns the numbers for /admin. It refuses anyone who isn't in
-- public.ip_admins. It shows accounts, activity, plans and money; it never returns resume
-- text, notes or interview content (those stay encrypted and private to each user).

create or replace function ip_private.ip_admin_overview()
returns json language plpgsql stable security definer set search_path = '' as $$
declare
  result json;
begin
  if not ip_private.is_admin() then
    raise exception 'not_admin' using errcode = '42501';
  end if;

  select json_build_object(
    'generated_at', now(),
    'totals', json_build_object(
      'users', (select count(*) from auth.users),
      'signups_7d', (select count(*) from auth.users where created_at > now() - interval '7 days'),
      'active_7d', (select count(distinct user_id) from public.ip_grants where created_at > now() - interval '7 days'),
      'subscribers', (select count(*) from public.ip_subscriptions
                      where status in ('active', 'trialing') and current_period_end > now()),
      'cancelling', (select count(*) from public.ip_subscriptions
                     where status in ('active', 'trialing') and current_period_end > now() and cancel_at_period_end),
      'interviews_total', (select count(*) from public.ip_grants),
      'interviews_7d', (select count(*) from public.ip_grants where created_at > now() - interval '7 days'),
      'free_interviews_left', (select coalesce(sum(credits), 0) from public.ip_accounts),
      'resumes_uploaded', (select count(*) from public.ip_sessions),
      'scorecards_saved', (select count(*) from public.ip_interviews),
      'one_time_revenue_cents', (select coalesce(sum(amount_cents), 0) from public.ip_purchases),
      'job_links_read_7d', (select coalesce(sum(job_fetches), 0) from public.ip_usage where day > current_date - 7)
    ),
    'signups_by_day', (
      select json_agg(json_build_object('day', d::date, 'count',
        (select count(*) from auth.users u where u.created_at::date = d::date)) order by d)
      from generate_series(current_date - 29, current_date, interval '1 day') d
    ),
    'interviews_by_day', (
      select json_agg(json_build_object('day', d::date, 'count',
        (select count(*) from public.ip_grants g where g.created_at::date = d::date)) order by d)
      from generate_series(current_date - 29, current_date, interval '1 day') d
    ),
    'users', (
      select coalesce(json_agg(row_to_json(x) order by x.signed_up desc), '[]'::json) from (
        select
          u.email,
          coalesce(u.raw_user_meta_data ->> 'first_name', u.raw_user_meta_data ->> 'given_name', '') as name,
          coalesce(u.raw_app_meta_data ->> 'provider', 'email') as provider,
          u.created_at as signed_up,
          u.last_sign_in_at as last_sign_in,
          u.email_confirmed_at is not null as confirmed,
          exists (select 1 from public.ip_admins a where a.email = lower(u.email)) as admin,
          coalesce(a.credits, 0) as free_left,
          s.status as plan_status,
          (s.status in ('active', 'trialing') and s.current_period_end > now()) as subscribed,
          s.current_period_end as plan_renews,
          coalesce(s.cancel_at_period_end, false) as plan_cancelling,
          (select count(*) from public.ip_grants g where g.user_id = u.id) as interviews,
          (select max(created_at) from public.ip_grants g where g.user_id = u.id) as last_interview,
          (select count(*) from public.ip_sessions se where se.user_id = u.id) as resumes,
          (select count(*) from public.ip_interviews i where i.user_id = u.id) as scorecards
        from auth.users u
        left join public.ip_accounts a on a.user_id = u.id
        left join public.ip_subscriptions s on s.user_id = u.id
        order by u.created_at desc
        limit 500
      ) x
    ),
    'recent', (
      select coalesce(json_agg(row_to_json(e) order by e.at desc), '[]'::json) from (
        (select u.created_at as at, 'signup' as kind, u.email, null::text as detail
           from auth.users u order by u.created_at desc limit 25)
        union all
        (select g.created_at, 'interview', u.email,
                case when g.via_plan then 'monthly plan' else 'free interview' end
           from public.ip_grants g join auth.users u on u.id = g.user_id
           order by g.created_at desc limit 25)
        union all
        (select s.updated_at, 'plan', u.email,
                s.status || case when s.cancel_at_period_end then ' (cancelling)' else '' end
           from public.ip_subscriptions s join auth.users u on u.id = s.user_id
           order by s.updated_at desc limit 25)
        order by 1 desc
        limit 40
      ) e
    )
  ) into result;
  return result;
end;
$$;
revoke all on function ip_private.ip_admin_overview() from public, anon;
grant execute on function ip_private.ip_admin_overview() to authenticated;

-- The API-facing name: no rights of its own, just calls the private function.
create or replace function public.ip_admin_overview()
returns json language sql stable security invoker set search_path = '' as $$
  select ip_private.ip_admin_overview();
$$;
revoke all on function public.ip_admin_overview() from public, anon;
grant execute on function public.ip_admin_overview() to authenticated;
