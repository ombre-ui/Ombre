# GitHub sign-in (Supabase OAuth)

"Continue with GitHub" on the sign-in screen uses Supabase Auth's own OAuth flow with PKCE. Ombre implements no OAuth
itself and never sees a GitHub token or client secret.

## Flow

1. The browser calls `POST /api/auth/oauth` with `{ "provider": "github" }` (same CSRF protections as every state-changing
   route: exact `Origin` from `APP_ORIGINS` plus `X-Ombre-Request`).
2. The server calls `supabase.auth.signInWithOAuth({ provider, options: { redirectTo, skipBrowserRedirect: true } })` with the
   per-request `@supabase/ssr` client. `redirectTo` is `<validated request origin>/auth/callback/oauth`. The PKCE verifier is
   stored in the HttpOnly `__Host-` cookie, and only Supabase's authorize URL comes back (pinned to the configured
   `SUPABASE_URL` origin and the `/auth/v1/authorize` path). The browser also refuses other schemes and paths.
3. The browser navigates to GitHub, then GitHub returns to Supabase (`/auth/v1/callback`), then Supabase returns to
   `/auth/callback/oauth?code=...`.
4. `AuthCallbackPage` removes the code from the address bar and exchanges it with the existing `POST /api/auth/callback`
   (`purpose: "oauth"`), which sets the normal Ombre session cookie. The user lands on `/app/general`.

Existing GitHub identities sign in. A new GitHub identity creates a new Supabase Auth user automatically (and the existing
signup trigger creates their `profiles` and `user_settings` rows). There is no password step and no Ombre email
confirmation: Supabase treats the provider-verified email as confirmed.

## Errors shown to users (no raw provider/Supabase text)

| Situation | Message |
|---|---|
| User cancels at GitHub (`error=access_denied`) | Sign-in was cancelled. You can try again whenever you're ready. |
| Invalid/expired OAuth state, or started in another browser | That sign-in expired, or it was started in a different browser. Start again from this one. |
| Other provider/callback failure | Sign-in didn't complete. Try again. |
| Could not start (config/provider problem) | We couldn't start sign-in with that provider. Try again. |
| Network / outage | Couldn't reach Ombre... / Ombre is temporarily unavailable. |

Provider error descriptions are never displayed or logged, and neither is the authorization code or the authorize URL.

## Manual configuration (required before it works)

**1. GitHub** (Settings > Developer settings > OAuth Apps > New OAuth App)
- Homepage URL: `https://ombre-umber.vercel.app`
- Authorization callback URL: `https://qlkukjcrtlutimvilizo.supabase.co/auth/v1/callback`
- Create the app, copy the **Client ID**, generate a **Client secret**.

**2. Supabase dashboard** (project `qlkukjcrtlutimvilizo`)
- Authentication > Sign In / Providers > **GitHub**: enable it, paste the Client ID and Client secret, save.
- Authentication > Sign In / Providers: keep **Allow new users to sign up** on (otherwise new GitHub users cannot be created).
- Authentication > URL Configuration:
  - **Site URL**: `https://ombre-umber.vercel.app`
  - **Redirect URLs** must include `https://ombre-umber.vercel.app/auth/callback/oauth` (also keep `/auth/callback` and
    `/auth/callback/recovery`), or use `https://ombre-umber.vercel.app/**`. For local development add
    `http://localhost:3000/auth/callback/oauth`.

**3. Vercel**: nothing new. `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` and `APP_ORIGINS` (exactly
`https://ombre-umber.vercel.app`) are already required. The GitHub client secret lives only in the Supabase dashboard,
never in Vercel or the frontend.

**Local development** (`vercel dev` with `supabase start`): create a second GitHub OAuth App whose callback URL is
`http://127.0.0.1:54321/auth/v1/callback`, enable `[auth.external.github]` in your local Supabase config with that app's
credentials (supplied via environment variables, never committed), and set `APP_ORIGINS=http://localhost:3000`.

## Security notes

- Tokens: nothing OAuth-related is stored in `localStorage`/`sessionStorage` (the storage checker still enforces it). The
  session is the existing HttpOnly `__Host-` cookie.
- Account linking: if the GitHub email matches an existing Ombre email/password account, Supabase's default identity linking
  applies. Leave Supabase's automatic linking to verified emails only.
- Providers are allow-listed in `api/_lib/validate.js` (`OAUTH_PROVIDERS`). Adding Google later is a one-word change there and in
  `src/lib/auth/oauth.js`, plus the Google provider configuration in Supabase.
- Vercel functions: this adds one function (`api/auth/oauth.js`), for 10 in total.

## Tests

`tests/api/oauth-routes.test.js` (start route, verifier cookie propagation, CSRF, provider allow-list, authorize-URL pinning,
error mapping, log hygiene, callback with `purpose: "oauth"`) and `tests/frontend/oauth.test.js` (URL safety, start request,
return classification). Real GitHub round trips need the dashboard configuration above and are not covered by automated tests.
