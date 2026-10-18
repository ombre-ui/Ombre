import { ApiError, badRequest, unauthorized, tooManyRequests, unavailable, isRetryable, isRateLimited, isSessionMissing, isVerifierMissing } from './errors.js'
import { createRoute } from './pipeline.js'
import { parseEmail, parseExistingPassword, parseNewPassword, parseAuthCode, parseFlowId, parsePurpose, parseOAuthProvider, parseResetAction, parseResetCode } from './validate.js'
import { createMemoryLimiter, limiterKey } from './limiter.js'

const NEXT_AFTER_SIGN_IN = '/app/general'
const NEXT_AFTER_RECOVERY = '/reset-password'

function publicUser(user) {
  return { id: user.id, email: user.email ?? null }
}

// Never let a provider outage look like "wrong password" or "signed out".
function throwIfTransient(error) {
  if (isRetryable(error)) throw unavailable()
  if (isRateLimited(error)) throw tooManyRequests()
}

// Password-reset code limits (defense in depth; see limiter.js and docs/password-reset.md).
const RESET_LIMITS = Object.freeze({
  requestCooldown: { max: 1, windowMs: 60 * 1000 }, // per email: one send per minute
  requestHourly: { max: 5, windowMs: 60 * 60 * 1000 }, // per email: five sends per hour
  requestIp: { max: 10, windowMs: 60 * 60 * 1000 }, // per client IP
  verifyEmail: { max: 5, windowMs: 60 * 60 * 1000 }, // per email: five attempts per code window
  verifyIp: { max: 20, windowMs: 15 * 60 * 1000 }, // per client IP
})

function clientIp(request) {
  const vercel = request.headers.get('x-vercel-forwarded-for')
  if (vercel) return vercel.split(',')[0].trim()
  const forwarded = request.headers.get('x-forwarded-for')
  return forwarded ? forwarded.split(',')[0].trim() : 'unknown'
}

// Only an account that actually has an email/password identity may use the reset-code path. A Google/GitHub-only
// account must not be handed an Ombre password through it. Unknown shape => refuse.
function usesEmailPassword(user) {
  const providers = user && user.app_metadata && Array.isArray(user.app_metadata.providers) ? user.app_metadata.providers : null
  if (providers) return providers.includes('email')
  return Boolean(user && Array.isArray(user.identities) && user.identities.some((i) => i && i.provider === 'email'))
}

// Extra authorization parameters per provider. Server-controlled constants: the browser can never supply them.
// Google: always show Google's own account chooser instead of silently reusing whichever account is signed in.
const OAUTH_QUERY_PARAMS = Object.freeze({ google: Object.freeze({ prompt: 'select_account' }) })

// The URL we hand to the browser must be this project's own Supabase authorize endpoint and nothing else.
function supabaseAuthorizeUrl(value, config) {
  if (typeof value !== 'string') return null
  let url
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.origin !== new URL(config.supabaseUrl).origin || url.pathname !== '/auth/v1/authorize') return null
  return url.toString()
}

