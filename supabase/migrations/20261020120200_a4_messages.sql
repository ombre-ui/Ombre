-- Ombre A4, migration 3 of 5: messages (append-only) and the atomic create_conversation().
--
-- Messages are append-only: no UPDATE/DELETE grant, no UPDATE/DELETE policy, and an UPDATE guard trigger.
-- The only removal path is the ON DELETE CASCADE from the conversation (or the user).
--
-- Structure vs. product rules:
--   * The table only enforces structure and ownership. It deliberately does NOT tie role to is_demo, so a
--     future server-side writer can persist a genuine (assistant, is_demo = false) message.
--   * The browser-facing authorization rule lives in the INSERT policy for `authenticated`: a user message with
--     is_demo = false, or an assistant message with is_demo = true. No path that mints non-demo assistant
--     messages exists in A4.

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  -- Assigned by the insert trigger (1..500, contiguous). Clients cannot supply it.
  seq integer not null,
  role text not null,
  content text not null,
  is_demo boolean not null default false,
  -- Idempotency key for retried sends. Not a row id: row ids are always server-generated.
  client_request_id uuid,
  created_at timestamptz not null default now(),
  constraint messages_role_check
    check (role in ('user', 'assistant')),
  constraint messages_content_check
    check (char_length(btrim(content)) >= 1 and char_length(content) <= 8000),
  -- A user message is never a demo message.
  constraint messages_demo_requires_assistant_check
    check (role = 'assistant' or not is_demo),
  constraint messages_seq_check
    check (seq between 1 and 500),
  constraint messages_conversation_fk
    foreign key (conversation_id, user_id) references public.conversations (id, user_id)
    on delete cascade,
  constraint messages_conversation_seq_key unique (conversation_id, seq),
  -- Target for the saved_items composite foreign key.
  constraint messages_id_conversation_id_key unique (id, conversation_id)
);

-- Idempotency key per user. Deliberately NOT partial: NULLs are distinct in a unique index, so messages sent without
-- a key never conflict, and the leading user_id column also serves the auth.users -> messages.user_id
-- ON DELETE CASCADE lookup (a partial index could not be used for that lookup).
create unique index messages_user_request_key
  on public.messages (user_id, client_request_id);

alter table public.messages enable row level security;

revoke all on table public.messages from anon;
revoke all on table public.messages from authenticated;

grant select on table public.messages to authenticated;
grant insert (conversation_id, role, content, is_demo, client_request_id) on table public.messages to authenticated;

create policy "Users can view their own messages"
on public.messages
for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can append their own messages while history is on"
on public.messages
for insert
to authenticated
with check (
  (select auth.uid()) = user_id
  and (
    (role = 'user' and not is_demo)
    or (role = 'assistant' and is_demo)
  )
  and exists (
    select 1
    from public.user_settings s
    where s.user_id = (select auth.uid())
      and s.save_history
  )
);

-- Assigns seq, bumps the conversation counters and enforces the 500-message cap. The UPDATE takes the
-- conversation row lock, so concurrent inserts serialise and seq is exact and contiguous.
-- SECURITY DEFINER because clients have no UPDATE grant on message_count / last_message_at. It only ever
-- touches the single conversation matching (id, user_id) of the row being inserted, and user_id is
-- fixed by the column default plus the RLS check, so it cannot be steered across tenants.
create or replace function private.messages_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  -- The cap is checked in the WHERE clause so the custom limit error is raised instead of the
  -- conversations_message_count_check violation.
  update public.conversations
     set message_count = message_count + 1,
         last_message_at = pg_catalog.now()
   where id = new.conversation_id
     and user_id = new.user_id
     and message_count < 500
  returning message_count into v_count;

  if not found then
    if exists (
      select 1 from public.conversations
       where id = new.conversation_id
         and user_id = new.user_id
    ) then
      raise exception 'limit_reached' using errcode = 'OL001', hint = 'messages';
    end if;
    raise exception 'conversation not found' using errcode = '23503';
  end if;

  new.seq := v_count;
  return new;
end;
$$;

revoke execute on function private.messages_before_insert() from public, anon, authenticated;

create trigger messages_before_insert
before insert on public.messages
for each row execute function private.messages_before_insert();

create or replace function private.messages_block_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'messages are append-only' using errcode = '42501';
end;
$$;

revoke execute on function private.messages_block_update() from public, anon, authenticated;

create trigger messages_block_update
before update on public.messages
for each row execute function private.messages_block_update();

comment on table public.messages is 'Ombre append-only conversation messages. is_demo marks placeholder assistant replies.';

-- Atomic "new conversation with its first message".
-- Deliberately narrow: SECURITY INVOKER, so every insert runs under the caller's own grants, RLS
-- (user ownership, save_history) and table constraints (lengths, shape, composite project foreign key, caps).
-- It contains no product rules: the role is fixed to a non-demo user message, the title/mentor/project are
-- passed in (the API derives and validates them), and it cannot create assistant messages.
create or replace function public.create_conversation(
  p_title text,
  p_mentor_id text,
  p_project_id uuid,
  p_content text,
  p_client_request_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_conversation public.conversations;
  v_message public.messages;
begin
  insert into public.conversations (title, mentor_id, project_id)
  values (p_title, p_mentor_id, p_project_id)
  returning * into v_conversation;

  insert into public.messages (conversation_id, role, content, is_demo, client_request_id)
  values (v_conversation.id, 'user', p_content, false, p_client_request_id)
  returning * into v_message;

  -- Re-read: the insert trigger updated the counters after the first insert returned.
  select * into v_conversation from public.conversations where id = v_conversation.id;

  return pg_catalog.jsonb_build_object(
    'conversation', pg_catalog.jsonb_build_object(
      'id', v_conversation.id,
      'project_id', v_conversation.project_id,
      'mentor_id', v_conversation.mentor_id,
      'title', v_conversation.title,
      'message_count', v_conversation.message_count,
      'last_message_at', v_conversation.last_message_at,
      'created_at', v_conversation.created_at,
      'updated_at', v_conversation.updated_at
    ),
    'message', pg_catalog.jsonb_build_object(
      'id', v_message.id,
      'conversation_id', v_message.conversation_id,
      'seq', v_message.seq,
      'role', v_message.role,
      'content', v_message.content,
      'is_demo', v_message.is_demo,
      'created_at', v_message.created_at
    )
  );
end;
$$;

revoke all on function public.create_conversation(text, text, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.create_conversation(text, text, uuid, text, uuid) to authenticated;
