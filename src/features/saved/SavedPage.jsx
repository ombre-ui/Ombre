import { useEffect, useState } from 'react'
import { Bookmark, ExternalLink, Trash2 } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useOmbreData } from '../../lib/store.jsx'
import './saved.css'

export default function SavedPage() {
  const navigate = useNavigate()
  const {
    listSavedItems,
    loadConversation,
    deleteSavedItem,
  } = useOmbreData()
  const [items, setItems] = useState([])
  const [conversations, setConversations] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [deletingId, setDeletingId] = useState(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      setError('')
      const saved = await listSavedItems()
      if (!saved.ok) {
        if (!cancelled) {
          setError(saved.error?.message ?? 'Couldn’t load saved messages.')
          setLoading(false)
        }
        return
      }

      const resolved = {}
      for (const item of saved.data.items) {
        if (!resolved[item.conversationId]) {
          const result = await loadConversation(item.conversationId)
          if (result.ok) resolved[item.conversationId] = result.data.conversation
        }
      }

      if (!cancelled) {
        setItems(saved.data.items)
        setConversations(resolved)
        setLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [listSavedItems, loadConversation])

  const handleDelete = async (id) => {
    setDeletingId(id)
    const result = await deleteSavedItem(id)
    if (result.ok) setItems((current) => current.filter((item) => item.id !== id))
    setDeletingId(null)
  }

  if (loading) {
    return <main className="page-shell saved-page"><p className="text-secondary">Loading saved messages…</p></main>
  }

  return (
    <main className="page-shell saved-page">
      <header className="saved-header">
        <div>
          <span className="text-label">Workspace</span>
          <h1 className="text-heading-lg">Saved</h1>
          <p className="text-body-sm text-secondary">Messages you intentionally bookmarked for later.</p>
        </div>
        <Bookmark size={22} strokeWidth={1.5} aria-hidden="true" />
      </header>

      {error && <p className="text-body-sm saved-error">{error}</p>}

      {!error && items.length === 0 && (
        <div className="saved-empty">
          <Bookmark size={24} strokeWidth={1.5} aria-hidden="true" />
          <h2 className="text-heading-sm">Nothing saved yet</h2>
          <p className="text-body-sm text-secondary">Bookmark a message in a conversation and it will appear here.</p>
        </div>
      )}

      <div className="saved-list">
        {items.map((item) => {
          const conversation = conversations[item.conversationId]
          const message = conversation?.messages?.find((entry) => entry.id === item.messageId)
          if (!message) return null

          return (
            <article key={item.id} className="saved-card">
              <div className="saved-card-top">
                <span className="text-meta">{conversation.title}</span>
                <button
                  type="button"
                  className="saved-delete motion-interactive"
                  onClick={() => handleDelete(item.id)}
                  disabled={deletingId === item.id}
                  aria-label="Remove saved message"
                >
                  <Trash2 size={15} strokeWidth={1.75} />
                </button>
              </div>
              <p className="text-body saved-message">{message.content}</p>
              <button
                type="button"
                className="saved-open motion-interactive"
                onClick={() => navigate(`/app/general/${conversation.id}`)}
              >
                Open conversation
                <ExternalLink size={14} strokeWidth={1.75} />
              </button>
            </article>
          )
        })}
      </div>
    </main>
  )
}
