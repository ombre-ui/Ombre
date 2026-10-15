import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { OAUTH_BUTTONS, EMAIL_BUTTON_LABEL, modeCopy, redirectingLabel, validateSignup, canSubmit } from '../../src/features/auth/authScreenModel.js'
import { messageForError } from '../../src/features/auth/authErrors.js'
import { OAUTH_PROVIDERS } from '../../src/lib/auth/oauth.js'

const read = (rel) => readFileSync(new URL(`../../src/features/auth/${rel}`, import.meta.url), 'utf8')

// ---- the model ----

test('OAuth buttons: Google first and primary, GitHub second and secondary; every one is an allow-listed provider', () => {
  assert.deepEqual(OAUTH_BUTTONS.map((b) => [b.provider, b.label, b.variant]), [
    ['google', 'Continue with Google', 'primary'],
    ['github', 'Continue with GitHub', 'secondary'],
  ])
  for (const { provider } of OAUTH_BUTTONS) assert.ok(OAUTH_PROVIDERS.includes(provider))
  assert.equal(EMAIL_BUTTON_LABEL, 'Continue with email')
})

test('copy: exact wording for both modes, including "Already have an account?"', () => {
  const signin = modeCopy('signin')
  assert.equal(signin.title, 'Sign in')
  assert.equal(signin.lead, 'Don’t have an account?')
  assert.equal(signin.emailHeading, 'Already have an account?')
  assert.equal(signin.submit, 'Sign in')
  assert.deepEqual({ ...signin.link }, { to: '/signup', text: 'Create one' })
  const signup = modeCopy('signup')
  assert.equal(signup.lead, 'Already have an account?')
  assert.equal(signup.submit, 'Create account')
  assert.deepEqual({ ...signup.link }, { to: '/login', text: 'Sign in' })
  assert.equal(modeCopy('nonsense'), signin) // unknown mode falls back to sign-in
})

test('redirecting labels name the provider', () => {
  assert.equal(redirectingLabel('google'), 'Redirecting to Google…')
  assert.equal(redirectingLabel('github'), 'Redirecting to GitHub…')
})

test('sign-up validation: length first, then matching confirmation', () => {
  assert.equal(validateSignup({ password: 'short', confirm: 'short' }), 'weak_password')
  assert.equal(validateSignup({ password: 'a-long-enough-password', confirm: 'a-long-enough-passw0rd' }), 'password_mismatch')
  assert.equal(validateSignup({ password: 'a-long-enough-password', confirm: '' }), 'password_mismatch')
  assert.equal(validateSignup({ password: 'a-long-enough-password', confirm: 'a-long-enough-password' }), '')
  assert.equal(validateSignup({ password: '😀'.repeat(12), confirm: '😀'.repeat(12) }), '') // characters, not UTF-16 units
  assert.equal(validateSignup({ password: '😀'.repeat(11), confirm: '😀'.repeat(11) }), 'weak_password')
  assert.match(messageForError({ code: 'password_mismatch' }), /don’t match/)
  assert.match(messageForError({ code: 'weak_password' }), /12 characters/)
})

test('submit gating: sign-in needs email+password; sign-up also needs the confirmation; never while busy', () => {
  assert.equal(canSubmit('signin', { email: 'a@b.co', password: 'x', confirm: '' }, false), true)
  assert.equal(canSubmit('signin', { email: '', password: 'x', confirm: '' }, false), false)
  assert.equal(canSubmit('signin', { email: 'a@b.co', password: '', confirm: '' }, false), false)
  assert.equal(canSubmit('signup', { email: 'a@b.co', password: 'x', confirm: '' }, false), false)
  assert.equal(canSubmit('signup', { email: 'a@b.co', password: 'x', confirm: 'x' }, false), true)
  assert.equal(canSubmit('signin', { email: 'a@b.co', password: 'x', confirm: '' }, true), false)
})

// ---- the screen's source (no DOM harness in this repo: assert structure and wiring statically) ----

test('AuthScreen renders OAuth buttons from the model, then the email button, then a revealed email form', () => {
  const src = read('AuthScreen.jsx')
  assert.match(src, /OAUTH_BUTTONS\.map\(/)
  assert.match(src, /handleOAuth\(provider\)/)
  assert.match(src, /startOAuth\(provider\)/)
  assert.ok(src.indexOf('OAUTH_BUTTONS.map(') < src.indexOf('EMAIL_BUTTON_LABEL}'), 'OAuth buttons come before the email button')
  assert.ok(src.indexOf('EMAIL_BUTTON_LABEL}') < src.indexOf('id="auth-email-section"'), 'the email form comes after the email button')
  assert.match(src, /aria-expanded=\{showEmail\}/)
  assert.match(src, /useState\(false\)/) // the email form starts hidden
  assert.match(src, /\{showEmail && \(/)
})

test('AuthScreen: sign-up adds the confirm field and uses the existing signup/signin calls (no new auth system)', () => {
  const src = read('AuthScreen.jsx')
  assert.match(src, /\{isSignup && \(\s*<Field id="auth-confirm"/)
  assert.match(src, /label="Confirm password"/)
  assert.match(src, /autoComplete=\{isSignup \? 'new-password' : 'current-password'\}/)
  assert.match(src, /await signUp\(email, password\)/)
  assert.match(src, /await signIn\(email, password,/)
  assert.match(src, /validateSignup\(/)
  assert.match(src, /to="\/forgot-password"/) // password reset stays
  assert.match(src, /Check your email/) // the existing confirmation state is preserved
})

test('login and signup routes use the one screen in the right mode', () => {
  assert.match(read('LoginPage.jsx'), /<AuthScreen mode="signin" \/>/)
  assert.match(read('SignupPage.jsx'), /<AuthScreen mode="signup" \/>/)
})

test('Google and GitHub users are never asked for a password: OAuth buttons sit outside the form', () => {
  const src = read('AuthScreen.jsx')
  const form = src.slice(src.indexOf('<form'), src.indexOf('</form>'))
  assert.ok(!form.includes('OAUTH_BUTTONS') && !form.includes('handleOAuth'))
  assert.ok(src.indexOf('handleOAuth(provider)') < src.indexOf('<form'))
})

test('no auth file stores anything in the browser, reads VITE_ variables, or uses the wrong wording', () => {
  for (const file of readdirSync(new URL('../../src/features/auth/', import.meta.url)).filter((f) => /\.(jsx|js)$/.test(f))) {
    const src = read(file)
    assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie/.test(src), `${file} must not touch browser storage`)
    assert.ok(!/VITE_/.test(src), `${file} must not read VITE_ variables`)
    assert.ok(!/Already an user/i.test(src), `${file}: wrong wording`)
  }
})

test('regression: GitHub is still wired end to end (provider, label, callback route purpose)', () => {
  assert.ok(OAUTH_PROVIDERS.includes('github'))
  assert.ok(OAUTH_BUTTONS.some((b) => b.provider === 'github' && b.label === 'Continue with GitHub'))
  assert.match(read('AuthCallbackPage.jsx'), /purpose === 'oauth'/)
  const app = readFileSync(new URL('../../src/App.jsx', import.meta.url), 'utf8')
  assert.match(app, /path="\/auth\/callback\/oauth" element=\{<AuthCallbackPage purpose="oauth" \/>\}/)
})
