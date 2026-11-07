-- Extra schema coverage that is deliberately NOT part of the CI-compared fingerprint yet.
--
--   index        every index on a table in the public schema (definition includes uniqueness, partial predicate,
--                NULLS NOT DISTINCT, column order). Covers primary keys, unique constraints and the explicit
--                keyset/idempotency indexes.
--   publication  any public table published for Realtime (A4 uses none). An empty publication is represented by the
--                section being absent.
--
-- Output format matches docs/ops/schema-fingerprint.sql: section | row count | md5 of the sorted rows, plus TOTAL.
-- Read-only: SELECT only. Rows are sorted with collate "C" and contain no oids, timestamps or other volatile values.
--
-- Run against the local stack, or read-only against the live project, to compare:
--   docker exec -i supabase_db_ombre psql -U postgres -At -f - < docs/ops/schema-fingerprint-coverage.sql
--
-- These sections are merged into docs/ops/schema-fingerprint.sql, and docs/ops/schema-fingerprint.expected is
-- regenerated from the live project, in the same change that applies the A4 migrations to production
-- (see docs/ops/a4-schema-fingerprint-pending.md). Until then CI does not read this file.

with r as (
  select 'index'::text sec, i.tablename::text||' '||i.indexname::text||' '||i.indexdef line
    from pg_indexes i where i.schemaname='public'
  union all
  select 'publication', pt.pubname::text||' '||pt.schemaname::text||'.'||pt.tablename::text
    from pg_publication_tables pt where pt.schemaname='public'
)
select coalesce(sec,'TOTAL') as section, count(*) as n, md5(string_agg(line, E'\n' order by line collate "C")) as md5
from r group by rollup(sec) order by sec nulls last;
