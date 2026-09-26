import { useState } from 'react'
import { Link2 } from 'lucide-react'
import { useOmbreData } from '../../lib/store.jsx'
import './general-ai.css'

export default function AddToProjectMenu({ conversationId, currentProjectId, onLinked }) {
  const { listProjects, createProject, addConversationToProject } = useOmbreData()
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [justLinked, setJustLinked] = useState(false)

  const projects = listProjects()
  const currentProject = projects.find((p) => p.id === currentProjectId)

  function link(projectId) {
    addConversationToProject(conversationId, projectId)
    setOpen(false)
    setCreating(false)
    setNewName('')
    setJustLinked(true)
    onLinked?.(projectId)
    window.setTimeout(() => setJustLinked(false), 1600)
  }

  function handleCreate() {
    const name = newName.trim()
    if (!name) return
    const id = createProject(name, '')
    link(id)
  }

  return (
    <div className="add-to-project">
      <button
        type="button"
        className={`add-to-project-trigger motion-interactive ${justLinked ? 'is-linked' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <Link2 size={14} strokeWidth={1.75} />
        {currentProject ? currentProject.name : 'Add to project'}
      </button>

      {open && (
        <div className="add-to-project-menu motion-reveal" role="menu">
          {projects.length > 0 && (
            <ul className="add-to-project-list">
              {projects.map((p) => (
                <li key={p.id}>
                  <button type="button" className="motion-interactive" onClick={() => link(p.id)}>
                    {p.name}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {creating ? (
            <div className="add-to-project-create">
              <input
                className="text-body-sm"
                autoFocus
                placeholder="Project name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              />
              <button type="button" className="motion-interactive" onClick={handleCreate}>
                Create
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="add-to-project-new motion-interactive"
              onClick={() => setCreating(true)}
            >
              + New project
            </button>
          )}
        </div>
      )}
    </div>
  )
}
