import { useNavigate } from 'react-router-dom'
import './projects.css'

export default function ProjectCard({ project, conversationCount }) {
  const navigate = useNavigate()
  return (
    <button
      type="button"
      className="project-card motion-interactive motion-reveal"
      onClick={() => navigate(`/app/projects/${project.id}`)}
    >
      <h3 className="text-heading-sm project-card-name">{project.name}</h3>
      {project.description && (
        <p className="text-body-sm text-secondary project-card-description">{project.description}</p>
      )}
      <span className="text-meta project-card-meta">
        {conversationCount} {conversationCount === 1 ? 'conversation' : 'conversations'}
      </span>
    </button>
  )
}
