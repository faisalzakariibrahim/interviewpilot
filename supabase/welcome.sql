-- InterviewPilot welcome email: sent once per account. Run after billing.sql.
--
-- ip_claim_welcome() returns true exactly once per account (the first caller wins), so the
-- backend never sends two welcome emails. If sending fails, ip_release_welcome() lets it retry.

alter table public.ip_accounts add column if not exists welcomed_at timestamptz;
-- Accounts that existed before this change don't get a welcome email.
update public.ip_accounts set welcomed_at = now() where welcomed_at is null;

create or replace function ip_private.ip_claim_welcome()
returns boolean language plpgsql volatile security definer set search_path = '' as $$
begin
  if auth.uid() is null then return false; end if;
  update public.ip_accounts set welcomed_at = now()
    where user_id = auth.uid() and welcomed_at is null;
  return found;
end;
$$;

create or replace function ip_private.ip_release_welcome()
returns void language sql volatile security definer set search_path = '' as $$
  update public.ip_accounts set welcomed_at = null
    where user_id = auth.uid() and welcomed_at > now() - interval '5 minutes';
$$;

revoke all on function ip_private.ip_claim_welcome() from public, anon;
revoke all on function ip_private.ip_release_welcome() from public, anon;
grant execute on function ip_private.ip_claim_welcome() to authenticated;
grant execute on function ip_private.ip_release_welcome() to authenticated;

create or replace function public.ip_claim_welcome()
returns boolean language sql volatile security invoker set search_path = '' as $$
  select ip_private.ip_claim_welcome();
$$;
create or replace function public.ip_release_welcome()
returns void language sql volatile security invoker set search_path = '' as $$
  select ip_private.ip_release_welcome();
$$;
revoke all on function public.ip_claim_welcome() from public, anon;
revoke all on function public.ip_release_welcome() from public, anon;
grant execute on function public.ip_claim_welcome() to authenticated;
grant execute on function public.ip_release_welcome() to authenticated;
