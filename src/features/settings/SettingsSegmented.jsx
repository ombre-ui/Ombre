export default function SettingsSegmented({ label, options, value, onChange }) {
  return (
    <div className="settings-row settings-row-segmented">
      <div className="settings-row-text">
        <span className="text-body">{label}</span>
      </div>
      <div className="settings-segmented" role="tablist" aria-label={label}>
        {options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={value === opt.value}
            className={`settings-segmented-btn motion-interactive ${value === opt.value ? 'is-active' : ''}`}
            onClick={() => onChange(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  )
}
