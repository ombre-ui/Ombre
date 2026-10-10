# User data (A3): profile, settings, theme

Real, server-owned state for the signed-in user. Supabase is the source of truth; the browser only talks to the
same-origin BFF (`/api/user/*`) and never to Supabase. No migration was needed: `public.profiles` and
`public.user_settings` (RLS, column-level grants, signup trigger) already exist.

## Endpoints

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/user/profile` | none | `{ profile: { displayName: string \| null, email: string \| null, createdAt: ISO } }` |
| PATCH | `/api/user/profile` | `{ displayName: string \| null }` | same as GET |
| GET | `/api/user/settings` | none | `{ settings: Settings }` |
| PATCH | `/api/user/settings` | partial nested `Settings` (at least one field) | `{ settings: Settings }` (full, server-confirmed) |

```
Settings = {
  general:       { theme: 'system' | 'light' | 'dark' },
  notifications: { email: boolean, inApp: boolean },
  privacy:       { saveHistory: boolean, rememberContext: boolean },
  ai:            { responseStyle: 'concise' | 'balanced' | 'detailed', useNameInResponses: boolean, suggestMentors: boolean },
}
```

The wire format is nested (it mirrors the settings UI); the BFF maps it to flat snake_case columns in
`api/_lib/userData.js`. `email` is read from the validated session and is read-only.

`displayName`: trimmed, NFC-normalized, one line (no control characters), 1 to 100 characters counted as
characters (not UTF-16 units). Empty or whitespace-only (or `null`) clears the name.

## Errors

Generic bodies only: `{ error: { code, message, requestId } }`.

| Status | code | When |
|---|---|---|
| 400 | `invalid_request` | bad JSON; unknown top-level, section or field; wrong type or enum; empty patch; control characters; over-length name |
| 401 | `unauthenticated` | no valid session (also an invalid-JWT answer from the data API) |
| 403 | `forbidden` | cross-site request, bad Origin, or missing `X-Ombre-Request` on PATCH |
| 404 | `not_found` | the user's profile/settings row does not exist (zero rows). It is never created here |
| 405 | `method_not_allowed` | anything but GET/PATCH (`Allow: GET, PATCH`) |
| 413 / 415 | `payload_too_large` / `unsupported_media_type` | body over 4 KiB / PATCH not `application/json` |
| 503 | `service_unavailable` | auth server or database unreachable or 5xx. Retryable, and deliberately not 401 |
| 500 | `internal_error` | anything else (permission, constraint, unexpected). Details are logged by name/status/code only |

## Security model

- **Authenticate server-side**: every request calls `supabase.auth.getUser()` (`requireUser` in `api/_lib/user.js`).
  The user id comes only from that verified session. A client-supplied id is never read, and `id`/`user_id`
  in a body is a 400.
- **Two independent ownership checks**: queries filter on the session user's id *and* run with the user's own JWT
  and the publishable key, so RLS applies. There is no service-role key in this path.
- **Explicit allowlists**: a body is never spread into a query. Writable columns exist only in
  `SETTINGS_FIELDS` and `profiles.display_name` in `userData.js`, which must equal the column-level `UPDATE`
  grants in the migrations (`tests/api/user-data.test.js` fails if they drift). Reads use explicit column lists,
  never `select('*')`.
- **No insert, no upsert**: `authenticated` has no INSERT grant. Rows come from the signup trigger. Zero rows from
  an update is an explicit 404, never success.
- **Pipeline unchanged for A2 routes**: Origin + `X-Ombre-Request` on PATCH, exact Origin match, 4 KiB limit,
  unknown keys rejected, `no-store`, request ids, redacted logs, and `Set-Cookie` propagation (also on error responses).
  The only pipeline change: `options.body` may be a per-method map (`{ PATCH: [...] }`) so GET needs no body or
  content-type. The existing array form behaves exactly as before.

## Client

- `src/lib/user/UserStateProvider.jsx` (mounted only inside `RequireAuth`, keyed by user id) loads profile and
  settings. While loading or after a failed load the UI shows an honest loading/error state with a retry; there are
  no fabricated defaults.
- Edits are optimistic but safe: the shown value is the last server-confirmed value plus still-pending patches, so
  a failed save disappears from the screen. Pages say so with a toast.
- All profile/settings requests share one serial queue (`userApi.js`). A failure never blocks later requests. A 401
  re-validates the session once (`AuthProvider.refresh`, single-flight) and retries that request at most once.
- **Theme**: Supabase is authoritative. `localStorage['ombre-theme']` is only a validated pre-hydration cache of the
  *preference* (`system|light|dark`). It is applied before React renders, written only after the server confirms a
  value, and corrected when the real setting loads. `system` follows the OS (`prefers-color-scheme`) live.
- To add another user-scoped resource: add a table-scoped route using `requireUser` + `oneRow`, an explicit
  allowlist module like `userData.js`, and a resource hook like `useUserResource`.

## What is still demo/session-only

Conversations, projects, memory items and the library live in `src/lib/store.jsx`, in React memory only. They start
empty, are never written to browser storage (enforced by `scripts/check-browser-storage.mjs`), and are lost on reload.
The UI labels them (`PreviewNotice`). General AI replies are placeholders (`message.demo === true`, shown as
"Demo response"), never model output. The retired `ombre-mock-data-v1` key is removed on startup.

## Tests

`npm test` covers the endpoints (fake data API), the pipeline option, validators, theme cache, the serial queue,
401 retry-once, optimistic merge and the storage checker. `npm run test:integration` (needs `supabase start` and
Mailpit) runs the real-stack suites including `tests/integration/user-state.test.js` (two-user isolation, RLS and
column-grant checks).
