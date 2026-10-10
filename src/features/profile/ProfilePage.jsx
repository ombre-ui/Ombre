import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useUserState } from '../../lib/user/UserStateProvider.jsx'
import { useAuth } from '../../lib/auth/AuthProvider.jsx'
import StatePanel from '../../lib/user/StatePanel.jsx'
import SettingsToggle from '../settings/SettingsToggle.jsx'
import './profile.css'

const NAME_MAX_LENGTH = 100

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
  const { profile, settings, updateProfile, updateSettings, reload } = useUserState()
  const { user, signOut } = useAuth()
  const [isEditing, setIsEditing] = useState(false)
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState(null)

  const accountEmail = (profile.data && profile.data.email) || user?.email || ''
  const displayName = (profile.data && profile.data.displayName) || ''

  function showToast(message) {
    setToast(message)
    window.setTimeout(() => setToast(null), 2400)
  }

  function handleEdit() {
    setName(displayName)
    setIsEditing(true)
  }

  async function handleSave() {
    if (saving) return
    setSaving(true)
    const result = await updateProfile({ displayName: name })
    setSaving(false)
    if (result.ok) {
      setIsEditing(false)
    } else {
      // Stay in edit mode with the typed value so nothing is lost; the shown name has already reverted.
      showToast('Couldn’t save your name. Try again.')
    }
  }

  function handleCancel() {
    setIsEditing(false)
  }

  async function handleSignOut() {
    const result = await signOut()
    if (!result.ok) showToast('Couldn’t sign out. Check your connection and try again.')
  }

  async function handleRememberContext(value) {
    const result = await updateSettings({ privacy: { rememberContext: value } })
    if (!result.ok) showToast('Couldn’t save that change. Your setting wasn’t changed.')
  }

  const memberSince =
    profile.status === 'ready' && profile.data.createdAt
      ? new Date(profile.data.createdAt).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })
      : null

  return (
    <div className="profile-page motion-reveal">
      <header className="profile-header">
        <h1 className="text-heading-lg">Profile</h1>
        <p className="text-body text-secondary">How Ombre identifies you. Your name is saved to your account.</p>
      </header>

      {profile.status !== 'ready' ? (
        <StatePanel status={profile.status} what="your profile" onRetry={() => reload('profile')} />
      ) : (
        <section className="profile-card">
          <div className="profile-identity">
            <span className="profile-avatar" aria-hidden="true">
              {initialsFor(isEditing ? name : displayName, accountEmail)}
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
                  maxLength={NAME_MAX_LENGTH}
                  autoFocus
                />
                <span className="text-label">Email</span>
                <span className="text-body-sm text-secondary">{accountEmail}</span>
                <div className="profile-edit-actions">
                  <button type="button" className="profile-btn-ghost motion-interactive" onClick={handleCancel} disabled={saving}>
                    Cancel
                  </button>
                  <button type="button" className="profile-btn-primary motion-interactive" onClick={handleSave} disabled={saving}>
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="profile-fields">
                <span className="text-heading-sm profile-name">{displayName || 'Your name'}</span>
                <span className="text-body-sm text-secondary">{accountEmail}</span>
                <button type="button" className="profile-btn-ghost motion-interactive profile-edit-trigger" onClick={handleEdit}>
                  Edit profile
                </button>
              </div>
            )}
          </div>
        </section>
      )}

      {memberSince && (
        <section className="profile-section">
          <h2 className="text-heading-sm">Account information</h2>
          <p className="text-body-sm text-secondary">Member since {memberSince}.</p>
        </section>
      )}

      <section className="profile-section">
        <h2 className="text-heading-sm">Usage</h2>
        <p className="text-body-sm text-secondary profile-section-intro">
          Usage and plan details aren’t available yet. There’s no billing system, and conversations aren’t saved to your account yet.
        </p>
        <div className="profile-stat-row">
          <span className="text-body-sm text-secondary">Plan</span>
          <span className="text-body-sm text-secondary">Not available yet</span>
        </div>
        <div className="profile-stat-row">
          <span className="text-body-sm text-secondary">Conversations</span>
          <span className="text-body-sm text-secondary">Not available yet</span>
        </div>
        <div className="profile-stat-row">
          <span className="text-body-sm text-secondary">Mentors used</span>
          <span className="text-body-sm text-secondary">Not available yet</span>
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
          Memory isn’t connected to your account yet.{' '}
          <Link to="/app/memory" className="profile-link">
            View Memory
          </Link>
          .
        </p>
        {settings.status === 'ready' ? (
          <SettingsToggle
            label="Remember context across conversations"
            description="Allow Ombre to use Memory when responding. Full controls are in Settings → Memory."
            checked={settings.data.privacy.rememberContext}
            onChange={handleRememberContext}
          />
        ) : (
          <StatePanel status={settings.status} what="your preferences" onRetry={() => reload('settings')} />
        )}
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
