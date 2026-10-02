-- Prevent future objects created by the migration owner from becoming
-- automatically reachable through the Data API. Each future object must
-- receive explicit grants as part of its migration.
alter default privileges for role postgres in schema public
  revoke select, insert, update, delete, truncate, references, trigger
  on tables from anon, authenticated, service_role;

alter default privileges for role postgres in schema public
  revoke usage, select, update
  on sequences from anon, authenticated, service_role;

alter default privileges for role postgres in schema public
  revoke execute
  on functions from anon, authenticated, service_role;

alter default privileges for role postgres in schema public
  revoke execute
  on functions from public;
