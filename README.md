# Ombre

An AI intelligence workspace: a General AI, a library of specialized Mentors organized by category, Projects that tie conversations, files and mentors together, History, and Memory, built as one interconnected space rather than a set of separate dashboard pages.

## Current state

- **Frontend:** Vite + React 18 + React Router 6, plain JavaScript. Pages exist for General AI, Mentors (16 mentors in 4 categories: Business, Coding, Productivity, Health), Projects, Library, History, Memory, Profile and Settings.
- **Data is mock.** Conversations, projects, library items, memory, profile and settings live in a reducer (`src/lib/store.jsx`) and are persisted to the browser's `localStorage`. Assistant replies are generated locally. No AI provider is called.
- **No authentication and no API.** There is no login, no session and no server-side code in this repository.
- **Supabase foundation (not used by the frontend yet):** a hosted Supabase project has `profiles` and `user_settings` tables with row level security, plus a deployed `user-context` Edge Function. Nothing in `src/` talks to Supabase.

### Planned direction (not implemented yet)

Hosting on Vercel with a same-origin `/api/*` layer that talks to Supabase on the server and keeps the session in HttpOnly cookies. The browser will not hold Supabase credentials or a Supabase client.

## Getting started

```bash
npm install
npm run dev      # Vite dev server
npm run build    # production build into dist/
npm run preview  # serve the production build locally
```

## Repository layout

```
design/                 Design tokens: color, type, motion (source of truth, see design/README.md)
mentor-prompts/         The 16 mentor master prompts. Trusted configuration, not user-editable.
                        Not read by any runtime yet (mentor replies are mocked).
src/
  main.jsx              Entry point; imports the design tokens globally
  App.jsx               Route definitions
  layout/               Application shell and sidebar navigation
  lib/                  store.jsx (mock data layer), types.js (data shapes)
  features/             general-ai, mentors, projects, library, history, memory, profile, settings
supabase/
  config.toml           Local Supabase CLI stack configuration (local and CI only)
  migrations/           Schema history; the only way the database schema changes
  functions/user-context/  Edge Function source as deployed (read-only user context; unused by the frontend)
  types/database.types.ts  Generated database types (server-side use only)
docs/ops/ci.yml.pending CI workflow staged for installation (see Continuous integration)
.env.example            Placeholder environment variables (server-only; no real values)
```

## Database

Tables in `public`: `profiles` (display name) and `user_settings` (theme and preferences). Both have row level security enabled with owner-only select and update policies, no insert or delete access for the `authenticated` role, and column-level update grants limited to user-editable columns. A trigger on `auth.users` (function in the non-exposed `private` schema) creates both rows when a user is created.

Rules for schema changes:

- Every change is a new file in `supabase/migrations/`. Never edit a migration that has already been applied.
- Migrations run as `postgres`. Default privileges for that role grant nothing to API roles, so every new object needs explicit grants in its own migration.
- Only `public` is exposed through the Data API.

## Local Supabase workflow

Requires Docker and the [Supabase CLI](https://supabase.com/docs/guides/local-development).

```bash
supabase start        # starts the local stack and applies supabase/migrations
supabase status       # prints the local API URL and keys
supabase db reset     # rebuilds the local database from migrations only
supabase gen types typescript --local --schema public > supabase/types/database.types.ts
supabase stop
```

The committed types were generated from the hosted project. CLI output may differ only in the `PostgrestVersion` line.

## Continuous integration

The workflow is staged at `docs/ops/ci.yml.pending` and is **not active yet**: the automation that prepared this change cannot write to `.github/workflows/`. To enable it, move the file to `.github/workflows/ci.yml` and commit it.

Once active it runs on pull requests and pushes to `main`:

- **Install, build, test, audit:** `npm ci`, `npm run build`, `npm test --if-present`, and `npm audit` for production dependencies (high severity and above). Requires a committed `package-lock.json`, which does not exist yet.
- **Secret scan:** gitleaks over the full git history.
- **Supabase:** starts the local stack, replays all migrations with `supabase db reset`, and compares generated types with the committed file. The type comparison is advisory for now.

There is no test framework yet.

## Design principles

- **Sidebar navigates, the main canvas explores.** The sidebar links to the six top-level areas plus Profile and Settings, and never lists individual conversations, projects or mentors.
- **No hardcoded visual values.** Colors, spacing, radius, shadows and animation durations come from the `/design` tokens. If a component needs a new value, add it as a token first.
- **Motion animates relationships, not pages.** See `/design/motion.css` for the motion language.
- **Same brand, different distribution.** The palette matches the marketing site; the product uses it for hierarchy and restraint.

## Known follow-ups

- The theme preference is stored in `localStorage` (key `ombre-theme`) and defaults to the system preference. Server-side sync is not built.
