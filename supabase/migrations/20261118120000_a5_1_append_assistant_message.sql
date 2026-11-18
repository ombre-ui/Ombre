-- Ombre A5.1 (S3): public.append_assistant_message(), the narrow server-side writer for a genuine assistant reply.
--
-- Why a function: the messages INSERT policy (A4 migration 3) only lets `authenticated` insert
-- (role = 'user', is_demo = false) or (role = 'assistant', is_demo = true). A genuine reply is
-- (role = 'assistant', is_demo = false), so it cannot be written under the caller's own grants. The service-role key is not used
-- anywhere in this project, and the INSERT policy is deliberately NOT widened: a policy branch would let any
-- user insert any number of genuine-looking assistant rows anywhere in their data. This function instead enforces
-- ordering invariants (a reply only directly after the latest user message, at most once per user message).
--
-- SECURITY DEFINER, owner = the migration role (the table owner, so it is not subject to RLS; there is no FORCE ROW LEVEL
-- SECURITY). Because RLS is bypassed, every check RLS would have made is repeated here explicitly: caller identity,
-- conversation and message ownership, and the caller's current user_settings.save_history, which is required for BOTH
-- paths (writing a new reply and replaying an existing one). Table constraints still apply to the insert
-- (role, content length 1..8000 after btrim, seq 1..500, composite foreign key) and so does the insert trigger
-- (contiguous seq, 500-message cap via OL001).
--
-- Idempotency is structural: no client_request_id is written (NULL). The conversation row lock plus the existing
-- unique (conversation_id, seq) guarantee at most one reply per user message; a call for a user message that already
-- has its genuine reply at seq + 1 returns that reply with replayed = true (still subject to save_history).
--
-- Errors (SQLSTATE):
--   28000  no authenticated user (auth.uid() is null)
--   22023  a null argument
--   23503  conversation or message not found, or not owned by the caller (indistinguishable on purpose)
--   OL002  (custom) the target is not a persisted non-demo user message, or is not the latest message and has no
--          genuine reply at seq + 1; S4 maps this to HTTP 409
--   42501  save_history is off or the settings row is missing (checked before both the write and the replay)
--   OL001  500-message cap (raised by the insert trigger)
--   23514  content violates messages_content_check (raised by the table, not replaced here)
--
-- KNOWN A5.1 LIMITATION. This is NOT a provenance mechanism. PostgREST exposes the function to every signed-in user,
-- and the function cannot tell content produced by the BFF from content the user wrote. An authenticated user can call
-- it directly and store an assistant message of their own choosing, but only: in their own conversation, directly after
-- the latest user message, once per user message, with history on, within the existing size and count caps. The
-- A5.3 signed commit-token design closes this. The A4 statement "no path that mints non-demo assistant messages
-- exists" therefore ends with A4; this migration adds exactly one such path. Neither the function nor the database
-- prevents duplicate provider calls; that is also an A5.3 concern.
-- The provider call must never happen inside this function or while its lock is held (it contains none).

create or replace function public.append_assistant_message(
  p_conversation_id uuid,
  p_user_message_id uuid,
  p_content text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_count integer;
  v_target public.messages;
  v_message public.messages;
  v_replayed boolean := false;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  if p_conversation_id is null or p_user_message_id is null or p_content is null then
    raise exception 'invalid arguments' using errcode = '22023';
  end if;

  -- Serialise with every other writer of this conversation: the messages insert trigger takes the same row lock.
  select c.message_count
    into v_count
    from public.conversations c
   where c.id = p_conversation_id
     and c.user_id = v_uid
     for update;

  if not found then
    raise exception 'conversation not found' using errcode = '23503';
  end if;

  select m.*
    into v_target
    from public.messages m
   where m.id = p_user_message_id
     and m.conversation_id = p_conversation_id
     and m.user_id = v_uid;

  if not found then
    raise exception 'message not found' using errcode = '23503';
  end if;

  if v_target.role <> 'user' or v_target.is_demo then
    raise exception 'target is not a user message' using errcode = 'OL002', hint = 'wrong_target';
  end if;

  -- The current history setting gates both paths: with history off nothing is written and nothing is returned.
  -- A missing settings row fails closed.
  if not exists (
    select 1
      from public.user_settings s
     where s.user_id = v_uid
       and s.save_history
  ) then
    raise exception 'history is off' using errcode = '42501';
  end if;

  if v_count = v_target.seq then
    -- The target is the latest message: write the reply (this branch is the only write).
    insert into public.messages (conversation_id, user_id, role, content, is_demo)
    values (p_conversation_id, v_uid, 'assistant', p_content, false)
    returning * into v_message;
  else
    -- Not the latest: only a genuine reply directly after the target makes this a replay.
    select m.*
      into v_message
      from public.messages m
     where m.conversation_id = p_conversation_id
       and m.user_id = v_uid
       and m.seq = v_target.seq + 1
       and m.role = 'assistant'
       and not m.is_demo;

    if not found then
      raise exception 'target is not the latest message' using errcode = 'OL002', hint = 'stale_target';
    end if;

    v_replayed := true;
  end if;

  return pg_catalog.jsonb_build_object(
    'replayed', v_replayed,
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

revoke all on function public.append_assistant_message(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.append_assistant_message(uuid, uuid, text) to authenticated;

comment on function public.append_assistant_message(uuid, uuid, text) is
  'A5.1 writer for a genuine assistant reply (role assistant, is_demo false) directly after the caller''s latest user message; returns {replayed, message}. SECURITY DEFINER; repeats the ownership and save_history checks RLS would make, and requires save_history = true for both a new reply and a replay. KNOWN LIMITATION: not a provenance mechanism. Any authenticated user can call it directly for their own eligible conversation and store assistant text of their choosing; the A5.3 signed commit-token design closes this. It does not prevent duplicate provider calls.';
