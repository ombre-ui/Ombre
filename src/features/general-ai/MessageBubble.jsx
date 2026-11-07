import { Bookmark, RotateCcw } from 'lucide-react'
import './general-ai.css'
import '../../layout/PreviewNotice.css'

function PendingDots() {
  return (
    <span className="message-pending" role="status" aria-label="Preparing a demo response">
      <span className="message-pending-dot" />
      <span className="message-pending-dot" />
      <span className="message-pending-dot" />
    </span>
  )
}

export default function MessageBubble({ message, grouped, onRetry, saved = false, onToggleSave, saving = false }) {
  const isUser = message.role === 'user'

  return (
    <div
      className={`message-row ${isUser ? 'is-user' : 'is-assistant'} ${grouped ? 'is-grouped' : ''}`}
    >
      {isUser ? (
        <div className="message-content-with-save">
          <div className="message-bubble text-body">{message.content}</div>
          {onToggleSave && (
            <button type="button" className={`message-save motion-interactive ${saved ? 'is-saved' : ''}`} onClick={() => onToggleSave(message.id)} disabled={saving} aria-label={saved ? 'Remove saved message' : 'Save message'}>
              <Bookmark size={15} fill={saved ? 'currentColor' : 'none'} />
            </button>
          )}
        </div>
      ) : message.status === 'pending' ? (
        <PendingDots />
      ) : message.status === 'error' ? (
        <div className="message-error text-body-sm">
          <span>Something went wrong generating a response.</span>
          <button
            type="button"
            className="message-retry motion-interactive"
            onClick={() => onRetry(message.id)}
          >
            <RotateCcw size={14} strokeWidth={1.75} />
            Retry
          </button>
        </div>
      ) : (
        <div className="message-content-with-save">
          <div className="message-assistant-text text-body motion-reveal">
            {message.demo && <span className="message-demo-tag text-meta">Demo response</span>}
            <div>{message.content}</div>
          </div>
          {onToggleSave && (
            <button type="button" className={`message-save motion-interactive ${saved ? 'is-saved' : ''}`} onClick={() => onToggleSave(message.id)} disabled={saving} aria-label={saved ? 'Remove saved message' : 'Save message'}>
              <Bookmark size={15} fill={saved ? 'currentColor' : 'none'} />
            </button>
          )}
        </div>
      )}
    </div>
  )
}
