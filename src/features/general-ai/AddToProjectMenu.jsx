import { useEffect, useState } from 'react'
import { Link2 } from 'lucide-react'
import { useOmbreData } from '../../lib/store.jsx'
import './general-ai.css'

export default function AddToProjectMenu({ conversationId, currentProjectId, onLinked }) {
  const {
    listProjects,
    loadProjects,
    createProject,
    addConversationToProject,
  } = useOmbreData()
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [justLinked, setJustLinked] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const projects = listProjects()
  const currentProject = projects.find((p) => p.id === currentProjectId)

  useEffect(() => {
    if (!open) return
    let active = true
    setLoading(true)
    setError(null)

    loadProjects().then((result) => {
      if (!active) return
      if (!result.ok) setError(result.error?.message ?? 'Couldn’t load projects.')
      setLoading(false)
    })

    return () => {
      active = false
    }
  }, [loadProjects, open])

  async function link(projectId) {
    setLoading(true)
    setError(null)
    const result = await addConversationToProject(conversationId, projectId)
    if (!result.ok) {
      setError(result.error?.message ?? 'Couldn’t add this conversation to the project.')
      setLoading(false)
      return
    }

    setLoading(false)
    setOpen(false)
    setCreating(false)
    setNewName('')
    setJustLinked(true)
    onLinked?.(projectId)
    window.setTimeout(() => setJustLinked(false), 1600)
  }

  async function handleCreate() {
    const name = newName.trim()
    if (!name || loading) return

    setLoading(true)
    setError(null)
    const result = await createProject(name, '')
    if (!result.ok) {
      setError(result.error?.message ?? 'Couldn’t create the project.')
      setLoading(false)
      return
    }

    await link(result.data.project.id)
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
          {loading && projects.length === 0 && (
            <p className="text-meta">Loading projects…</p>
          )}

          {error && <p className="text-meta">{error}</p>}

          {projects.length > 0 && (
            <ul className="add-to-project-list">
              {projects.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    className="motion-interactive"
                    onClick={() => link(p.id)}
                    disabled={loading}
                  >
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
                disabled={loading}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              />
              <button type="button" className="motion-interactive" onClick={handleCreate} disabled={loading}>
                {loading ? 'Saving…' : 'Create'}
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="add-to-project-new motion-interactive"
              onClick={() => setCreating(true)}
              disabled={loading}
            >
              + New project
            </button>
          )}
        </div>
      )}
    </div>
  )
}
