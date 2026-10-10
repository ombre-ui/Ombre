import { useState } from 'react'
import { Plus } from 'lucide-react'
import { useOmbreData } from '../../lib/store.jsx'
import PreviewNotice from '../../layout/PreviewNotice.jsx'
import ProjectCard from './ProjectCard.jsx'
import CreateProjectDialog from './CreateProjectDialog.jsx'
import './projects.css'

export default function ProjectsOverviewPage() {
  const { listProjects, createProject } = useOmbreData()
  const [showCreate, setShowCreate] = useState(false)
  const projects = listProjects()

  function handleCreate(name, description) {
    createProject(name, description)
    setShowCreate(false)
  }

  return (
    <div className="projects-page motion-reveal">
      <div className="projects-header">
        <h1 className="text-heading-lg">Projects</h1>
        <button
          type="button"
          className="projects-new motion-interactive"
          onClick={() => setShowCreate(true)}
        >
          <Plus size={16} strokeWidth={2} />
          New project
        </button>
      </div>

      <PreviewNotice />

      {projects.length === 0 ? (
        <div className="projects-empty">
          <p className="text-body text-secondary">
            Projects bring conversations, mentors, and files together around one piece of work.
            Create your first one to get started.
          </p>
        </div>
      ) : (
        <div className="projects-grid">
          {projects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              conversationCount={project.conversationIds.length}
            />
          ))}
        </div>
      )}

      {showCreate && (
        <CreateProjectDialog onCreate={handleCreate} onClose={() => setShowCreate(false)} />
      )}
    </div>
  )
}
