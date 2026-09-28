import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useOmbreData } from '../../lib/store.jsx'
import SettingsToggle from '../settings/SettingsToggle.jsx'
import './profile.css'

function initialsFor(name, email) {
  const source = name.trim() || email.trim()
  if (!source) return '?'
  return source
    .split(/\s+/)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase())
    .join('')
}

export default function ProfilePage() {
  const {
    getProfile,
    updateProfile,
    listConversations,
    listMemoryItems,
    getSettings,
    updateSettings,
  } = useOmbreData()
  const profile = getProfile()
  const [isEditing, setIsEditing] = useState(false)
  const [name, setName] = useState(profile?.name ?? '')
  const [email, setEmail] = useState(profile?.email ?? '')
  const [toast, setToast] = useState(null)

  if (!profile) return null

  const settings = getSettings()
  const conversations = listConversations()
  const mentorsUsedCount = new Set(conversations.filter((c) => c.mentorId).map((c) => c.mentorId)).size
  const memoryCount = listMemoryItems().length

  function handleSave() {
    updateProfile({ name: name.trim(), email: email.trim() })
    setIsEditing(false)
  }

  function handleCancel() {
    setName(profile.name)
    setEmail(profile.email)
    setIsEditing(false)
  }

  function handleSignOut() {
    setToast('There’s no account signed in yet — authentication isn’t connected.')
    window.setTimeout(() => setToast(null), 2400)
  }

  const localSinceLabel = new Date(profile.localSince).toLocaleDateString(undefined, {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })

  return (
    <div className="profile-page motion-reveal">
      <header className="profile-header">
        <h1 className="text-heading-lg">Profile</h1>
        <p className="text-body text-secondary">How Ombre identifies you — nothing here is synced anywhere yet.</p>
      </header>

      <section className="profile-card">
        <div className="profile-identity">
          <span className="profile-avatar" aria-hidden="true">
            {initialsFor(name, email)}
          </span>

          {isEditing ? (
            <div className="profile-fields">
              <label className="text-label" htmlFor="profile-name">
                Name
              </label>
              <input
                id="profile-name"
                className="profile-input text-body"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
                autoFocus
              />
              <label className="text-label" htmlFor="profile-email">
                Email
              </label>
              <input
                id="profile-email"
                type="email"
                className="profile-input text-body"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
              <div className="profile-edit-actions">
                <button type="button" className="profile-btn-ghost motion-interactive" onClick={handleCancel}>
                  Cancel
                </button>
                <button type="button" className="profile-btn-primary motion-interactive" onClick={handleSave}>
                  Save
                </button>
              </div>
            </div>
          ) : (
            <div className="profile-fields">
              <span className="text-heading-sm profile-name">{profile.name || 'Your name'}</span>
              <span className="text-body-sm text-secondary">{profile.email || 'you@example.com'}</span>
              <button
                type="button"
                className="profile-btn-ghost motion-interactive profile-edit-trigger"
                onClick={() => setIsEditing(true)}
              >
                Edit profile
              </button>
            </div>
          )}
        </div>
      </section>

      <section className="profile-section">
        <h2 className="text-heading-sm">Account information</h2>
        <p className="text-body-sm text-secondary">Using Ombre locally since {localSinceLabel}.</p>
      </section>

      <section className="profile-section">
        <h2 className="text-heading-sm">Usage</h2>
        <p className="text-body-sm text-secondary profile-section-intro">
          There’s no plan or billing system yet — this is a local snapshot only.
        </p>
        <div className="profile-stat-row">
          <span className="text-body-sm text-secondary">Plan</span>
          <span className="text-body-sm">Preview build</span>
        </div>
        <div className="profile-stat-row">
          <span className="text-body-sm text-secondary">Conversations</span>
          <span className="text-body-sm">{conversations.length}</span>
        </div>
        <div className="profile-stat-row">
          <span className="text-body-sm text-secondary">Mentors used</span>
          <span className="text-body-sm">{mentorsUsedCount}</span>
        </div>
      </section>

      <section className="profile-section">
        <h2 className="text-heading-sm">Personalization</h2>
        <p className="text-body-sm text-secondary">
          Response style and how Ombre personalizes its answers live in{' '}
          <Link to="/app/settings#ai" className="profile-link">
            Settings → AI &amp; Personalization
          </Link>
          .
        </p>
      </section>

      <section className="profile-section">
        <h2 className="text-heading-sm">Memory</h2>
        <p className="text-body-sm text-secondary">
          {memoryCount === 0
            ? 'Nothing remembered yet.'
            : `${memoryCount} item${memoryCount === 1 ? '' : 's'} remembered.`}{' '}
          <Link to="/app/memory" className="profile-link">
            View Memory
          </Link>
          .
        </p>
        <SettingsToggle
          label="Remember context across conversations"
          description="Allow Ombre to use Memory when responding. Full controls are in Settings → Memory."
          checked={settings.privacy.rememberContext}
          onChange={(v) => updateSettings({ privacy: { ...settings.privacy, rememberContext: v } })}
        />
      </section>

      <section className="profile-section profile-section-danger">
        <h2 className="text-heading-sm">Account actions</h2>
        <div className="profile-actions">
          <button type="button" className="profile-btn-ghost motion-interactive" onClick={handleSignOut}>
            Sign out
          </button>
          <button
            type="button"
            className="profile-btn-danger motion-interactive"
            disabled
            title="Account deletion isn't available yet"
          >
            Delete account
          </button>
        </div>
      </section>

      {toast && <div className="profile-toast motion-reveal">{toast}</div>}
    </div>
  )
}
