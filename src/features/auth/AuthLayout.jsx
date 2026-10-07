import './auth.css'

export default function AuthLayout({ title, subtitle, children, footer }) {
  return (
    <main className="auth-page">
      <div className="auth-card motion-reveal">
        <span className="auth-brand">Ombre</span>
        <h1 className="text-heading-lg auth-title">{title}</h1>
        {subtitle && <p className="text-body-sm text-secondary auth-subtitle">{subtitle}</p>}
        {children}
        {footer && <div className="auth-footer text-body-sm text-secondary">{footer}</div>}
      </div>
    </main>
  )
}

export function Field({ id, label, hint, ...inputProps }) {
  return (
    <div className="auth-field">
      <label className="text-label" htmlFor={id}>
        {label}
      </label>
      <input id={id} className="auth-input text-body" {...inputProps} />
      {hint && <span className="text-body-sm text-secondary">{hint}</span>}
    </div>
  )
}

export function FormError({ message }) {
  if (!message) return null
  return (
    <p className="auth-error text-body-sm" role="alert">
      {message}
    </p>
  )
}
