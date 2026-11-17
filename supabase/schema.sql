-- InterviewPilot cloud schema.
--
-- Defense in depth:
--   * Row-level security on every table: a signed-in user reaches only rows
--     whose user_id is their own, and only if their email is on the allowlist.
--   * The anon role gets nothing. The backend never uses the service-role key.
--   * Content columns (*_enc) hold AES-256-GCM ciphertext made by the backend
--     with a key that is not in this database.

create table if not exists public.ip_allowed_emails (
  email text primary key check (email = lower(email))
);
alter table public.ip_allowed_emails enable row level security;
-- No policies: nobody reads or writes this table through the API.
revoke all on public.ip_allowed_emails from anon, authenticated;

-- The allowlist check lives in a schema the REST API doesn't expose.
create schema if not exists ip_private;
revoke all on schema ip_private from public, anon;
grant usage on schema ip_private to authenticated;

create or replace function ip_private.is_allowed()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.ip_allowed_emails a
    where a.email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;
revoke all on function ip_private.is_allowed() from public, anon;
grant execute on function ip_private.is_allowed() to authenticated;

create table if not exists public.ip_sessions (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  role_enc text not null,
  filename_enc text not null,
  job_description_enc text not null,
  chunks_enc text not null,
  passage_count integer not null check (passage_count between 1 and 1000),
  has_job_description boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists ip_sessions_user_idx on public.ip_sessions (user_id, created_at desc);

create table if not exists public.ip_profiles (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  notes_enc text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.ip_interviews (
  id text not null check (id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  started_at text not null,
  payload_enc text not null check (length(payload_enc) < 400000),
  created_at timestamptz not null default now(),
  primary key (user_id, id)
);
create index if not exists ip_interviews_user_idx on public.ip_interviews (user_id, started_at desc);

do $$
declare t text;
begin
  foreach t in array array['ip_sessions', 'ip_profiles', 'ip_interviews'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('drop policy if exists own_rows on public.%I', t);
    execute format(
      'create policy own_rows on public.%I for all to authenticated '
      'using (user_id = (select auth.uid()) and (select ip_private.is_allowed())) '
      'with check (user_id = (select auth.uid()) and (select ip_private.is_allowed()))',
      t
    );
  end loop;
end $$;
