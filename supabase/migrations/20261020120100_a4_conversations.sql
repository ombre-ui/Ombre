-- Ombre A4, migration 2 of 5: conversations.
-- A conversation is user-owned, optionally attached to a project, and optionally tied to a mentor id.
-- mentor_id is free text validated for shape only: the mentor catalog is application data (no mentors table in A4),
-- so the API validates catalog membership and nothing privileged may rely on this column being catalog-valid.
-- message_count and last_message_at are maintained by the messages insert trigger (migration 3), never by clients.

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  project_id uuid,
  mentor_id text,
  title text not null default 'Untitled conversation',
  message_count integer not null default 0,
  last_message_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint conversations_title_check
    check (char_length(btrim(title)) between 1 and 120),
  constraint conversations_mentor_id_check
    check (mentor_id is null or (char_length(mentor_id) <= 64 and mentor_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$')),
  constraint conversations_message_count_check
    check (message_count between 0 and 500),
  -- Target for composite (id, user_id) foreign keys from messages and saved_items.
  constraint conversations_id_user_id_key unique (id, user_id),
  -- A conversation can only point at a project owned by the same user. Deleting the project detaches the
  -- conversation: only project_id is nulled (a plain SET NULL would also null the NOT NULL user_id).
  constraint conversations_project_fk
    foreign key (project_id, user_id) references public.projects (id, user_id)
    on delete set null (project_id)
);

create index conversations_user_last_message_idx
  on public.conversations (user_id, last_message_at desc, id desc);

create index conversations_project_last_message_idx
  on public.conversations (project_id, last_message_at desc, id desc)
  where project_id is not null;

alter table public.conversations enable row level security;

revoke all on table public.conversations from anon;
revoke all on table public.conversations from authenticated;

-- Clients may create a conversation (title, mentor, project) and later rename or move it.
-- message_count, last_message_at and updated_at are database-controlled.
grant select, delete on table public.conversations to authenticated;
grant insert (title, mentor_id, project_id) on table public.conversations to authenticated;
grant update (title, project_id) on table public.conversations to authenticated;

create policy "Users can view their own conversations"
on public.conversations
for select
to authenticated
using ((select auth.uid()) = user_id);

-- save_history = false means session-only: the database refuses to create a persisted conversation.
-- Fail closed: a missing settings row also denies.
create policy "Users can create their own conversations while history is on"
on public.conversations
for insert
to authenticated
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1
    from public.user_settings s
    where s.user_id = (select auth.uid())
      and s.save_history
  )
);

create policy "Users can update their own conversations"
on public.conversations
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "Users can delete their own conversations"
on public.conversations
for delete
to authenticated
using ((select auth.uid()) = user_id);

create trigger conversations_set_updated_at
before update on public.conversations
for each row execute function public.set_updated_at();

create trigger conversations_enforce_row_cap
before insert on public.conversations
for each row execute function private.enforce_user_row_cap(2000);

comment on table public.conversations is 'Ombre user-owned conversations (General AI when mentor_id is null). Deleting a conversation deletes its messages and saved items.';
