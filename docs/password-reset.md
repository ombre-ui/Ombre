# Password reset by 7-digit code

Email/password users reset a forgotten password with a one-time 7-digit code. It is a thin layer over Supabase Auth's own
recovery OTP. Ombre has no second credential or session system.

## Flow

1. **Sign in > Password > "Forgot password?"** opens `/forgot-password`.
2. **Email step.** The user enters an email. The page always says: "If an account exists for this email, we'll send a reset
   code." `POST /api/auth/reset-code` `{ action: "request", email }` answers `{ ok: true }` for every outcome.
3. **Code step.** The user enters the 7-digit code from the email. `POST /api/auth/reset-code`
   `{ action: "verify", email, code }` calls `supabase.auth.verifyOtp({ email, token, type: "recovery" })`. On success the normal
   HttpOnly session cookie is set and the browser goes to `/reset-password`.
4. **New password step** (existing page): New password, Confirm new password, **Reset password**. It uses the existing
   `POST /api/auth/reset-password` (`updateUser`) and then opens `/app/general`.

The code travels only in POST bodies. It is never in a URL, cookie, browser storage or log line, and the email contains the code
only (no link). The older link-based `/auth/callback/recovery` route is left in place but is no longer used by the UI.

## What Supabase Auth does (native; configure it, do not re-implement it)

| Requirement | Provided by |
|---|---|
| Cryptographically random 7-digit code | Supabase **Email OTP Length** = 7 |
| Stored as a hash, not plaintext | GoTrue stores a hashed recovery token |
| Single use | the token is consumed by a successful `verifyOtp` |
| Expires after 60 minutes | **Email OTP Expiration** = 3600 s |
| A new code invalidates the previous one | issuing a recovery email overwrites the stored token |
| Cooldown between requests | per-user minimum interval (default 60 s) |
| Email send limits | Supabase email rate limits / your SMTP provider |
| Delivery | the "Reset Password" email template |

## What the app layer adds (`api/_lib/routes.js` `resetCode`, `api/_lib/limiter.js`)

- **Neutral responses.** Success, "no such user", provider errors, cooldowns and per-email caps all return the identical
  `{ "ok": true }`. Only a pure connectivity failure is surfaced (503), and that does not depend on the account.
- **No password path for OAuth-only accounts.** After `verifyOtp` succeeds, the account must have an `email` identity
  (`app_metadata.providers`, falling back to `identities`). Google/GitHub-only accounts get the same generic failure as a wrong
  code, their session is signed out and any cookie set in that request is cancelled (`expireAllAuthCookies` now also cancels cookies
  written earlier in the same request). Unknown shapes are refused.
- **Best-effort limits** (per warm serverless instance): 1 request/min and 5/hour per email, 10 requests/hour per IP; 5 verification
  attempts per email per hour (a new code resets the budget, a success clears it), 20 attempts per 15 minutes per IP. All keys are
  SHA-256 hashes, and blocked attempts are not recorded.
- Generic error copy: "That code isn't right, or it has expired. Check it, or request a new one."
- Same protections as every other route: exact Origin, `X-Ombre-Request`, 4 KiB body cap, strict body keys, `no-store`.

## Be clear about the limits of the app-level limiter

The in-memory limiter is **defense in depth, not the control that makes the 7-digit code safe**:

- Serverless instances do not share memory, so the caps are per instance, not global.
- Supabase Auth's `/verify` endpoint is public (anyone can call it with the publishable key), so an attacker can skip Ombre's API
  entirely. App-level counters cannot stop that. What does is Supabase's own configuration: the code's entropy, the expiry, and the
  token-verification and email rate limits below.
- A strictly global per-email lockout would need shared server-side state (for example a Postgres table written with a server-only
  secret key, or a Redis/KV store). That adds new infrastructure, a migration and a secret, so it was **not** added here. Decide
  whether you want it before public launch.

## Supabase dashboard configuration (required)

Project `qlkukjcrtlutimvilizo`:

1. **Authentication > Sign In / Providers > Email** (or Auth > Emails settings, depending on dashboard version):
   - **Email OTP Length: 7**
   - **Email OTP Expiration: 3600** seconds
   (If your dashboard does not show the length setting, it is the Auth config value `GOTRUE_MAILER_OTP_LENGTH` / `auth.email.otp_length`.)
2. **Authentication > Emails > Templates > "Reset Password"**: replace the body so it contains the code and **no link**. Do not use
   `{{ .ConfirmationURL }}`. Example:
   ```html
   <h2>Reset your Ombre password</h2>
   <p>Your 7-digit code is:</p>
   <p style="font-size:24px;letter-spacing:4px"><strong>{{ .Token }}</strong></p>
   <p>It expires in 60 minutes and can be used once. If you didn't ask for this, you can ignore this email.</p>
   ```
   Subject suggestion: `Your Ombre password reset code`.
3. **Authentication > Rate Limits**: keep "token verifications" at or below the default (30 per 5 minutes per IP) and review the
   email send limits. All requests from Ombre reach Supabase from Vercel's egress addresses, so choose values with that in mind.
4. **Authentication > Emails > SMTP Settings**: configure a **custom SMTP provider**. Supabase's built-in mailer is heavily rate-limited
   and only meant for testing, so real users will not reliably receive codes without it. Keep the per-user minimum interval at 60 s.

No Vercel environment variable changes. No new Supabase keys. No schema change.

## Testing and what is not covered

`tests/api/reset-code.test.js`, `tests/api/limiter.test.js` and `tests/frontend/reset-flow.test.js` cover the request and verify
routes, neutral responses, cooldown and rate limits, attempt lockout, code format, expiry and single-use mapping, the OAuth-only
refusal and its cookie cancellation, CSRF, log hygiene and the screens' source structure.

Not covered by automated tests (needs a real Supabase project and mailbox): that Supabase actually emails a 7-digit code, that it
expires after 60 minutes, that it is stored hashed and consumed on use, and the end-to-end browser flow. The tests simulate those
provider behaviours; they do not prove them. Verify them once manually after configuring the dashboard.

Vercel functions: this adds one function (`api/auth/reset-code.js`), for 11 in total.
