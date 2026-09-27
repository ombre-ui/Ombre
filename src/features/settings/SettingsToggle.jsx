import './settings.css'

export default function SettingsToggle({ label, description, checked, onChange, disabled = false }) {
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <span className="text-body">{label}</span>
        {description && <span className="text-body-sm text-secondary">{description}</span>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className={`settings-switch motion-interactive ${checked ? 'is-on' : ''}`}
        onClick={() => !disabled && onChange(!checked)}
        disabled={disabled}
      >
        <span className="settings-switch-thumb" />
      </button>
    </div>
  )
}
