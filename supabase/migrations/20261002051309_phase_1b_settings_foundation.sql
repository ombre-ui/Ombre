
alter table public.user_settings
  add column notifications_email boolean not null default true,
  add column notifications_in_app boolean not null default true,
  add column save_history boolean not null default true,
  add column response_style text not null default 'balanced',
  add column use_name_in_responses boolean not null default false,
  add column suggest_mentors boolean not null default true;

alter table public.user_settings
  add constraint user_settings_response_style_check
  check (response_style in ('concise', 'balanced', 'detailed'));

grant select on table public.user_settings to authenticated;
grant update (
  theme,
  remember_context,
  notifications_email,
  notifications_in_app,
  save_history,
  response_style,
  use_name_in_responses,
  suggest_mentors
) on table public.user_settings to authenticated;
