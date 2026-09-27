import { useState } from 'react'
import { useOmbreData } from '../../lib/store.jsx'
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
  const { getProfile, updateProfile } = useOmbreData()
  const profile = getProfile()
  const [isEditing, setIsEditing] = useState(false)
  const [name, setName] = useState(profile?.name ?? '')
  const [email, setEmail] = useState(profile?.email ?? '')
  const [toast, setToast] = useState(null)

  if (!profile) return null

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
    setToast('There\u2019s no account signed in yet \u2014 authentication isn\u2019t connected.')
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
        <h2 className="text-heading-sm">Personalization</h2>
        <p className="text-body-sm text-secondary">
          Response style and how Ombre personalizes its answers live in{' '}
          <a href="/app/settings#ai" className="profile-link">
            Settings → AI &amp; Personalization
          </a>
          .
        </p>
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
