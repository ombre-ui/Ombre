import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search } from 'lucide-react'
import { useOmbreData } from '../../lib/store.jsx'
import { getMentorWithPath } from '../mentors/categories.js'
import './history.css'

const BUCKET_ORDER = ['Today', 'Yesterday', 'Previous 7 days', 'Older']

function bucketFor(dateStr) {
  const d = new Date(dateStr)
  const now = new Date()
  const startOfDay = (dt) => new Date(dt.getFullYear(), dt.getMonth(), dt.getDate())
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86400000)
  if (diffDays <= 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  if (diffDays <= 7) return 'Previous 7 days'
  return 'Older'
}

function formatMeta(conversation) {
  const time = new Date(conversation.updatedAt).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
  const count = conversation.messages.length
  return `${time} · ${count} ${count === 1 ? 'message' : 'messages'}`
}

export default function HistoryPage() {
  const { listConversations, getProject } = useOmbreData()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')

  const conversations = listConversations()

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return conversations
    return conversations.filter((c) => c.title.toLowerCase().includes(q))
  }, [conversations, query])

  const grouped = useMemo(() => {
    const groups = {}
    filtered.forEach((c) => {
      const bucket = bucketFor(c.updatedAt)
      groups[bucket] = groups[bucket] || []
      groups[bucket].push(c)
    })
    return groups
  }, [filtered])

  return (
    <div className="history-page motion-reveal">
      <header className="history-header">
        <h1 className="text-heading-lg">History</h1>
        <p className="text-body text-secondary">Where your thinking has been.</p>
      </header>

      <div className="history-search">
        <Search size={16} strokeWidth={1.75} aria-hidden="true" />
        <input
          type="text"
          placeholder="Search conversations"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search conversations"
        />
      </div>

      {conversations.length === 0 ? (
        <div className="history-empty">
          <p className="text-body text-secondary">
            Nothing here yet. Conversations you have in General AI or with a mentor will appear here.
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="history-empty">
          <p className="text-body text-secondary">Nothing matches “{query}”.</p>
        </div>
      ) : (
        BUCKET_ORDER.filter((b) => grouped[b]?.length).map((bucket) => (
          <section key={bucket} className="history-group">
            <h2 className="text-label history-group-label">{bucket}</h2>
            <ul className="history-list">
              {grouped[bucket]
                .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
                .map((c) => {
                  const mentorContext = c.mentorId ? getMentorWithPath(c.mentorId) : null
                  const project = c.projectId ? getProject(c.projectId) : null
                  return (
                    <li key={c.id}>
                      <button
                        type="button"
                        className="history-item motion-interactive"
                        onClick={() => navigate(`/app/general/${c.id}`)}
                      >
                        <span className="history-item-main">
                          <span className="text-body history-item-title">{c.title}</span>
                          <span className="text-meta">{formatMeta(c)}</span>
                        </span>
                        {(mentorContext || project) && (
                          <span className="history-item-tags">
                            {mentorContext && (
                              <span className="history-tag history-tag-mentor">
                                {mentorContext.mentor.name}
                              </span>
                            )}
                            {project && <span className="history-tag">{project.name}</span>}
                          </span>
                        )}
                      </button>
                    </li>
                  )
                })}
            </ul>
          </section>
        ))
      )}
    </div>
  )
}
