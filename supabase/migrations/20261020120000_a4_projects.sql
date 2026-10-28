-- Ombre A4, migration 1 of 5: projects.
-- A project is a user-owned container. Conversations and library items reference it through composite
-- (id, user_id) foreign keys so a row can never point at another user's project, even though foreign key
-- checks bypass row level security.

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  description text not null default '',
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint projects_name_check
    check (char_length(btrim(name)) between 1 and 100),
  constraint projects_description_check
    check (char_length(description) <= 2000),
  -- Target for composite (id, user_id) foreign keys from child tables.
  constraint projects_id_user_id_key unique (id, user_id)
);

create index projects_user_updated_idx
  on public.projects (user_id, updated_at desc, id desc);

alter table public.projects enable row level security;

-- Explicit grants only: nothing for anon, minimum for authenticated.
-- user_id is never writable by clients: it is filled by the column default (auth.uid()) and re-checked by RLS.
revoke all on table public.projects from anon;
revoke all on table public.projects from authenticated;

grant select, delete on table public.projects to authenticated;
grant insert (name, description) on table public.projects to authenticated;
grant update (name, description, archived_at) on table public.projects to authenticated;

create policy "Users can view their own projects"
on public.projects
for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can create their own projects"
on public.projects
for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy "Users can update their own projects"
on public.projects
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "Users can delete their own projects"
on public.projects
for delete
to authenticated
using ((select auth.uid()) = user_id);

create trigger projects_set_updated_at
before update on public.projects
for each row execute function public.set_updated_at();

-- Per-user row cap. Application rate limiting is per instance and not a quota, so growth is bounded here.
-- The advisory lock serialises concurrent inserts for the same user and table so the count is exact.
-- SECURITY INVOKER: the count runs under the caller's own RLS, which only shows their own rows.
-- Used by projects (100), conversations (2000) and saved_items (2000); the limit is the trigger argument.
create schema if not exists private;

create or replace function private.enforce_user_row_cap()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  max_rows integer;
  current_rows integer;
begin
  max_rows := tg_argv[0]::integer;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(tg_table_name || ':' || new.user_id::text, 0)
  );
  execute pg_catalog.format('select count(*) from %I.%I where user_id = $1', tg_table_schema, tg_table_name)
    into current_rows
    using new.user_id;
  if current_rows >= max_rows then
    raise exception 'limit_reached' using errcode = 'OL001', hint = tg_table_name;
  end if;
  return new;
end;
$$;

revoke execute on function private.enforce_user_row_cap() from public, anon, authenticated;

create trigger projects_enforce_row_cap
before insert on public.projects
for each row execute function private.enforce_user_row_cap(100);

comment on table public.projects is 'Ombre user-owned projects. Deleting a project detaches (never deletes) its conversations and library items.';
