# A5.0 preflight

Record of the A5.0 preflight work. It states only what the repository and its history establish, plus the results recorded during the A5.0 runs (marked as such). It does not define A5.1 or any later work.

## Constraints in force

- At most 12 deployable functions under `api/` (Vercel Hobby limit). Exactly 12 exist today.
- `api/workspace.js` is the workspace dispatcher. New server routes go through it, not through a new `api/*.js` file.
- `vercel.json` has exactly three rewrites. Do not add another.
- Existing A4 routing and security behavior is unchanged by the preflight.

## 1. Function-count guard

Commit `feb876f`. `tests/scripts/function-count.test.js` (run by `npm test` through the `tests/scripts` glob):

- counts files under `api/` with extension `.js`, `.mjs`, `.cjs`, `.ts`, `.mts` or `.cts`; any path segment starting with `_` (for example `api/_lib/`) is a helper and is ignored;
- fails if the count exceeds 12;
- fails if the files differ from the pinned list of 12 (`EXPECTED_FUNCTIONS`: nine under `api/auth/`, two under `api/user/`, and `api/workspace.js`), so adding, removing or renaming an API file is a deliberate edit of that list.

## 2. CI integration gate

Commit `158ef73`. In `.github/workflows/ci.yml`, job `supabase`:

- Supabase CLI is pinned to 3.1.0;
- after "Reset database from migrations only" succeeds, the job runs `npm ci` and an "Integration tests" step with `AUTH_INTEGRATION=1`, which runs `npm run test:integration` (auth-flow, user-state, workspace-db and workspace-api suites) against the local stack, reading `API_URL` and `PUBLISHABLE_KEY` from `supabase status -o env`;
- the log is uploaded as the `integration-log` artifact.

Pull request #6 targets `main`.

## 3. Vault/HMAC probe

File `a5-probe.sql` at the repository root. Added in commit `2a2ff3b`; the final content was committed in `c11098e`.

What it is: a single-transaction psql script that ends in `ROLLBACK`. It creates only temporary objects, the schemas `a5_probe` and `a5_probe_private`, and one throwaway Vault secret, all rolled back. It checks, among other things, pgcrypto and supabase_vault are installed; Vault and private objects are not reachable by `anon` or `authenticated`; HMAC-SHA256 from pgcrypto equals an independent RFC 2104 construction over RFC 4231 inputs; a 13-field canonical signing string with commit/settle domain separation and per-field and per-user binding; `verify()` returns false instead of raising on malformed input and propagates internal errors; the iat/exp window rules; SHA-256 over UTF-8 bytes; provider and model validation; reservation uniqueness, lease and idempotent settlement; and a non-early-exit byte comparison.

Recorded result (from the A5.0 run, not re-derived here): 42 PASS, 0 FAIL, 5 INFO; canonical probe SHA-256 `94431e49d1ccc36751937d526033e241557f2cddb29fb0dced64218d2b3cf78d`; `supabase db reset` passed; post-probe integrity query output `11|0|t|t`; database unchanged and rollback verified.

INFO rows in the script cover design points rather than pass/fail checks, for example: whether `service_role` can read the Vault key; that `toWellFormed()` and NUL stripping are client-side JavaScript and are not testable in SQL; that the timing sample is informal and proves nothing; and the approved single leading `@` in model ids (Cloudflare style).

Status of the file: the commit that added it describes it as a temporary A5 probe. It is not referenced by `.github/workflows/ci.yml` or by any `package.json` script. This documentation change leaves it unchanged. Whether it is kept at the root, moved, or removed is not recorded in the repository and is not decided here.

## 4. SSE feasibility spike

Branch `spike/a5-sse` (commits `f520a34`, `d514385`, `b753c10`), created on top of the preflight branch.

- It is a **throwaway feasibility spike**, kept separate. It is **not production code and is not merged** into the preflight branch or `main`. Nothing on this branch depends on it.
- Scope, as recorded from its tests: SSE streaming through the existing Node adapter with progressive delivery; client disconnect propagating as a request abort; streaming error handling; ordinary JSON responses staying buffered; existing adapter contracts, dispatcher routing and the rewrite contract unchanged; still exactly 12 functions. Recorded test results on the spike branch: SSE adapter 6/6, Node adapter 4/4, workspace dispatcher 6/6, pipeline/workspace 6/6, rewrite routing 5/5, function count 10/10, full `npm test` 300/300.
- **Not measured:** no SSE measurement on a Vercel deployment is recorded (for example first-event latency, chunk coalescing, maximum stream duration or heartbeat behavior). The results above come from local tests only.
- No decision to adopt SSE is recorded here.
