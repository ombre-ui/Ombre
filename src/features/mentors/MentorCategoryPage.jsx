import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { getCategory } from './categories.js'
import './mentors.css'

export default function MentorCategoryPage() {
  const { categoryId } = useParams()
  const navigate = useNavigate()
  const category = getCategory(categoryId)

  if (!category) {
    navigate('/app/mentors', { replace: true })
    return null
  }

  const Icon = category.icon

  return (
    <div className="mentor-category-page section-warm motion-return">
      <button
        type="button"
        className="mentors-back motion-interactive"
        onClick={() => navigate('/app/mentors')}
      >
        <ArrowLeft size={16} strokeWidth={1.75} />
        All categories
      </button>

      <header className="mentor-category-header">
        <span className="mentor-category-icon mentor-category-icon-lg">
          <Icon size={28} strokeWidth={1.5} aria-hidden="true" />
        </span>
        <h1 className="text-heading-lg">{category.name}</h1>
        <p className="text-body text-secondary">{category.description}</p>
      </header>

      <div className="mentors-grid">
        {category.subcategories.map((sub) => (
          <button
            key={sub.id}
            type="button"
            className="mentor-card motion-interactive motion-reveal"
            onClick={() => navigate(`/app/mentors/${category.id}/${sub.id}`)}
          >
            <h3 className="text-heading-sm mentor-card-name">{sub.name}</h3>
            <p className="text-meta">
              {sub.mentors.length} {sub.mentors.length === 1 ? 'mentor' : 'mentors'}
            </p>
          </button>
        ))}
      </div>
    </div>
  )
}
