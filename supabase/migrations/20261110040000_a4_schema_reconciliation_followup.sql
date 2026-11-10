-- Follow-up to 20261109150000_a4_schema_reconciliation.sql.
-- Forward-only; no user data is modified. Every statement converges to the canonical A4 definition from
-- migrations 20261020120100 and 20261020120200, so it is a no-op on a database rebuilt from the migration chain and
-- repairs the remaining drift on a database that was created from an earlier, divergent copy of those migrations.
--
-- Remaining drift this migration removes:
--   1. conversations.title default: '' (cannot satisfy conversations_title_check) -> 'Untitled conversation'.
--   2. conversations_user_last_message_idx: DESC NULLS LAST -> DESC, so it serves ORDER BY last_message_at DESC.
--   3. The conversations INSERT policy expression: alias and "= true" spelling -> canonical expression.
--   4. private.messages_before_insert() and public.create_conversation(): function bodies recreated verbatim
--      (the earlier copy had the comments stripped, and the body text is part of the schema fingerprint).

alter table public.conversations
  alter column title set default 'Untitled conversation';

drop index public.conversations_user_last_message_idx;
create index conversations_user_last_message_idx
  on public.conversations (user_id, last_message_at desc, id desc);

alter policy "Users can create their own conversations while history is on"
on public.conversations
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1
    from public.user_settings s
    where s.user_id = (select auth.uid())
      and s.save_history
  )
);

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
