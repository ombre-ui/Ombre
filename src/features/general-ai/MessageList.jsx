import { useEffect, useRef } from 'react'
import MessageBubble from './MessageBubble.jsx'
import './general-ai.css'

export default function MessageList({ messages, onRetry }) {
  const endRef = useRef(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages.length, messages[messages.length - 1]?.status])

  return (
    <div className="message-list" role="log" aria-live="polite">
      {messages.map((message, i) => {
        const prev = messages[i - 1]
        const grouped = prev && prev.role === message.role
        return (
          <MessageBubble key={message.id} message={message} grouped={grouped} onRetry={onRetry} />
        )
      })}
      <div ref={endRef} />
    </div>
  )
}
