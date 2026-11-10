-- Ombre A4, migration 4 of 5: saved_items.
-- A bookmark of a whole conversation (message_id is null) or one message. Separate from Memory.
-- Ownership is transitive and enforced by composite foreign keys: the conversation must belong to the same
-- user, and a message must belong to that conversation.

create table public.saved_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  conversation_id uuid not null,
  message_id uuid,
  created_at timestamptz not null default now(),
  constraint saved_items_conversation_fk
    foreign key (conversation_id, user_id) references public.conversations (id, user_id)
    on delete cascade,
  -- Skipped by MATCH SIMPLE when message_id is null (whole-conversation bookmark).
  constraint saved_items_message_fk
    foreign key (message_id, conversation_id) references public.messages (id, conversation_id)
    on delete cascade,
  constraint saved_items_user_target_key
    unique nulls not distinct (user_id, conversation_id, message_id)
);

create index saved_items_user_created_idx
  on public.saved_items (user_id, created_at desc, id desc);

-- Supports the composite foreign key to messages (ON DELETE CASCADE when a message is deleted with its conversation).
-- Partial: whole-conversation bookmarks have no message_id and never match that foreign key.
create index saved_items_message_idx
  on public.saved_items (message_id, conversation_id)
  where message_id is not null;

alter table public.saved_items enable row level security;

revoke all on table public.saved_items from anon;
revoke all on table public.saved_items from authenticated;

-- Immutable once created: no UPDATE grant or policy.
grant select, delete on table public.saved_items to authenticated;
grant insert (conversation_id, message_id) on table public.saved_items to authenticated;

create policy "Users can view their own saved items"
on public.saved_items
for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can create their own saved items"
on public.saved_items
for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy "Users can delete their own saved items"
on public.saved_items
for delete
to authenticated
using ((select auth.uid()) = user_id);

create trigger saved_items_enforce_row_cap
before insert on public.saved_items
for each row execute function private.enforce_user_row_cap(2000);

comment on table public.saved_items is 'Ombre user bookmarks of conversations or messages. Not Memory.';
