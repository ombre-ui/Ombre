# A4 schema fingerprint, generated types and integration tests: pending items

Status: **Option A.** The recorded fingerprint (`docs/ops/schema-fingerprint.expected`) is the live A3 schema and stays
authoritative. The A4 migrations are intentionally **not applied to production**, so the CI step "Schema fingerprint
matches the live baseline" is **intentionally red** on any branch that contains them. CI is not changed to accept the
A4 replay, and the expected file is not updated, until production contains the A4 schema.

## Expected A4-vs-A3 differences

A4 adds five tables and their objects. Counts below are the CI-compared fingerprint (`schema-fingerprint.sql`, which
now fingerprints triggers on every public table). They were derived by statically reading the five A4 migration files
and are to be confirmed against the CI output and against the live project after the migration is applied.

| Section | A3 baseline (live) | A4 replay (predicted) | A4 additions |
|---|---|---|---|
| table | 2 | 7 | projects, conversations, messages, saved_items, library_items |
| column | 15 | 53 | 38 |
| constraint | 7 | 40 | 33 (primary keys, foreign keys incl. composite, CHECKs, uniques) |
| policy | 4 | 18 | 14 |
| tablegrant | 18 | 26 | 8 |
| colgrant | 9 | 26 | 17 (column-level insert/update grants) |
| trigger | 3 | 10 | 7 (row caps, updated_at, messages insert/seq trigger, messages update guard) |
| function | 2 | 6 | 4 (3 in `private`, plus `public.create_conversation`) |
| funcexec | 3 | 8 | 5 |
| defacl | 12 | 12 | none (no default-privilege change) |
| schema | 1 | 1 | none |
| **TOTAL** | **76** | **207** | +131 |

No A3 object is altered by the A4 migrations: they only create new objects, enable RLS on their own tables, and read
`public.user_settings` inside policy subqueries. The four A3 migration files are byte-identical on `main` and on the
branch.

### Coverage not yet in the CI-compared fingerprint

`docs/ops/schema-fingerprint-coverage.sql` (not read by CI) fingerprints indexes and Realtime publication membership.
Live A3 values: `index|2|ee150a218b04609e5bfd9c34e87f8419`, no `publication` rows (an empty publication is an absent
section). Predicted A4 replay: **20** index rows (2 + 5 primary keys + 5 unique-constraint indexes + 8 explicit
indexes), and still no `publication` rows (A4 uses no Realtime). The 8 explicit indexes are `projects_user_updated_idx`,
`conversations_user_last_message_idx`, `conversations_project_last_message_idx` (partial keyset),
`messages_user_request_key` (unique, **non-partial** so its leading `user_id` also serves the `auth.users` cascade),
`saved_items_user_created_idx`, `saved_items_message_idx` and `library_items_project_idx` (both foreign-key support,
partial on `... is not null`), and `library_items_user_source_created_idx`. `tests/scripts/a4-fk-indexes.test.js`
statically checks that every foreign key on an A4 table has a covering index.

## Runbook for the deferred live migration (after PR review and your explicit approval)

1. Run the A4 integration suites (below) against a local stack and get them green.
2. Apply the five A4 migrations to the live project one at a time, verifying schema, advisors and fingerprint after each.
3. Run `schema-fingerprint.sql` and `schema-fingerprint-coverage.sql` read-only against the live project.
4. Confirm a local replay produces the same output.
5. In one change: merge the `index` and `publication` sections of the coverage file into `schema-fingerprint.sql`,
   regenerate `schema-fingerprint.expected` from the live output, and update the pinned snapshot in
   `tests/scripts/fingerprint-sql.test.js` (its guard test exists to make this a deliberate step).
6. Regenerate `supabase/types/database.types.ts` (see below) so the type-drift step passes.
7. Deploy the API code, then the frontend, then run the two-account smoke test.

## A4 integration tests (real database)

Two suites run against the real local stack and are skipped unless `AUTH_INTEGRATION=1` (`npm run test:integration` runs
them together with the A2/A3 suites):

- `tests/integration/workspace-db.test.js` drives the real Postgres container (`docker exec ... psql`) as `anon`,
  `authenticated` (with `request.jwt.claims`, as PostgREST does) and the owner: isolation, spoofed `user_id`, cross-tenant
  composite FKs, column grants, forged assistant/demo rows, append-only, anonymous and private-function denial, per-user
  and 500-message caps, concurrent sequence numbers, `save_history`, `create_conversation` atomicity, idempotency,
  project/conversation/account deletes, library read-only, and grant/function-privilege catalog checks.
- `tests/integration/workspace-api.test.js` runs the real workspace routes against real PostgREST with two real signed-in
  users: embedded conversation count, referenced-table filter/order/limit on messages, keyset pagination with equal
  timestamps, end-to-end idempotency, cross-tenant 404s, the `save_history` gate through the real settings route, saved
  items, library read-only, and cascades.

They have to run where Docker and the Supabase CLI exist: `supabase start && supabase db reset && npm run test:integration`.
CI already starts exactly that stack in the `supabase` job, but running them there needs one workflow step, and the
integration used for this branch cannot edit `.github/workflows/` (403). Exact step, for someone with workflow access, to
add to job `supabase` after "Reset database from migrations only" (and it may use the same `if:` as the types step so it
also runs while the fingerprint step is red):

```yaml
      - name: A4 integration tests (real Postgres and PostgREST)
        if: ${{ !cancelled() && steps.reset.outcome == 'success' }}
        env:
          AUTH_INTEGRATION: '1'
        run: |
          eval "$(supabase status -o env | sed 's/^/export /')"
          export SUPABASE_URL="${API_URL}" SUPABASE_PUBLISHABLE_KEY="${ANON_KEY}"
          node --test tests/integration/workspace-db.test.js tests/integration/workspace-api.test.js
```

The `supabase status -o env` variable names depend on the CLI version (`ANON_KEY` / `PUBLISHABLE_KEY`); the existing
auth integration job or `docs/auth.md` shows which pair the A2/A3 suites use. As of this writing neither suite has been
executed anywhere.

## Generated-types check (pending)

The type-drift step cannot report while the fingerprint step is red, because the steps run in order. The workflow
cannot be changed through the integration used for this branch (GitHub answers 403 "Resource not accessible by
integration" for any push to `.github/workflows/`), so the change is recorded here for someone with workflow access.
It does not weaken any pass/fail condition: the job still fails if the fingerprint step or the types step fails.

In `.github/workflows/ci.yml`, job `supabase`:

```diff
       - name: Reset database from migrations only (bounded retry)
+        id: reset
         run: |
...
       - name: Generated types match committed types
+        # Runs even when the fingerprint step failed (but not when the local database was never built), so
+        # type drift can be diagnosed independently. A failure in either step still fails the job.
+        if: ${{ !cancelled() && steps.reset.outcome == 'success' }}
         run: |
...
             ${{ runner.temp }}/types-cli-version.txt
+            ${{ runner.temp }}/fingerprint.actual
```

The repository has no local command for the comparison: it exists only inline in the workflow. To diagnose locally you
need Docker and the Supabase CLI:

```
supabase start
supabase db reset
supabase gen types typescript --local --schema public > /tmp/database.types.generated.ts
```

and then the normalise-and-diff script from the workflow step. Extracting that script into `scripts/` would let it run
outside CI; that is a workflow change and is deferred with the one above.
