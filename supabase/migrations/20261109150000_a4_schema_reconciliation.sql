-- Reconcile production with the canonical A4 schema already represented by the migration chain.
-- This is forward-only: it changes definitions/names, not user data.
--
-- Production had been created from an earlier A4 draft. The repository migrations were subsequently
-- tightened, so this migration makes the live schema reproduce the current migration replay exactly.

-- conversations column defaults/nullability.
alter table public.conversations
  alter column last_message_at set default now(),
  alter column last_message_at set not null;

-- conversations constraints and composite project FK.
alter table public.conversations
  drop constraint conversations_title_check,
  drop constraint conversations_mentor_id_check,
  drop constraint conversations_project_user_fk;

alter table public.conversations
  add constraint conversations_title_check
    check (char_length(btrim(title)) between 1 and 120),
  add constraint conversations_mentor_id_check
    check (mentor_id is null or (char_length(mentor_id) <= 64 and mentor_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$')),
  add constraint conversations_project_fk
    foreign key (project_id, user_id) references public.projects (id, user_id)
    on delete set null (project_id);

-- Canonical conversation project index.
drop index public.conversations_project_last_message_idx;
create index conversations_project_last_message_idx
  on public.conversations (project_id, last_message_at desc, id desc)
  where project_id is not null;

-- Canonical policy name.
alter policy "Users can create conversations when history is enabled"
  on public.conversations rename to "Users can create their own conversations while history is on";

-- Canonical row-cap trigger names.
alter table public.conversations
  rename trigger conversations_enforce_user_row_cap to conversations_enforce_row_cap;

alter table public.projects
  rename trigger projects_enforce_user_row_cap to projects_enforce_row_cap;

-- Canonical row-cap implementation from the current A4 migration.
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
