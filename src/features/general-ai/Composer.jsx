import { useState } from 'react'
import { Send, Paperclip } from 'lucide-react'
import './general-ai.css'

export default function Composer({ onSend, disabled = false, autoFocus = false }) {
  const [value, setValue] = useState('')

  const trimmed = value.trim()
  const canSend = trimmed.length > 0 && !disabled

  function handleSend() {
    if (!canSend) return
    onSend(trimmed)
    setValue('')
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  function autoGrow(e) {
    const el = e.target
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }

  return (
    <div className={`composer motion-settle ${disabled ? 'is-disabled' : ''}`}>
      <button
        type="button"
        className="composer-attach motion-interactive"
        disabled
        aria-label="Attach a file (coming soon)"
        title="Attachments coming soon"
      >
        <Paperclip size={18} strokeWidth={1.75} />
      </button>

      <textarea
        className="composer-input text-body"
        placeholder="Ask Ombre..."
        rows={1}
        value={value}
        autoFocus={autoFocus}
        disabled={disabled}
        onChange={(e) => {
          setValue(e.target.value)
          autoGrow(e)
        }}
        onKeyDown={handleKeyDown}
        aria-label="Message Ombre"
      />

      <button
        type="button"
        className="composer-send motion-interactive"
        onClick={handleSend}
        disabled={!canSend}
        aria-label="Send message"
      >
        <Send size={16} strokeWidth={2} />
      </button>
    </div>
  )
}
