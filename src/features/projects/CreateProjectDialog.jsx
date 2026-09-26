import { useEffect, useRef, useState } from 'react'
import './projects.css'

export default function CreateProjectDialog({ onCreate, onClose }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const nameRef = useRef(null)

  useEffect(() => {
    nameRef.current?.focus()
    function onKey(e) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function handleSubmit(e) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    onCreate(trimmed, description.trim())
  }

  return (
    <div className="dialog-scrim motion-reveal" onClick={onClose}>
      <form
        className="dialog-panel motion-settle"
        role="dialog"
        aria-label="Create project"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h2 className="text-heading-sm dialog-title">New project</h2>

        <label className="text-label dialog-label" htmlFor="project-name">
          Name
        </label>
        <input
          id="project-name"
          ref={nameRef}
          className="dialog-input text-body"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Startup validation"
        />

        <label className="text-label dialog-label" htmlFor="project-description">
          Description <span className="text-secondary">(optional)</span>
        </label>
        <textarea
          id="project-description"
          className="dialog-input dialog-textarea text-body"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
        />

        <div className="dialog-actions">
          <button type="button" className="dialog-cancel motion-interactive" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="dialog-create motion-interactive" disabled={!name.trim()}>
            Create
          </button>
        </div>
      </form>
    </div>
  )
}
