# Social sign-in: GitHub and Google (Supabase OAuth)

"Continue with GitHub" and "Continue with Google" on the sign-in / create-account screen use Supabase Auth's own OAuth
flow with PKCE. Ombre implements no OAuth itself and never sees a provider token or client secret. Both providers use
the same route, the same callback and the same session cookie.

## The screen

`/login` and `/signup` render one screen (`src/features/auth/AuthScreen.jsx`):

1. **Continue with Google** (primary), **Continue with GitHub** (secondary), **Continue with email** (fallback).
2. "Continue with email" reveals the email form below an "or" divider. Sign in: Email, Password, Sign in (under
   "Already have an account?"). Create account: Email, Password, Confirm password, Create account.
3. Google and GitHub users never see a password field. Password reset is unchanged.

Email sign-up uses the existing `POST /api/auth/signup`, so whether a confirmation email is required is still decided by
the Supabase "Confirm email" setting (the existing "Check your email" state is shown when the backend answers that way).

## Flow (both providers)

1. The browser calls `POST /api/auth/oauth` with `{ "provider": "google" }` or `{ "provider": "github" }` (exact `Origin` from
   `APP_ORIGINS` plus `X-Ombre-Request`, like every state-changing route). Any other key is rejected.
2. The server calls `supabase.auth.signInWithOAuth({ provider, options: { redirectTo, skipBrowserRedirect: true } })` with the
   per-request `@supabase/ssr` client. `redirectTo` is `<validated request origin>/auth/callback/oauth`, never taken from the
   browser. For Google the server also adds the constant `queryParams: { prompt: 'select_account' }` so Google's own
   account chooser is always shown (GitHub's call is unchanged). The PKCE verifier is stored in the HttpOnly `__Host-` cookie.
   Only Supabase's authorize URL comes back (pinned to the configured `SUPABASE_URL` origin and `/auth/v1/authorize`); the
   browser also refuses other schemes and paths.
3. The browser goes to the provider's own sign-in / account chooser. Ombre builds no account picker.
4. The provider returns to Supabase (`/auth/v1/callback`), which returns to `/auth/callback/oauth?code=...`.
5. `AuthCallbackPage` removes the code from the address bar and exchanges it with `POST /api/auth/callback`
   (`purpose: "oauth"`), which sets the normal Ombre session cookie. The user lands on `/app/general`.

Existing identities sign in. A new identity creates a new Supabase Auth user automatically, and the existing signup trigger
creates their `profiles` and `user_settings` rows. There is no password step and no Ombre email confirmation for OAuth.

## Errors shown to users (no raw provider/Supabase text)

| Situation | Message |
|---|---|
| User cancels at the provider (`error=access_denied`) | Sign-in was cancelled. You can try again whenever you're ready. |
| Invalid/expired OAuth state, or started in another browser | That sign-in expired, or it was started in a different browser. Start again from this one. |
| Other provider/callback failure | Sign-in didn't complete. Try again. |
| Could not start | We couldn't start sign-in with that provider. Try again. |
| Network / outage | Couldn't reach Ombre... / Ombre is temporarily unavailable. |

Provider error descriptions are never displayed or logged, and neither is the authorization code or the authorize URL.

## Manual configuration

### GitHub (already done)
- OAuth App callback URL: `https://qlkukjcrtlutimvilizo.supabase.co/auth/v1/callback`, Homepage `https://ombre-umber.vercel.app`.
- Supabase > Authentication > Providers > GitHub: enabled with that app's Client ID and secret.

### Google (required before the Google button works)

**Google Cloud Console** (console.cloud.google.com, in a project of your choice)
1. APIs & Services > **OAuth consent screen**: user type **External**, app name `Ombre`, support email, developer contact. Scopes:
   the defaults only (`openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`). Add your own address as a test user
   while the app is in *Testing*, then **Publish app** to allow anyone to sign in.
2. APIs & Services > Credentials > **Create credentials > OAuth client ID**, application type **Web application**:
   - Authorized JavaScript origins: `https://ombre-umber.vercel.app` (optional for this server-side flow, harmless to add)
   - **Authorized redirect URIs**: `https://qlkukjcrtlutimvilizo.supabase.co/auth/v1/callback`
3. Copy the **Client ID** and **Client secret**.

**Supabase dashboard** (project `qlkukjcrtlutimvilizo`)
- Authentication > Sign In / Providers > **Google**: enable, paste the Client ID and Client secret, save. Leave "Skip nonce
  checks" off.
- Authentication > URL Configuration: nothing new. **Site URL** `https://ombre-umber.vercel.app` and the Redirect URL
  `https://ombre-umber.vercel.app/auth/callback/oauth` (added for GitHub) are shared by both providers.
- Keep "Allow new users to sign up" on.

**Vercel**: nothing. `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` and `APP_ORIGINS` (exactly `https://ombre-umber.vercel.app`) are
already required. The Google client ID and secret live only in Google Cloud and the Supabase dashboard. Never use a `VITE_`
variable for them and never commit them.

**Local development** (`vercel dev` with `supabase start`): create separate Google/GitHub OAuth clients whose redirect URI is
`http://127.0.0.1:54321/auth/v1/callback`, enable the providers in your local Supabase config with credentials supplied through
environment variables (never committed), set `APP_ORIGINS=http://localhost:3000`, and add
`http://localhost:3000/auth/callback/oauth` to the local redirect allow-list.

If a provider is not enabled in Supabase, the browser lands on a Supabase-hosted error page after the button click (the
start request itself still succeeds). If `/auth/callback/oauth` is not in the Redirect URLs list, Supabase falls back to the Site
URL instead of the callback page. Both are dashboard problems, not code problems.

## Security notes

- Tokens: nothing OAuth-related is stored in `localStorage`/`sessionStorage` (the storage checker still enforces it). The
  session is the existing HttpOnly `__Host-` cookie.
- Account linking: unchanged. Supabase's default identity behaviour applies (for example a verified provider email that matches
  an existing account); Ombre adds no linking policy of its own.
- Providers are allow-listed in `api/_lib/validate.js` (`OAUTH_PROVIDERS`) and mirrored in `src/lib/auth/oauth.js`.
- Vercel functions: unchanged at 10 (`api/auth/oauth.js` serves both providers).

## Tests

`tests/api/oauth-routes.test.js` (GitHub start/callback, CSRF, authorize-URL pinning, error mapping, log hygiene),
`tests/api/oauth-google.test.js` (Google allow-list, start, server-controlled parameters, regression that GitHub is unchanged),
`tests/frontend/oauth.test.js` (URL safety, start request for both providers, return classification) and
`tests/frontend/auth-screen.test.js` (button order and labels, email reveal, sign-up confirmation, copy). Real provider round
trips need the dashboard configuration above and are not covered by automated tests.
