# Ombre

An AI intelligence workspace: a General AI, a library of specialized Mentors organized by category, Projects that tie conversations, files and mentors together, History, and Memory, built as one interconnected space rather than a set of separate dashboard pages.

## Current state

- **Frontend:** Vite + React 18 + React Router 6, plain JavaScript. Pages exist for General AI, Mentors (16 mentors in 4 categories: Business, Coding, Productivity, Health), Projects, Library, History, Memory, Profile and Settings.
- **Authentication and a same-origin API exist.** Vercel serverless functions under `api/` provide sign-up, sign-in, sign-out, session, password reset and GitHub OAuth (see `docs/auth.md`, `docs/password-reset.md`, `docs/oauth-github.md`). The browser talks only to `/api/*`; it holds no Supabase credentials and no Supabase client.
- **Profile and settings are server-owned.** `/api/user/profile` and `/api/user/settings` read and write Supabase on the server (see `docs/user-data.md`).
- **A server-side workspace API exists, but the frontend does not call it yet.** `/api/projects`, `/api/conversations`, `/api/saved` and `/api/library` (plus their `/:id` and `/:id/messages` forms) are served by the single function `api/workspace.js` and backed by five tables with row level security. There is no workspace client under `src/lib/`.
- **Conversations, projects, memory and library items in the UI are still session-only.** They live in a reducer (`src/lib/store.jsx`) in React memory, are not written to browser storage (enforced by `scripts/check-browser-storage.mjs`), and are lost on reload. The only browser storage is the validated theme preference cache, `localStorage['ombre-theme']`, where Supabase is authoritative (`docs/user-data.md`).
- **No AI provider is called.** General AI and mentor replies are local placeholders labelled as demo responses.
- **Supabase:** a hosted project with the schema described under Database, plus a deployed `user-context` Edge Function that the frontend does not use.

### Deployment constraints

- Hosting is Vercel on the Hobby plan, which allows at most 12 serverless functions per deployment. `api/` contains exactly 12 deployable functions, pinned by `tests/scripts/function-count.test.js`. New server routes must go through the dispatcher `api/workspace.js` rather than add an `api/*.js` file. Files and directories whose name starts with `_` (for example `api/_lib/`) are helpers, not functions.
- `vercel.json` has exactly three rewrites: two route the workspace URLs to `/api/workspace`, and one is the single-page-app fallback. It also sets the security headers.

## Getting started

```bash
npm install
npm run dev              # Vite dev server (frontend only)
npm run dev:vercel       # Vercel dev server with the API, using vercel-dev.json
npm run build            # production build into dist/ (postbuild scans the bundle for secrets)
npm test                 # storage and UI-wiring checks, then node --test over tests/api, tests/frontend, tests/scripts
npm run test:integration # real-stack suites; needs a local Supabase stack (see below)
```

## Repository layout

```text
api/                    Vercel serverless functions (exactly 12 deployable files) and api/_lib helpers
                        auth/ and user/ routes; workspace.js is the dispatcher for the workspace API
design/                 Design tokens: color, type, motion (source of truth, see design/README.md)
mentor-prompts/         The 16 mentor master prompts. Trusted configuration, not user-editable.
                        Not read by any runtime yet (mentor replies are placeholders).
src/
  main.jsx              Entry point; imports the design tokens globally
  App.jsx               Route definitions
  layout/               Application shell and sidebar navigation
  lib/                  store.jsx (session-only data layer), types.js, theme.js, auth/, user/
  features/             general-ai, mentors, projects, library, history, memory, profile, settings
scripts/                Build-time and test-time checks (bundle secrets, dist assets, browser storage, UI wiring)
tests/                  api/, frontend/, scripts/ (run by npm test) and integration/ (npm run test:integration)
supabase/
  config.toml           Local Supabase CLI stack configuration (local and CI only)
  migrations/           Schema history; the only way the database schema changes
  functions/user-context/  Edge Function source as deployed (read-only user context; unused by the frontend)
  types/database.types.ts  Generated database types (server-side use only)
docs/                   auth.md, oauth-github.md, password-reset.md, user-data.md
docs/ops/               Operational notes: schema-fingerprint.sql and .expected (baseline checked by CI),
                        schema-fingerprint-coverage.sql, a4-schema-fingerprint-pending.md,
                        a5-0-preflight.md
.github/workflows/ci.yml  The active CI workflow (see Continuous integration)
vercel.json, vercel-dev.json  Vercel configuration (production and local dev)
a5-probe.sql            A5.0 Vault/HMAC probe script (see docs/ops/a5-0-preflight.md)
.env.example             Placeholder environment variables (server-only; no real values)
```

