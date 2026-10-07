import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useOmbreData } from '../../lib/store.jsx'
import { useAuth } from '../../lib/auth/AuthProvider.jsx'
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
  const {
    theme,
    toggleTheme,
    getSettings,
    updateSettings,
    getProfile,
    listConversations,
    clearAllConversations,
    listMemoryItems,
    clearAllMemory,
  } = useOmbreData()
  const { hash } = useLocation()
  const { user, signOut } = useAuth()

  const settings = getSettings()
  const profile = getProfile()
  const memoryCount = listMemoryItems().length
  const [toast, setToast] = useState(null)

  // Deep links like /app/settings#ai (used from Profile) should land on that
  // section. Router navigation doesn't scroll to hashes by itself.
  useEffect(() => {
    if (hash) scrollToSection(hash.slice(1), 'auto')
  }, [hash])

  function patchSection(section, patch) {
    updateSettings({ [section]: { ...settings[section], ...patch } })
  }

  function handleClearConversations() {
    if (listConversations().length === 0) return
    if (window.confirm('Clear all conversations? This only affects the local demo data on this device.')) {
      clearAllConversations()
      setToast('Conversations cleared')
      window.setTimeout(() => setToast(null), 1800)
    }
  }

  function handleClearMemory() {
    if (listMemoryItems().length === 0) return
    if (window.confirm('Clear everything Ombre remembers? This only affects the local demo data on this device.')) {
      clearAllMemory()
      setToast('Memory cleared')
      window.setTimeout(() => setToast(null), 1800)
    }
  }

  async function handleSignOut() {
    const result = await signOut()
    if (!result.ok) {
      setToast('Couldn’t sign out. Check your connection and try again.')
      window.setTimeout(() => setToast(null), 2400)
    }
  }

  return (
    <div className="settings-page motion-reveal">
      <header className="settings-header">
        <h1 className="text-heading-lg">Settings</h1>
        <p className="text-body text-secondary">Every control here is local to this device for now.</p>
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

        <SettingsSegmented
          label="Theme"
          value={theme}
          onChange={(v) => v !== theme && toggleTheme()}
          options={[
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
      </section>

      {/* ---- Notifications ---- */}
      <section id="notifications" className="settings-section">
        <h2 className="text-heading-sm">Notifications</h2>
        <p className="text-body-sm text-secondary settings-section-intro">
          Nothing sends yet — these set your preference for when notifications are built.
        </p>

        <SettingsToggle
          label="Email notifications"
          description="Summaries and updates by email."
          checked={settings.notifications.email}
          onChange={(v) => patchSection('notifications', { email: v })}
        />
        <SettingsToggle
          label="In-app notifications"
          description="Let a mentor's reply notify you inside Ombre."
          checked={settings.notifications.inApp}
          onChange={(v) => patchSection('notifications', { inApp: v })}
        />
      </section>

      {/* ---- Privacy ---- */}
      <section id="privacy" className="settings-section">
        <h2 className="text-heading-sm">Privacy</h2>
        <p className="text-body-sm text-secondary settings-section-intro">Data and conversation controls.</p>

        <SettingsToggle
          label="Save conversation history"
          description="Keep conversations in History after you leave them."
          checked={settings.privacy.saveHistory}
          onChange={(v) => patchSection('privacy', { saveHistory: v })}
        />

        <div className="settings-danger-row">
          <button type="button" className="settings-danger-btn motion-interactive" onClick={handleClearConversations}>
            Clear all conversations
          </button>
        </div>
      </section>

      {/* ---- Memory ---- */}
      <section id="memory" className="settings-section">
        <h2 className="text-heading-sm">Memory</h2>
        <p className="text-body-sm text-secondary settings-section-intro">
          {memoryCount === 0
            ? 'Nothing remembered yet.'
            : `${memoryCount} item${memoryCount === 1 ? '' : 's'} remembered.`}{' '}
          <Link to="/app/memory" className="settings-link-active">
            View Memory
          </Link>
          . Ombre doesn't extract memory automatically yet — everything there was added by hand.
        </p>

        <SettingsToggle
          label="Remember context across conversations"
          description="Allow General AI and mentors to use Memory when responding."
          checked={settings.privacy.rememberContext}
          onChange={(v) => patchSection('privacy', { rememberContext: v })}
        />

        <div className="settings-danger-row">
          <button type="button" className="settings-danger-btn motion-interactive" onClick={handleClearMemory}>
            Clear everything Ombre remembers
          </button>
        </div>
      </section>

      {/* ---- AI & Personalization ---- */}
      <section id="ai" className="settings-section">
        <h2 className="text-heading-sm">AI &amp; Personalization</h2>
        <p className="text-body-sm text-secondary settings-section-intro">
          How General AI and mentors respond to you. Individual mentor behavior is configured separately and isn’t
          part of this yet.
        </p>

        <SettingsSegmented
          label="Response style"
          value={settings.ai.responseStyle}
          onChange={(v) => patchSection('ai', { responseStyle: v })}
          options={[
            { value: 'concise', label: 'Concise' },
            { value: 'balanced', label: 'Balanced' },
            { value: 'detailed', label: 'Detailed' },
          ]}
        />
        <SettingsToggle
          label="Use my name in responses"
          checked={settings.ai.useNameInResponses}
          onChange={(v) => patchSection('ai', { useNameInResponses: v })}
        />
        <SettingsToggle
          label="Suggest mentors based on context"
          description="Let Ombre point toward a specialized mentor when a conversation fits one."
          checked={settings.ai.suggestMentors}
          onChange={(v) => patchSection('ai', { suggestMentors: v })}
        />
      </section>

      {/* ---- Account ---- */}
      <section id="account" className="settings-section">
        <h2 className="text-heading-sm">Account</h2>
        <p className="text-body-sm text-secondary settings-section-intro">
          {profile?.name || 'No name set'} · {user?.email || 'No email'}
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
          reasoning model. Responses you see right now are placeholders that demonstrate the interface only.
        </p>
      </section>

      {toast && <div className="settings-toast motion-reveal">{toast}</div>}
    </div>
  )
}
