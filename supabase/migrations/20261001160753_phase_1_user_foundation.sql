-- Ombre Phase 1: foundational user data and ownership controls.
-- Authentication remains in Supabase Auth (auth.users). Public user data is
-- separated into RLS-protected application tables.

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_display_name_length
    check (display_name is null or char_length(display_name) between 1 and 100)
);

create table public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  theme text not null default 'system',
  remember_context boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_settings_theme_check
    check (theme in ('system', 'light', 'dark'))
);

alter table public.profiles enable row level security;
alter table public.user_settings enable row level security;

-- Do not expose these user-owned tables to unauthenticated clients.
revoke all on table public.profiles from anon;
revoke all on table public.user_settings from anon;

-- Authenticated users can read their own rows and update only mutable fields.
revoke all on table public.profiles from authenticated;
revoke all on table public.user_settings from authenticated;

grant select on table public.profiles to authenticated;
grant update (display_name) on table public.profiles to authenticated;

grant select on table public.user_settings to authenticated;
grant update (theme, remember_context) on table public.user_settings to authenticated;

create policy "Users can view their own profile"
on public.profiles
for select
to authenticated
using ((select auth.uid()) = id);

create policy "Users can update their own profile"
on public.profiles
for update
to authenticated
using ((select auth.uid()) = id)
with check ((select auth.uid()) = id);

create policy "Users can view their own settings"
on public.user_settings
for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can update their own settings"
on public.user_settings
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

-- Keep updated_at controlled by the database rather than client input.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke execute on function public.set_updated_at() from public, anon, authenticated;

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

create trigger user_settings_set_updated_at
before update on public.user_settings
for each row execute function public.set_updated_at();

-- Create the application rows automatically when an Auth user is created.
-- This is intentionally kept in a non-exposed schema and uses a tightly
-- scoped SECURITY DEFINER because auth.users is managed by Supabase Auth.
create schema if not exists private;

create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id)
  values (new.id);

  insert into public.user_settings (user_id)
  values (new.id);

  return new;
end;
$$;

revoke execute on function private.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function private.handle_new_user();

comment on table public.profiles is 'Ombre user-owned profile data linked to Supabase Auth.';
comment on table public.user_settings is 'Ombre user-owned persistent application settings.';
