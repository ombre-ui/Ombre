import { useNavigate, useParams } from 'react-router-dom'
import { getMentor } from './categories.js'
import { useOmbreData } from '../../lib/store.jsx'
import MentorBreadcrumb from './MentorBreadcrumb.jsx'
import './mentors.css'

export default function MentorProfilePage() {
  const { categoryId, subcategoryId, mentorId } = useParams()
  const navigate = useNavigate()
  const { createConversation } = useOmbreData()
  const found = getMentor(categoryId, subcategoryId, mentorId)

  if (!found) {
    navigate('/app/mentors', { replace: true })
    return null
  }

  const { category, subcategory, mentor } = found

  function handleStartConversation() {
    const id = createConversation({ mentorId: mentor.id })
    navigate(`/app/general/${id}`)
  }

  return (
    <div className="mentor-profile-page section-warm motion-return">
      <MentorBreadcrumb
        trail={[
          { label: 'Mentors', onClick: () => navigate('/app/mentors') },
          { label: category.name, onClick: () => navigate(`/app/mentors/${category.id}`) },
          {
            label: subcategory.name,
            onClick: () => navigate(`/app/mentors/${category.id}/${subcategory.id}`),
          },
          { label: mentor.name },
        ]}
      />

      <div className="mentor-profile-header">
        <span className="text-label">
          {category.name} · {subcategory.name}
        </span>
        <h1 className="text-heading-lg">{mentor.name}</h1>
        <p className="text-body mentor-profile-description">{mentor.description}</p>

        <div className="mentor-profile-actions">
          <button
            type="button"
            className="mentor-profile-action mentor-profile-action-primary motion-interactive"
            onClick={handleStartConversation}
          >
            Start conversation
          </button>
          <button
            type="button"
            className="mentor-profile-action mentor-profile-action-ghost motion-interactive"
            disabled
            title="Adding a mentor directly to a project is coming soon"
          >
            Add to project
          </button>
        </div>
      </div>
    </div>
  )
}
