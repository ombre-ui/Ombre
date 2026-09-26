export default function MentorBreadcrumb({ trail }) {
  return (
    <nav className="mentor-breadcrumb" aria-label="Mentor navigation">
      {trail.map((segment, i) => {
        const isLast = i === trail.length - 1
        return (
          <span key={segment.label} className="mentor-breadcrumb-segment">
            {i > 0 && <span className="mentor-breadcrumb-sep">/</span>}
            {isLast || !segment.onClick ? (
              <span className="mentor-breadcrumb-current">{segment.label}</span>
            ) : (
              <button type="button" onClick={segment.onClick}>
                {segment.label}
              </button>
            )}
          </span>
        )
      })}
    </nav>
  )
}
