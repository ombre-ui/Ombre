import { useNavigate, useParams } from 'react-router-dom'
import { getSubcategory } from './categories.js'
import MentorBreadcrumb from './MentorBreadcrumb.jsx'
import MentorCard from './MentorCard.jsx'
import './mentors.css'

export default function MentorSubcategoryPage() {
  const { categoryId, subcategoryId } = useParams()
  const navigate = useNavigate()
  const found = getSubcategory(categoryId, subcategoryId)

  if (!found) {
    navigate('/app/mentors', { replace: true })
    return null
  }

  const { category, subcategory } = found

  return (
    <div className="mentor-category-page section-warm motion-return">
      <MentorBreadcrumb
        trail={[
          { label: 'Mentors', onClick: () => navigate('/app/mentors') },
          { label: category.name, onClick: () => navigate(`/app/mentors/${category.id}`) },
          { label: subcategory.name },
        ]}
      />

      <header className="mentor-category-header">
        <h1 className="text-heading-lg">{subcategory.name}</h1>
        <p className="text-body text-secondary">
          Part of {category.name}. Choose a mentor to see what it helps with.
        </p>
      </header>

      <div className="mentors-grid">
        {subcategory.mentors.map((mentor) => (
          <MentorCard
            key={mentor.id}
            mentor={mentor}
            onClick={() => navigate(`/app/mentors/${category.id}/${subcategory.id}/${mentor.id}`)}
          />
        ))}
      </div>
    </div>
  )
}
