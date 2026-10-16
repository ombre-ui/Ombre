import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { RESET_CODE_LENGTH, RESEND_COOLDOWN_SECONDS, NEUTRAL_REQUEST_MESSAGE, normalizeCode, isCompleteCode, tick, resendLabel } from '../../src/features/auth/resetModel.js'
import { messageForError } from '../../src/features/auth/authErrors.js'

const src = (rel) => readFileSync(new URL(`../../src/${rel}`, import.meta.url), 'utf8')

// ---- model ----

test('code is 7 digits, the neutral message is the required wording, resend cooldown is 60 s', () => {
  assert.equal(RESET_CODE_LENGTH, 7)
  assert.equal(RESEND_COOLDOWN_SECONDS, 60)
  assert.equal(NEUTRAL_REQUEST_MESSAGE, 'If an account exists for this email, we’ll send a reset code.')
})

test('normalizeCode keeps digits only (pasted formats work) and caps the length', () => {
  assert.equal(normalizeCode('123 4567'), '1234567')
  assert.equal(normalizeCode('123-4567'), '1234567')
  assert.equal(normalizeCode('12345678901'), '1234567')
  assert.equal(normalizeCode('abc12x3'), '123')
  assert.equal(normalizeCode(null), '')
  assert.equal(normalizeCode(undefined), '')
  assert.equal(normalizeCode(1234567), '1234567')
})

test('isCompleteCode needs exactly seven digits', () => {
  assert.equal(isCompleteCode('123456'), false)
  assert.equal(isCompleteCode('1234567'), true)
  assert.equal(isCompleteCode('123 4567'), true)
  assert.equal(isCompleteCode('abcdefg'), false)
})

test('resend countdown ticks down to zero and labels itself', () => {
  assert.equal(tick(60), 59)
  assert.equal(tick(1), 0)
  assert.equal(tick(0), 0)
  assert.equal(resendLabel(42), 'Send a new code in 42s')
  assert.equal(resendLabel(0), 'Send a new code')
})

test('the reset error copy is generic and never says why a code failed', () => {
  const m = messageForError({ code: 'reset_code_invalid' })
  assert.match(m, /isn’t right, or it has expired/)
  assert.ok(!/no account|not found|exists/i.test(m))
  assert.match(messageForError({ code: 'rate_limited' }), /Too many attempts/)
})

// ---- screens (static: no DOM harness in this repo) ----

test('ForgotPasswordPage: email step, then code step; uses the reset-code calls; neutral wording', () => {
  const page = src('features/auth/ForgotPasswordPage.jsx')
  assert.match(page, /requestResetCode\(email\)/)
  assert.match(page, /verifyResetCode\(email, code\)/)
  assert.match(page, /NEUTRAL_REQUEST_MESSAGE/)
  assert.match(page, /autoComplete="one-time-code"/)
  assert.match(page, /inputMode="numeric"/)
  assert.match(page, /maxLength=\{RESET_CODE_LENGTH\}/)
  assert.match(page, /Send reset code/)
  assert.match(page, /Verify code/)
  assert.ok(page.indexOf("step === 'code'") < page.indexOf('Send reset code'), 'code step is defined before the email step render')
})

test('the code is never put in a URL, storage or a cookie by the reset screens', () => {
  const page = src('features/auth/ForgotPasswordPage.jsx')
  const provider = src('lib/auth/AuthProvider.jsx')
  assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie/.test(page))
  assert.ok(!/useSearchParams|location\.search|location\.hash|navigate\(.*code/.test(page))
  assert.match(provider, /body: \{ action: 'verify', email, code \}/) // POST body only
  assert.ok(!/reset-code\?/.test(provider))
})

test('after a verified code the provider navigates through the safe-next allow-list to /reset-password', () => {
  const provider = src('lib/auth/AuthProvider.jsx')
  assert.match(provider, /const verifyResetCode = useCallback\(async \(email, code\) => \{[\s\S]*?wipeAndNavigate\(safeServerNext\(result\.data && result\.data\.next\)\)/)
})

test('ResetPasswordPage: New password, Confirm new password, Reset password', () => {
  const page = src('features/auth/ResetPasswordPage.jsx')
  assert.match(page, /label="New password"/)
  assert.match(page, /label="Confirm new password"/)
  assert.match(page, /'Reset password'/)
  assert.match(page, /navigate\('\/app\/general'/) // normal authenticated destination
})

test('"Forgot password?" is a subtle link on the Password label row (sign-in only); no leftover old link', () => {
  const screen = src('features/auth/AuthScreen.jsx')
  assert.match(screen, /labelAction=\{\s*isSignup \? undefined : \(\s*<Link to="\/forgot-password" className="auth-forgot-link">\s*Forgot password\?\s*<\/Link>/)
  assert.ok(!/Forgot your password\?/.test(screen))
  const layout = src('features/auth/AuthLayout.jsx')
  assert.match(layout, /auth-label-row/)
  const css = src('features/auth/oauth.css')
  assert.match(css, /\.auth-forgot-link \{[^}]*font-size: var\(--text-xs\)/)
})

test('the reset-code function entry point exists and the old link-based callback is untouched', () => {
  assert.ok(existsSync(new URL('../../api/auth/reset-code.js', import.meta.url)))
  assert.match(src('App.jsx'), /path="\/auth\/callback\/recovery"/)
})
