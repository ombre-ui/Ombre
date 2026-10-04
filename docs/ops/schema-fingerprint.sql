-- Schema fingerprint for the objects created by the Ombre migrations.
--
-- Prints one row per object group (section | number of rows | md5 of the sorted rows) plus a TOTAL row.
-- Used by CI to compare a database rebuilt from supabase/migrations with the live baseline recorded in
-- docs/ops/schema-fingerprint.expected. Read-only: SELECT only.
--
-- Run against the LOCAL stack only:
--   docker exec -i supabase_db_ombre psql -U postgres -At -f - < docs/ops/schema-fingerprint.sql
--
-- The expected file is the A1 baseline. When a later migration changes the schema, compute the new
-- fingerprint from the live project (read-only), confirm the local replay matches it, then update
-- docs/ops/schema-fingerprint.expected in the same PR as the migration.

with r as (
  select 'table'::text sec, c.relname::text||' rls='||c.relrowsecurity::text||' force='||c.relforcerowsecurity::text||' owner='||pg_get_userbyid(c.relowner)::text line
    from pg_class c where c.relnamespace='public'::regnamespace and c.relkind='r'
  union all
  select 'column', c.relname::text||'.'||att.attname::text||' '||format_type(att.atttypid,att.atttypmod)||' notnull='||att.attnotnull::text||' default='||coalesce(pg_get_expr(d.adbin,d.adrelid),'')
    from pg_attribute att join pg_class c on c.oid=att.attrelid left join pg_attrdef d on d.adrelid=att.attrelid and d.adnum=att.attnum
    where c.relnamespace='public'::regnamespace and c.relkind='r' and att.attnum>0 and not att.attisdropped
  union all
  select 'constraint', k.conrelid::regclass::text||' '||k.conname::text||' '||pg_get_constraintdef(k.oid)
    from pg_constraint k where k.connamespace='public'::regnamespace
  union all
  select 'policy', p.tablename::text||' '||p.policyname::text||' '||p.permissive||' '||p.roles::text||' '||p.cmd||' '||coalesce(p.qual,'')||' | '||coalesce(p.with_check,'')
    from pg_policies p where p.schemaname='public'
  union all
  select 'tablegrant', c.relname::text||' '||case when a.grantee=0 then 'public' else a.grantee::regrole::text end||' '||a.privilege_type
    from pg_class c cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
    where c.relnamespace='public'::regnamespace and c.relkind='r'
      and (a.grantee=0 or a.grantee::regrole::text in ('anon','authenticated','service_role'))
  union all
  select 'colgrant', c.relname::text||'.'||att.attname::text||' '||a.grantee::regrole::text||' '||a.privilege_type
    from pg_attribute att join pg_class c on c.oid=att.attrelid cross join lateral aclexplode(att.attacl) a
    where c.relnamespace='public'::regnamespace and att.attacl is not null and not att.attisdropped
  union all
  select 'trigger', t.tgrelid::regclass::text||' '||t.tgname::text||' '||pg_get_triggerdef(t.oid)
    from pg_trigger t
    where not t.tgisinternal and (t.tgrelid in ('public.profiles'::regclass,'public.user_settings'::regclass) or t.tgname='on_auth_user_created')
  union all
  select 'function', n.nspname::text||'.'||p.proname::text||' secdef='||p.prosecdef::text||' config='||coalesce(p.proconfig::text,'')||' body_md5='||md5(pg_get_functiondef(p.oid))
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private')
  union all
  select 'funcexec', n.nspname::text||'.'||p.proname::text||' '||case when a.grantee=0 then 'public' else a.grantee::regrole::text end||' '||a.privilege_type
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where n.nspname in ('public','private')
  union all
  select 'defacl', pg_get_userbyid(d.defaclrole)::text||' '||d.defaclobjtype::text||' '||case when a.grantee=0 then 'public' else a.grantee::regrole::text end||' '||a.privilege_type
    from pg_default_acl d cross join lateral aclexplode(d.defaclacl) a
    where d.defaclrole='postgres'::regrole and d.defaclnamespace='public'::regnamespace
  union all
  select 'schema', n.nspname::text||' anon_usage='||has_schema_privilege('anon',n.oid,'USAGE')::text||' authenticated_usage='||has_schema_privilege('authenticated',n.oid,'USAGE')::text
    from pg_namespace n where n.nspname='private'
)
select coalesce(sec,'TOTAL') as section, count(*) as n, md5(string_agg(line, E'\n' order by line collate "C")) as md5
from r group by rollup(sec) order by sec nulls last;
