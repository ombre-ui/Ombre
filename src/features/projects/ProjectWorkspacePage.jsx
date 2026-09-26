import { useNavigate, useParams } from 'react-router-dom'
import { Plus } from 'lucide-react'
import { useOmbreData } from '../../lib/store.jsx'
import './projects.css'

export default function ProjectWorkspacePage() {
  const { projectId } = useParams()
  const navigate = useNavigate()
  const { getProject, listConversationsForProject, createConversation, sendMessage } = useOmbreData()

  const project = getProject(projectId)
  if (!project) {
    navigate('/app/projects', { replace: true })
    return null
  }

  const conversations = listConversationsForProject(projectId)

  function handleNewConversation() {
    const id = createConversation({ projectId })
    navigate(`/app/general/${id}`)
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
        {conversations.length === 0 ? (
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
                  <span className="text-meta">{c.messages.length} messages</span>
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