export function createRoutes({ getConfig, createSupabase, logger, limiter = createMemoryLimiter() }) {
  const route = (options, fn) => createRoute({ getConfig, createSupabase, logger }, options, fn)

  // GET /api/auth/session: authorization uses getUser() (validated by the Auth server), never getSession().
  const session = route({ methods: ['GET'] }, async (ctx) => {
    const { supabase, jar } = ctx.supa()
    const { data, error } = await supabase.auth.getUser()
    if (error) {
      if (isRetryable(error)) throw unavailable()
      if (!isSessionMissing(error)) {
        ctx.logAuthError('auth.session.invalid', error)
        jar.expireAllAuthCookies()
      }
      return { body: { user: null } }
    }
    if (!data || !data.user) return { body: { user: null } }
    return { body: { user: publicUser(data.user) } }
  })

  const signin = route({ methods: ['POST'], body: ['email', 'password'] }, async (ctx) => {
    const email = parseEmail(ctx.body.email)
    const password = parseExistingPassword(ctx.body.password)
    const { supabase } = ctx.supa()
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) {
      ctx.logAuthError('auth.signin.failed', error)
      throwIfTransient(error)
      // email_not_confirmed is only returned after the password verified, so it reveals nothing to a stranger.
      if (error.code === 'email_not_confirmed') throw new ApiError(403, 'email_not_confirmed')
      throw unauthorized('invalid_credentials')
    }
    if (!data || !data.user) throw unauthorized('invalid_credentials')
    return { body: { ok: true, user: publicUser(data.user) } }
  })

  // POST /api/auth/signup: identical response whether or not the address already has an account.
  const signup = route({ methods: ['POST'], body: ['email', 'password'] }, async (ctx) => {
    const email = parseEmail(ctx.body.email)
    const password = parseNewPassword(ctx.body.password)
    const { supabase } = ctx.supa()
    const emailRedirectTo = `${ctx.origin}/auth/callback`
    const { data, error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo } })
    if (error) {
      ctx.logAuthError('auth.signup.failed', error)
      throwIfTransient(error)
      if (error.code === 'weak_password') throw badRequest('weak_password')
      if (error.code === 'user_already_exists') return { body: { ok: true, status: 'check_email' } }
      throw badRequest('signup_failed')
    }
    if (data && data.session) ctx.log('auth.signup.session_returned', {}) // email confirmation appears to be disabled
    return { body: { ok: true, status: 'check_email' } }
  })

  const forgotPassword = route({ methods: ['POST'], body: ['email'] }, async (ctx) => {
    const email = parseEmail(ctx.body.email)
    const { supabase } = ctx.supa()
    const redirectTo = `${ctx.origin}/auth/callback/recovery`
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo })
    if (error) {
      ctx.logAuthError('auth.forgot.failed', error)
      throwIfTransient(error)
      // Any other error is swallowed so the response never reveals whether the address exists.
    }
    return { body: { ok: true } }
  })

  // POST /api/auth/reset-code: the 7-digit password-reset code flow, a thin layer over Supabase Auth.
  //   { action: 'request', email }        asks Supabase to email a recovery code (resetPasswordForEmail)
  //   { action: 'verify', email, code }   verifies it (verifyOtp type 'recovery') and, on success, sets the normal
  //                                       HttpOnly session cookie; the client then goes to /reset-password
  // Supabase Auth generates the code, stores only a hash, makes it single-use, expires it (OTP expiry setting),
  // replaces any earlier code when a new one is issued, and sends the email. This route adds neutral responses,
  // best-effort limits, and the refusal for accounts that have no email/password identity. The code travels only
  // in a POST body: never in a URL, a cookie or browser storage, and never in a log line.
  const resetCode = route({ methods: ['POST'], body: ['action', 'email', 'code'] }, async (ctx) => {
    const action = parseResetAction(ctx.body.action)
    const email = parseEmail(ctx.body.email)
    const ipKey = limiterKey('ip', clientIp(ctx.request))
    const emailKey = limiterKey('email', email)

    if (action === 'request') {
      if (ctx.body.code !== undefined) throw badRequest()
      if (!limiter.hit(`reset-req-ip:${ipKey}`, RESET_LIMITS.requestIp).allowed) throw tooManyRequests()
      const cooled = limiter.hit(`reset-req-cool:${emailKey}`, RESET_LIMITS.requestCooldown).allowed
      const underCap = cooled && limiter.hit(`reset-req-hr:${emailKey}`, RESET_LIMITS.requestHourly).allowed
      if (!underCap) {
        // Neutral on purpose: a throttled request looks exactly like a sent one (never reveals an account).
        ctx.log('auth.resetcode.request_throttled', {})
        return { body: { ok: true } }
      }
      limiter.reset(`reset-verify:${emailKey}`) // a fresh code gets a fresh attempt budget
      const { supabase } = ctx.supa()
      const { error } = await supabase.auth.resetPasswordForEmail(email)
      if (error) {
        ctx.logAuthError('auth.resetcode.request_failed', error)
        // Only a pure connectivity failure is surfaced: every other error (including ones that only occur for
        // existing accounts) is swallowed so the response cannot be used to probe for accounts.
        if (error.name === 'AuthRetryableFetchError') throw unavailable()
      }
      return { body: { ok: true } }
    }

    const code = parseResetCode(ctx.body.code)
    if (!limiter.hit(`reset-ver-ip:${ipKey}`, RESET_LIMITS.verifyIp).allowed) throw tooManyRequests()
    if (!limiter.hit(`reset-verify:${emailKey}`, RESET_LIMITS.verifyEmail).allowed) {
      ctx.log('auth.resetcode.verify_locked', {})
      throw tooManyRequests()
    }
    const { supabase, jar } = ctx.supa()
    const { data, error } = await supabase.auth.verifyOtp({ email, token: code, type: 'recovery' })
    if (error) {
      ctx.logAuthError('auth.resetcode.verify_failed', error)
      if (error.name === 'AuthRetryableFetchError') throw unavailable()
      throw badRequest('reset_code_invalid') // wrong, expired and already-used codes are indistinguishable
    }
    const user = data && data.user
    if (!user || !data.session) throw badRequest('reset_code_invalid')
    if (!usesEmailPassword(user)) {
      try {
        await supabase.auth.signOut({ scope: 'local' })
      } catch (signOutError) {
        ctx.logAuthError('auth.resetcode.signout_error', signOutError)
      }
      jar.expireAllAuthCookies()
      ctx.log('auth.resetcode.no_password_identity', {})
      throw badRequest('reset_code_invalid')
    }
    limiter.reset(`reset-verify:${emailKey}`)
    return { body: { ok: true, next: NEXT_AFTER_RECOVERY, user: publicUser(user) } }
  })

  // POST /api/auth/oauth: starts a Supabase OAuth (PKCE) sign-in for an allowlisted provider (GitHub, Google).
  // The browser asks for it with the usual CSRF protections (exact Origin + custom header), the PKCE verifier
  // is stored in the HttpOnly session cookie jar by the server client, and only the provider authorize URL is
  // returned. The browser navigates there; the provider returns to Supabase, which returns to
  // `${origin}/auth/callback/oauth?code=...`, which the callback route below exchanges for a session.
  // Nothing about the provider (tokens, client secret) ever reaches this code or the browser.
  const oauth = route({ methods: ['POST'], body: ['provider'] }, async (ctx) => {
    const provider = parseOAuthProvider(ctx.body.provider)
    const { supabase } = ctx.supa()
    const redirectTo = `${ctx.origin}/auth/callback/oauth` // ctx.origin is the validated, allow-listed APP_ORIGINS entry
    const options = { redirectTo, skipBrowserRedirect: true }
    if (OAUTH_QUERY_PARAMS[provider]) options.queryParams = { ...OAUTH_QUERY_PARAMS[provider] }
    const { data, error } = await supabase.auth.signInWithOAuth({ provider, options })
    if (error) {
      ctx.logAuthError('auth.oauth.start_failed', error)
      throwIfTransient(error)
      throw badRequest('oauth_failed')
    }
    const url = supabaseAuthorizeUrl(data && data.url, ctx.config)
    if (!url) {
      ctx.log('auth.oauth.unexpected_authorize_url', {})
      throw new ApiError(500, 'internal_error')
    }
    return { body: { ok: true, url } }
  })

  // POST /api/auth/callback: PKCE code exchange for email confirmation, password recovery and OAuth sign-in.
  const callback = route({ methods: ['POST'], body: ['code', 'flowId', 'purpose'] }, async (ctx) => {
    const code = parseAuthCode(ctx.body.code)
    const flowId = parseFlowId(ctx.body.flowId)
    const purpose = parsePurpose(ctx.body.purpose)
    const { supabase } = ctx.supa()
    const { data, error } = await supabase.auth.exchangeCodeForSession(code, flowId ? { flowId } : undefined)
    if (error) {
      ctx.logAuthError('auth.callback.failed', error)
      if (isRetryable(error)) throw unavailable()
      if (isVerifierMissing(error)) throw badRequest('link_wrong_browser')
      throw badRequest('link_invalid_or_expired')
    }
    const user = (data && (data.user || (data.session && data.session.user))) || null
    if (!user) throw badRequest('link_invalid_or_expired')
    const recovery = purpose === 'recovery' || (data && data.redirectType === 'PASSWORD_RECOVERY')
    return { body: { ok: true, next: recovery ? NEXT_AFTER_RECOVERY : NEXT_AFTER_SIGN_IN, user: publicUser(user) } }
  })

  const resetPassword = route({ methods: ['POST'], body: ['password'] }, async (ctx) => {
    const password = parseNewPassword(ctx.body.password)
    const { supabase } = ctx.supa()
    const current = await supabase.auth.getUser()
    if (current.error || !current.data || !current.data.user) {
      if (isRetryable(current.error)) throw unavailable()
      throw unauthorized()
    }
    const { error } = await supabase.auth.updateUser({ password })
    if (error) {
      ctx.logAuthError('auth.reset.failed', error)
      throwIfTransient(error)
      if (error.code === 'same_password') throw badRequest('same_password')
      if (error.code === 'weak_password') throw badRequest('weak_password')
      if (error.code === 'reauthentication_needed') throw new ApiError(403, 'recent_login_required')
      throw badRequest('reset_failed')
    }
    return { body: { ok: true } }
  })

  const signout = route({ methods: ['POST'], body: null }, async (ctx) => {
    const { supabase, jar } = ctx.supa()
    try {
      await supabase.auth.signOut({ scope: 'local' })
    } catch (error) {
      ctx.logAuthError('auth.signout.error', error)
    }
    jar.expireAllAuthCookies() // belt and braces: session chunks, verifier slots, stale chunks
    return { body: { ok: true } }
  })

  return { session, signin, signup, forgotPassword, resetCode, oauth, callback, resetPassword, signout }
}
