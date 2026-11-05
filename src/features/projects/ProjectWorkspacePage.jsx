import { useEffect, useState } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router-dom'
import { Plus } from 'lucide-react'
import { useOmbreData } from '../../lib/store.jsx'
import './projects.css'

export default function ProjectWorkspacePage() {
  const { projectId } = useParams()
  const navigate = useNavigate()
  const {
    getProject,
    loadProjects,
    listConversationsForProject,
  } = useOmbreData()
  const [projectLoading, setProjectLoading] = useState(true)
  const [projectLoadFailed, setProjectLoadFailed] = useState(false)
  const [conversations, setConversations] = useState([])
  const [conversationsLoading, setConversationsLoading] = useState(true)
  const [conversationLoadFailed, setConversationLoadFailed] = useState(false)

  const project = getProject(projectId)

  useEffect(() => {
    let active = true

    async function ensureProject() {
      if (project) {
        setProjectLoading(false)
        return
      }

      setProjectLoading(true)
      const result = await loadProjects()
      if (!active) return

      if (!result.ok || !result.data.projects.some((item) => item.id === projectId)) {
        setProjectLoadFailed(true)
      } else {
        setProjectLoadFailed(false)
      }
      setProjectLoading(false)
    }

    ensureProject()
    return () => {
      active = false
    }
  }, [loadProjects, project, projectId])

  useEffect(() => {
    if (!project) return

    let active = true
    setConversationsLoading(true)
    setConversationLoadFailed(false)

    listConversationsForProject(projectId).then((result) => {
      if (!active) return
      if (!result.ok) {
        setConversationLoadFailed(true)
        setConversations([])
      } else {
        setConversations(result.data.conversations)
      }
      setConversationsLoading(false)
    })

    return () => {
      active = false
    }
  }, [listConversationsForProject, project, projectId])

  if (projectLoading) {
    return (
      <div className="project-workspace motion-return">
        <p className="text-body text-secondary">Loading project…</p>
      </div>
    )
  }

  if (projectLoadFailed || !project) return <Navigate to="/app/projects" replace />

  function handleNewConversation() {
    navigate(`/app/general?projectId=${encodeURIComponent(projectId)}`)
  }

  return (
    <div className="project-workspace motion-return">
      <header className="project-header">
        <h1 className="text-heading-lg">{project.name}</h1>
        {project.description && (
          <p className="text-body text-secondary">{project.description}</p>
        )}
      </header>

      <section className="project-section">
        <div className="project-section-header">
          <h2 className="text-heading-sm">Conversations</h2>
          <button type="button" className="project-section-action motion-interactive" onClick={handleNewConversation}>
            <Plus size={14} strokeWidth={2} />
            New
          </button>
        </div>

        {conversationsLoading ? (
          <p className="text-body-sm text-secondary">Loading conversations…</p>
        ) : conversationLoadFailed ? (
          <p className="text-body-sm text-secondary">
            Couldn’t load this project’s conversations. Try opening the project again.
          </p>
        ) : conversations.length === 0 ? (
          <p className="text-body-sm text-secondary">
            No conversations yet. Start one here, or add an existing General AI conversation to
            this project.
          </p>
        ) : (
          <ul className="project-conversation-list">
            {conversations.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  className="project-conversation-item motion-interactive"
                  onClick={() => navigate(`/app/general/${c.id}`)}
                >
                  <span className="text-body">{c.title}</span>
                  <span className="text-meta">{c.messageCount ?? c.messages?.length ?? 0} messages</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="project-section section-warm">
        <h2 className="text-heading-sm">Mentors</h2>
        <p className="text-body-sm text-secondary">Mentor integration is coming in a later phase.</p>
      </section>

      <section className="project-section">
        <h2 className="text-heading-sm">Files</h2>
        <p className="text-body-sm text-secondary">Library integration is coming in a later phase.</p>
      </section>
    </div>
  )
}
