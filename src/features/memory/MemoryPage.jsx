import { useState } from 'react'
import { Plus } from 'lucide-react'
import { useOmbreData } from '../../lib/store.jsx'
import PreviewNotice from '../../layout/PreviewNotice.jsx'
import MemoryItemCard from './MemoryItemCard.jsx'
import './memory.css'

export default function MemoryPage() {
  const { listMemoryItems, createMemoryItem, updateMemoryItem, deleteMemoryItem } = useOmbreData()
  const [adding, setAdding] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const [newContent, setNewContent] = useState('')

  const items = listMemoryItems()

  function handleAdd() {
    const content = newContent.trim()
    if (!content) return
    createMemoryItem(newLabel.trim() || 'Note', content)
    setNewLabel('')
    setNewContent('')
    setAdding(false)
  }

  return (
    <div className="memory-page section-warm motion-reveal">
      <header className="memory-header">
        <h1 className="text-heading-lg">Memory</h1>
        <p className="text-body text-secondary">
          What Ombre remembers, kept in plain view so you can review or remove anything, anytime.
        </p>
      </header>

      <PreviewNotice />

      {adding ? (
        <div className="memory-add-form motion-settle">
          <input
            className="memory-input text-label"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder="Label (optional)"
            aria-label="Memory label"
            autoFocus
          />
          <textarea
            className="memory-input memory-textarea text-body-sm"
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
            placeholder="What should Ombre remember?"
            aria-label="Memory content"
            rows={3}
          />
          <div className="memory-add-actions">
            <button type="button" className="memory-cancel motion-interactive" onClick={() => setAdding(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="memory-save motion-interactive"
              onClick={handleAdd}
              disabled={!newContent.trim()}
            >
              Save
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="memory-add-trigger motion-interactive" onClick={() => setAdding(true)}>
          <Plus size={14} strokeWidth={2} />
          Add memory
        </button>
      )}

      {items.length === 0 && !adding ? (
        <div className="memory-empty">
          <p className="text-body text-secondary">
            Nothing remembered yet. As you use Ombre, useful context can be kept here for you to
            review — nothing is stored without you being able to see and remove it.
          </p>
        </div>
      ) : (
        <div className="memory-grid">
          {items.map((item) => (
            <MemoryItemCard key={item.id} item={item} onSave={updateMemoryItem} onDelete={deleteMemoryItem} />
          ))}
        </div>
      )}
    </div>
  )
}
