# Authentication and session (A2)

Architecture: Vite + React SPA, same-origin `/api/*` Vercel Functions (the BFF), `@supabase/ssr` on the server only.
The browser never talks to Supabase, never holds auth tokens and never sees a Supabase key.

## Cookies
| | production / staging (HTTPS) | local (`vercel dev`, http://localhost:3000) |
|---|---|---|
| name | `__Host-ombre-auth` (+ `.0`, `.1` chunks, PKCE verifier cookies) | `ombre-auth…` |
| attributes | `HttpOnly; Secure; Path=/; SameSite=Lax`, no `Domain` | same, without `Secure` |
| lifetime | session 30 days max, PKCE verifier 1 hour max | same |

Every Set-Cookie is rebuilt in `api/_lib/cookies.js`; attributes passed by `@supabase/ssr` are never trusted.
Unprefixed/insecure cookies are only possible when every `APP_ORIGINS` entry is an `http://localhost` origin
and the runtime is `vercel dev` (or `AUTH_ALLOW_INSECURE_COOKIES=true`). Production refuses local origins.

## Endpoints (all `Cache-Control: private, no-store`)
| route | purpose |
|---|---|
| `GET /api/auth/session` | `{user:{id,email}}` or `{user:null}`; authorizes with `getUser()`; refresh/rotation happens here |
| `POST /api/auth/signup` | PKCE sign-up; identical answer whether or not the address exists |
| `POST /api/auth/signin` | password sign-in; generic errors |
| `POST /api/auth/signout` | local-scope revoke + expire every auth cookie |
| `POST /api/auth/forgot-password` | PKCE recovery email; always the same answer |
| `POST /api/auth/callback` | PKCE code exchange (`{code, purpose?, flowId?}`); server decides `next` |
| `POST /api/auth/reset-password` | requires a validated session; 12+ characters |

## Request protection
Non-GET: exact `Origin` match against `APP_ORIGINS` + `X-Ombre-Request: 1`; `Sec-Fetch-Site: cross-site` rejected for
all methods; JSON only; 4 KiB body limit; unknown JSON keys rejected; generic errors with a request ID; redacted logs.

## PKCE notes
* Email links work only in the browser that requested them (the verifier cookie is HttpOnly in that browser).
  Other browser -> `link_wrong_browser`.
* `sb_flow_id` (per-flow verifier slots) is `experimental.appendPkceFlowIdToRedirects` in supabase-js 2.117.x and is
  NOT enabled. Without it only the most recently started flow in a browser can be completed. The callback route and
  SPA already forward `flowId` if it is ever present.
* Signup confirmation resend = sign up again with the same email (resend() has no PKCE support).

## Local development
`cp .env.example .env.local`, fill `SUPABASE_URL`/`SUPABASE_PUBLISHABLE_KEY` from `supabase status`, then
`npm run dev:vercel` (port 3000). Emails appear in the local mail catcher (http://127.0.0.1:54324).

## Checks
`npm test` (storage scan + unit tests), `npm run build` (runs the bundle secret scan), `npm run test:integration`
(needs a running local Supabase stack).
