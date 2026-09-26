import { useNavigate } from 'react-router-dom'
import { MENTOR_CATEGORIES } from './categories.js'
import './mentors.css'

export default function MentorsPage() {
  const navigate = useNavigate()

  return (
    <div className="mentors-page section-warm motion-reveal">
      <header className="mentors-header">
        <h1 className="text-heading-lg">Mentors</h1>
        <p className="text-body text-secondary">
          Specialized minds, organized by category. Choose one to go deeper.
        </p>
      </header>

      <div className="mentors-grid">
        {MENTOR_CATEGORIES.map(({ id, name, icon: Icon, description }) => (
          <button
            key={id}
            type="button"
            className="mentor-category-card motion-interactive motion-expand"
            data-state="collapsed"
            onClick={() => navigate(`/app/mentors/${id}`)}
          >
            <span className="mentor-category-icon">
              <Icon size={22} strokeWidth={1.6} aria-hidden="true" />
            </span>
            <span className="text-heading-sm mentor-category-name">{name}</span>
            <span className="text-body-sm text-secondary mentor-category-description">{description}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
