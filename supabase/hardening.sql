-- InterviewPilot: clears Supabase's security advisor findings. Run after billing.sql.
--
-- 1. The privileged account functions move to the ip_private schema, which the API does not
--    expose. The public functions the app calls become thin SECURITY INVOKER wrappers: they run
--    with the caller's own rights and can do nothing except call the private function, which
--    acts only on the caller's own account (auth.uid()).
-- 2. Tables that only server-side functions may touch get an explicit deny-all policy for API
--    users, instead of relying on "RLS on, no policy" (which already denied everything).

-- --- 1. private implementations ----------------------------------------------------------

alter function public.ip_account_status() set schema ip_private;
alter function public.ip_start_interview() set schema ip_private;
alter function public.ip_use_grant(uuid, text) set schema ip_private;
alter function public.ip_count_job_fetch() set schema ip_private;

revoke all on function ip_private.ip_account_status() from public, anon;
revoke all on function ip_private.ip_start_interview() from public, anon;
revoke all on function ip_private.ip_use_grant(uuid, text) from public, anon;
revoke all on function ip_private.ip_count_job_fetch() from public, anon;
grant execute on function ip_private.ip_account_status() to authenticated;
grant execute on function ip_private.ip_start_interview() to authenticated;
grant execute on function ip_private.ip_use_grant(uuid, text) to authenticated;
grant execute on function ip_private.ip_count_job_fetch() to authenticated;

-- --- public wrappers (same names and arguments, so the backend doesn't change) -------------

create or replace function public.ip_account_status()
returns json language sql stable security invoker set search_path = '' as $$
  select ip_private.ip_account_status();
$$;

create or replace function public.ip_start_interview()
returns uuid language sql volatile security invoker set search_path = '' as $$
  select ip_private.ip_start_interview();
$$;

create or replace function public.ip_use_grant(grant_id uuid, kind text)
returns boolean language sql volatile security invoker set search_path = '' as $$
  select ip_private.ip_use_grant(grant_id, kind);
$$;

create or replace function public.ip_count_job_fetch()
returns boolean language sql volatile security invoker set search_path = '' as $$
  select ip_private.ip_count_job_fetch();
$$;

revoke all on function public.ip_account_status() from public, anon;
revoke all on function public.ip_start_interview() from public, anon;
revoke all on function public.ip_use_grant(uuid, text) from public, anon;
revoke all on function public.ip_count_job_fetch() from public, anon;
grant execute on function public.ip_account_status() to authenticated;
grant execute on function public.ip_start_interview() to authenticated;
grant execute on function public.ip_use_grant(uuid, text) to authenticated;
grant execute on function public.ip_count_job_fetch() to authenticated;

-- --- 2. explicit deny-all policies ----------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['ip_admins', 'ip_allowed_emails', 'ip_grants', 'ip_subscriptions', 'ip_usage'] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop policy if exists no_api_access on public.%I', t);
      execute format(
        'create policy no_api_access on public.%I as restrictive for all to anon, authenticated using (false) with check (false)',
        t
      );
    end if;
  end loop;
end $$;
