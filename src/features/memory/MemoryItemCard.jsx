import { useState } from 'react'
import { Pencil, Trash2, Check, X } from 'lucide-react'
import './memory.css'

export default function MemoryItemCard({ item, onSave, onDelete }) {
  const [isEditing, setIsEditing] = useState(false)
  const [label, setLabel] = useState(item.label)
  const [content, setContent] = useState(item.content)

  function handleSave() {
    const trimmed = content.trim()
    if (!trimmed) return
    onSave(item.id, { label: label.trim() || 'Note', content: trimmed })
    setIsEditing(false)
  }

  function handleCancel() {
    setLabel(item.label)
    setContent(item.content)
    setIsEditing(false)
  }

  if (isEditing) {
    return (
      <div className="memory-card is-editing motion-settle">
        <input
          className="memory-input text-label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label"
          aria-label="Memory label"
        />
        <textarea
          className="memory-input memory-textarea text-body-sm"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={3}
          autoFocus
          aria-label="Memory content"
        />
        <div className="memory-card-actions">
          <button
            type="button"
            className="memory-icon-btn motion-interactive"
            onClick={handleSave}
            aria-label="Save memory"
          >
            <Check size={15} strokeWidth={2} />
          </button>
          <button
            type="button"
            className="memory-icon-btn motion-interactive"
            onClick={handleCancel}
            aria-label="Cancel editing"
          >
            <X size={15} strokeWidth={2} />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="memory-card motion-reveal">
      <div className="memory-card-top">
        <span className="text-label memory-card-label">{item.label}</span>
        <div className="memory-card-actions">
          <button
            type="button"
            className="memory-icon-btn motion-interactive"
            onClick={() => setIsEditing(true)}
            aria-label={`Edit ${item.label}`}
          >
            <Pencil size={14} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            className="memory-icon-btn motion-interactive"
            onClick={() => onDelete(item.id)}
            aria-label={`Forget ${item.label}`}
          >
            <Trash2 size={14} strokeWidth={1.75} />
          </button>
        </div>
      </div>
      <p className="text-body-sm memory-card-content">{item.content}</p>
    </div>
  )
}
