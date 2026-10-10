import '../../layout/PreviewNotice.css'

// Honest placeholder for a server-owned resource that is loading or failed to load. Never shows defaults.
export default function StatePanel({ status, what, onRetry }) {
  if (status === 'loading') {
    return (
      <p className="user-state-panel text-body-sm text-secondary" role="status">
        Loading {what}…
      </p>
    )
  }
  return (
    <div className="user-state-panel" role="alert">
      <p className="text-body-sm text-secondary">We couldn’t load {what} right now.</p>
      <button type="button" className="user-state-retry motion-interactive" onClick={onRetry}>
        Try again
      </button>
    </div>
  )
}
