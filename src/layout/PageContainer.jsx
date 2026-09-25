import './PageContainer.css'

export default function PageContainer({ title, description, children }) {
  return (
    <div className="page-container motion-reveal">
      <header className="page-header">
        <h1 className="text-heading-lg">{title}</h1>
        {description && <p className="text-body text-secondary page-description">{description}</p>}
      </header>
      {children}
    </div>
  )
}
