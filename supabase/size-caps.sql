-- Users can reach their own rows through the REST API directly, so the limits the backend
-- applies are enforced here too: per-value sizes and rows per account.
alter table public.ip_sessions
  add constraint ip_sessions_sizes check (
    octet_length(coalesce(chunks_enc, '')) <= 3000000
    and octet_length(coalesce(job_description_enc, '')) <= 100000
    and octet_length(coalesce(role_enc, '')) <= 4000
    and octet_length(coalesce(filename_enc, '')) <= 4000);
alter table public.ip_profiles
  add constraint ip_profiles_sizes check (octet_length(coalesce(notes_enc, '')) <= 20000);
alter table public.ip_interviews
  add constraint ip_interviews_sizes check (
    octet_length(coalesce(payload_enc, '')) <= 400000
    and char_length(id) <= 128
    and octet_length(coalesce(started_at, '')) <= 64);

create or replace function ip_private.cap_rows_per_user()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
  limit_rows int := tg_argv[0]::int;
  existing int;
begin
  execute format('select count(*) from %I.%I where user_id = $1', tg_table_schema, tg_table_name)
    into existing using new.user_id;
  if existing >= limit_rows then
    raise exception 'too_many_rows' using errcode = '54000';
  end if;
  return new;
end;
$$;
revoke all on function ip_private.cap_rows_per_user() from public, anon, authenticated;

drop trigger if exists ip_sessions_cap on public.ip_sessions;
create trigger ip_sessions_cap before insert on public.ip_sessions
  for each row execute function ip_private.cap_rows_per_user('50');
drop trigger if exists ip_interviews_cap on public.ip_interviews;
create trigger ip_interviews_cap before insert on public.ip_interviews
  for each row execute function ip_private.cap_rows_per_user('2000');
