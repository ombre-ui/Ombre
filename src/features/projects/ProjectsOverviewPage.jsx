import { useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { useOmbreData } from '../../lib/store.jsx'
import PreviewNotice from '../../layout/PreviewNotice.jsx'
import ProjectCard from './ProjectCard.jsx'
import CreateProjectDialog from './CreateProjectDialog.jsx'
import './projects.css'

export default function ProjectsOverviewPage() {
  const { listProjects, loadProjects, createProject } = useOmbreData()
  const [showCreate, setShowCreate] = useState(false)
  const [loadError, setLoadError] = useState(null)
  const projects = listProjects()

  useEffect(() => {
    let active = true
    loadProjects().then((result) => {
      if (!active || result.ok) return
      setLoadError(result.error?.message ?? 'Couldn’t load projects.')
    })
    return () => { active = false }
  }, [loadProjects])

  async function handleCreate(name, description) {
    const result = await createProject(name, description)
    if (!result.ok) {
      setLoadError(result.error?.message ?? 'Couldn’t create the project.')
      return
    }
    setLoadError(null)
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

      {loadError && <p className="text-body text-secondary">{loadError}</p>}

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
              conversationCount={project.conversationCount ?? project.conversationIds.length}
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
