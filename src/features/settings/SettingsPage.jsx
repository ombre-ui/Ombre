import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useUserState } from '../../lib/user/UserStateProvider.jsx'
import { useAuth } from '../../lib/auth/AuthProvider.jsx'
import StatePanel from '../../lib/user/StatePanel.jsx'
import SettingsToggle from './SettingsToggle.jsx'
import SettingsSegmented from './SettingsSegmented.jsx'
import './settings.css'

const SECTIONS = [
  { id: 'general', label: 'General' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'privacy', label: 'Privacy' },
  { id: 'memory', label: 'Memory' },
  { id: 'ai', label: 'AI & Personalization' },
  { id: 'account', label: 'Account' },
  { id: 'about', label: 'About' },
]

function scrollToSection(id, behavior = 'smooth') {
  document.getElementById(id)?.scrollIntoView({ behavior, block: 'start' })
}

export default function SettingsPage() {
  const { settings, profile, updateSettings, reload } = useUserState()
  const { hash } = useLocation()
  const { user, signOut } = useAuth()
  const [toast, setToast] = useState(null)

  const ready = settings.status === 'ready'
  const values = ready ? settings.data : null
  const accountName = profile.status === 'ready' ? profile.data.displayName : null

  // Deep links like /app/settings#ai (used from Profile) should land on that
  // section. Router navigation doesn't scroll to hashes by itself.
  useEffect(() => {
    if (hash) scrollToSection(hash.slice(1), 'auto')
  }, [hash])

  function showToast(message, ms = 2400) {
    setToast(message)
    window.setTimeout(() => setToast(null), ms)
  }

  // Optimistic, server-confirmed save. On failure the control reverts by itself and we say so.
  async function patchSection(section, patch) {
    const result = await updateSettings({ [section]: patch })
    if (!result.ok) showToast('Couldn’t save that change. Your setting wasn’t changed.')
  }

  async function handleSignOut() {
    const result = await signOut()
    if (!result.ok) showToast('Couldn’t sign out. Check your connection and try again.')
  }

  const unavailable = <StatePanel status={settings.status} what="your settings" onRetry={() => reload('settings')} />

  return (
    <div className="settings-page motion-reveal">
      <header className="settings-header">
        <h1 className="text-heading-lg">Settings</h1>
        <p className="text-body text-secondary">Your preferences are saved to your account.</p>
      </header>

      <nav className="settings-nav" aria-label="Settings sections">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            className="settings-nav-pill motion-interactive"
            onClick={() => scrollToSection(s.id)}
          >
            {s.label}
          </button>
        ))}
      </nav>

      {/* ---- General ---- */}
      <section id="general" className="settings-section">
        <h2 className="text-heading-sm">General</h2>
        <p className="text-body-sm text-secondary settings-section-intro">Appearance and interface.</p>

        {ready ? (
          <>
            <SettingsSegmented
              label="Theme"
              value={values.general.theme}
              onChange={(v) => patchSection('general', { theme: v })}
              options={[
                { value: 'system', label: 'System' },
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
              ]}
            />

            <SettingsToggle
              label="Reduce motion"
              description="Ombre already respects your system's reduced-motion setting. An in-app override is coming soon."
              checked={false}
              onChange={() => {}}
              disabled
            />
          </>
        ) : (
          unavailable
        )}
      </section>

      {/* ---- Notifications ---- */}
      <section id="notifications" className="settings-section">
        <h2 className="text-heading-sm">Notifications</h2>
        <p className="text-body-sm text-secondary settings-section-intro">
          Nothing sends yet — these set your preference for when notifications are built.
        </p>

        {ready ? (
          <>
            <SettingsToggle
              label="Email notifications"
              description="Summaries and updates by email."
              checked={values.notifications.email}
              onChange={(v) => patchSection('notifications', { email: v })}
            />
            <SettingsToggle
              label="In-app notifications"
              description="Let a mentor's reply notify you inside Ombre."
              checked={values.notifications.inApp}
              onChange={(v) => patchSection('notifications', { inApp: v })}
            />
          </>
        ) : (
          unavailable
        )}
      </section>

      {/* ---- Privacy ---- */}
      <section id="privacy" className="settings-section">
        <h2 className="text-heading-sm">Privacy</h2>
        <p className="text-body-sm text-secondary settings-section-intro">Data and conversation controls.</p>

        {ready ? (
          <SettingsToggle
            label="Save conversation history"
            description="Keep conversations in History after you leave them. Saving conversations to your account isn’t built yet; this stores your preference."
            checked={values.privacy.saveHistory}
            onChange={(v) => patchSection('privacy', { saveHistory: v })}
          />
        ) : (
          unavailable
        )}

        <div className="settings-danger-row">
          <button
            type="button"
            className="settings-danger-btn"
            disabled
            title="Available once conversations are saved to your account"
          >
            Clear all conversations
          </button>
        </div>
      </section>

      {/* ---- Memory ---- */}
      <section id="memory" className="settings-section">
        <h2 className="text-heading-sm">Memory</h2>
        <p className="text-body-sm text-secondary settings-section-intro">
          Memory isn’t connected to your account yet.{' '}
          <Link to="/app/memory" className="settings-link-active">
            View Memory
          </Link>
          . Ombre doesn't extract memory automatically yet.
        </p>

        {ready ? (
          <SettingsToggle
            label="Remember context across conversations"
            description="Allow General AI and mentors to use Memory when responding. Stores your preference for when Memory is built."
            checked={values.privacy.rememberContext}
            onChange={(v) => patchSection('privacy', { rememberContext: v })}
          />
        ) : (
          unavailable
        )}

        <div className="settings-danger-row">
          <button
            type="button"
            className="settings-danger-btn"
            disabled
            title="Available once Memory is saved to your account"
          >
            Clear everything Ombre remembers
          </button>
        </div>
      </section>

      {/* ---- AI & Personalization ---- */}
      <section id="ai" className="settings-section">
        <h2 className="text-heading-sm">AI &amp; Personalization</h2>
        <p className="text-body-sm text-secondary settings-section-intro">
          How General AI and mentors will respond to you. Individual mentor behavior is configured separately and
          isn’t part of this yet.
        </p>

        {ready ? (
          <>
            <SettingsSegmented
              label="Response style"
              value={values.ai.responseStyle}
              onChange={(v) => patchSection('ai', { responseStyle: v })}
              options={[
                { value: 'concise', label: 'Concise' },
                { value: 'balanced', label: 'Balanced' },
                { value: 'detailed', label: 'Detailed' },
              ]}
            />
            <SettingsToggle
              label="Use my name in responses"
              checked={values.ai.useNameInResponses}
              onChange={(v) => patchSection('ai', { useNameInResponses: v })}
            />
            <SettingsToggle
              label="Suggest mentors based on context"
              description="Let Ombre point toward a specialized mentor when a conversation fits one."
              checked={values.ai.suggestMentors}
              onChange={(v) => patchSection('ai', { suggestMentors: v })}
            />
          </>
        ) : (
          unavailable
        )}
      </section>

      {/* ---- Account ---- */}
      <section id="account" className="settings-section">
        <h2 className="text-heading-sm">Account</h2>
        <p className="text-body-sm text-secondary settings-section-intro">
          {accountName || 'No name set'} · {user?.email || 'No email'}
        </p>

        <div className="settings-danger-row">
          <button type="button" className="settings-danger-btn motion-interactive" onClick={handleSignOut}>
            Sign out
          </button>
          <button
            type="button"
            className="settings-danger-btn settings-danger-btn-strong"
            disabled
            title="Account deletion isn't available yet"
          >
            Delete account
          </button>
        </div>
      </section>

      {/* ---- About ---- */}
      <section id="about" className="settings-section">
        <h2 className="text-heading-sm">About</h2>
        <p className="text-body-sm text-secondary">
          Ombre is a space of specialized minds, each built to go deep on one thing — alongside a general AI and one
          connected workspace.
        </p>
        <p className="text-meta settings-version">v0.1.0 · frontend foundation</p>

        <div className="settings-about-links">
          <button type="button" className="settings-link" disabled title="Coming soon">
            Terms of Service
          </button>
          <button type="button" className="settings-link" disabled title="Coming soon">
            Privacy Policy
          </button>
        </div>

        <p className="text-body-sm text-secondary settings-disclaimer">
          <strong>AI disclaimer:</strong> General AI and mentor conversations are not yet connected to a real
          reasoning model. Responses you see right now are demo placeholders that exercise the interface only.
        </p>
      </section>

      {toast && <div className="settings-toast motion-reveal">{toast}</div>}
    </div>
  )
}