## Database

Tables in `public`: `profiles` (display name) and `user_settings` (theme and preferences), plus the five workspace tables `projects`, `conversations`, `messages`, `saved_items` and `library_items`. Row level security is enabled on all of them. `profiles` and `user_settings` have owner-only select and update policies, no insert or delete access for the `authenticated` role, and column-level update grants limited to user-editable columns. A trigger on `auth.users` (function in the non-exposed `private` schema) creates both rows when a user is created. The recorded schema baseline in `docs/ops/schema-fingerprint.expected` covers all seven tables. The workspace tables are described in the A4 migrations and `docs/ops/a4-schema-fingerprint-pending.md`.

Rules for schema changes:

- Every change is a new file in `supabase/migrations/`. Never edit a migration that has already been applied.
- Migrations run as `postgres`. Default privileges for that role grant nothing to API roles, so every new object needs explicit grants in its own migration.
- On the hosted project the Data API exposes the `public` and `graphql_public` schemas (per the recorded dashboard audit). The `private` schema is not exposed and must never be added. The local `supabase/config.toml` mirrors this.

## Local Supabase workflow

Requires Docker and the [Supabase CLI](https://supabase.com/docs/guides/local-development). The CLI reference recommends at least 7 GB of RAM to start all services. CI pins CLI version 3.1.0.

```bash
supabase start        # starts the local stack and applies supabase/migrations
supabase status       # prints the local API URL and keys
supabase db reset     # rebuilds the local database from migrations only
supabase gen types typescript --local --schema public > supabase/types/database.types.ts
supabase stop
```

The committed types were generated from the hosted project. CLI output may differ only in the `PostgrestVersion` line.

## Continuous integration

The workflow is active at `.github/workflows/ci.yml`. It runs on pull requests and pushes to `main` as three independent jobs:

- **Install, build, test, audit:** requires a committed `package-lock.json`, then `npm ci`, `npm run build`, `npm test --if-present`, and `npm audit --omit=dev --audit-level=high`.
- **Secret scan:** gitleaks over the full git history, using the baseline in `.gitleaks-baseline.json`.
- **Supabase:**
  - checks migration file naming and installs Supabase CLI 3.1.0;
  - starts the local stack with up to three bounded attempts (the first two skip services the job does not need);
  - replays all migrations with `supabase db reset`, where a migration SQL error fails immediately and is never retried;
  - checks that the applied migration history matches the files in `supabase/migrations`;
  - compares a schema fingerprint against the recorded baseline (`docs/ops/schema-fingerprint.sql` and `docs/ops/schema-fingerprint.expected`);
  - compares generated types with the committed file;
  - runs `npm run test:integration` with `AUTH_INTEGRATION=1` against the local stack (after the database reset succeeds), and uploads the log as an artifact.

  All of these checks block. When a later migration changes the schema, update the expected fingerprint as described in the header of the SQL file.

Tests use the Node built-in runner (`node --test`); no separate test framework is installed.

## Design principles

- **Sidebar navigates, the main canvas explores.** The sidebar links to the six top-level areas plus Profile and Settings, and never lists individual conversations, projects or mentors.
- **No hardcoded visual values.** Colors, spacing, radius, shadows and animation durations come from the `/design` tokens. If a component needs a new value, add it as a token first.
- **Motion animates relationships, not pages.** See `/design/motion.css` for the motion language.
- **Same brand, different distribution.** The palette matches the marketing site; the product uses it for hierarchy and restraint.

## Known limitations

- Conversations, projects, memory and library items are not persisted; the frontend is not connected to the workspace API yet.
- No AI provider is called.
