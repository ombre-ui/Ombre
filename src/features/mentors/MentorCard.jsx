export default function MentorCard({ mentor, onClick }) {
  const teaser = mentor.description.split('. ')[0] + '.'
  return (
    <button type="button" className="mentor-card motion-interactive motion-reveal" onClick={onClick}>
      <h3 className="text-heading-sm mentor-card-name">{mentor.name}</h3>
      <p className="text-body-sm text-secondary mentor-card-teaser">{teaser}</p>
    </button>
  )
}
