-- Ombre A4, migration 5 of 5: library_items (metadata foundation, read-only for clients).
-- No client write path exists in A4: no UI adds items, uploads and Ombre-generated writes are out of scope.
-- Clients therefore get SELECT only; rows are seeded by the migration owner (tests) until the Library phase.
-- No storage columns: uploads arrive with their own phase.

create table public.library_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  project_id uuid,
  source text not null default 'user',
  kind text not null,
  title text not null,
  preview text not null default '',
  created_at timestamptz not null default now(),
  constraint library_items_source_check
    check (source in ('user', 'ombre')),
  constraint library_items_kind_check
    check (kind in ('note', 'document', 'code', 'image')),
  constraint library_items_title_check
    check (char_length(btrim(title)) between 1 and 200),
  constraint library_items_preview_check
    check (char_length(preview) <= 500),
  -- Deleting the project detaches the item (only project_id is nulled).
  constraint library_items_project_fk
    foreign key (project_id, user_id) references public.projects (id, user_id)
    on delete set null (project_id)
);

create index library_items_user_source_created_idx
  on public.library_items (user_id, source, created_at desc, id desc);

alter table public.library_items enable row level security;

revoke all on table public.library_items from anon;
revoke all on table public.library_items from authenticated;

grant select on table public.library_items to authenticated;

create policy "Users can view their own library items"
on public.library_items
for select
to authenticated
using ((select auth.uid()) = user_id);

comment on table public.library_items is 'Ombre library item metadata. source distinguishes user/reference items from Ombre-generated ones. Read-only for clients in A4.';
