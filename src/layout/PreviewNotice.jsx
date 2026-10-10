import './PreviewNotice.css'

const COPY = {
  preview: 'Preview only. What you add here isn’t saved to your account and disappears when you reload.',
  history: 'Preview only. Conversations here exist only until you reload; they aren’t saved to your account yet.',
  demo: 'Demo mode. Ombre isn’t connected to an AI model yet, so replies are placeholder text, and conversations aren’t saved.',
}

// Honest label for session-only or demo content (Projects, Memory, History, General AI until their real phases).
export default function PreviewNotice({ kind = 'preview', children }) {
  return (
    <p className="preview-notice text-body-sm text-secondary" role="note">
      {children ?? COPY[kind]}
    </p>
  )
}
