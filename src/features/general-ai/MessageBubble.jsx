import { RotateCcw } from 'lucide-react'
import './general-ai.css'

function PendingDots() {
  return (
    <span className="message-pending" role="status" aria-label="Ombre is thinking">
      <span className="message-pending-dot" />
      <span className="message-pending-dot" />
      <span className="message-pending-dot" />
    </span>
  )
}

export default function MessageBubble({ message, grouped, onRetry }) {
  const isUser = message.role === 'user'

  return (
    <div
      className={`message-row ${isUser ? 'is-user' : 'is-assistant'} ${grouped ? 'is-grouped' : ''}`}
    >
      {isUser ? (
        <div className="message-bubble text-body">{message.content}</div>
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
        <div className="message-assistant-text text-body motion-reveal">{message.content}</div>
      )}
    </div>
  )
}
