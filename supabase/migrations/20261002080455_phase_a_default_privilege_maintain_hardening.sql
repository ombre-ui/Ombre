-- Postgres 17 added the MAINTAIN table privilege, which the earlier default
-- privilege hardening did not cover. Remove it so future tables created by the
-- migration owner are not reachable by API roles without an explicit grant.
alter default privileges for role postgres in schema public
  revoke maintain
  on tables from anon, authenticated, service_role;
