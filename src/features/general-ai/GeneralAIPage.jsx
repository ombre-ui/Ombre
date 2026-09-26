import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useOmbreData } from '../../lib/store.jsx'
import { getMentorWithPath } from '../mentors/categories.js'
import EmptyStart from './EmptyStart.jsx'
import ConversationView from './ConversationView.jsx'
import './general-ai.css'

export default function GeneralAIPage() {
  const { conversationId } = useParams()
  const navigate = useNavigate()
  const { getConversation, createConversation, sendMessage, retryMessage } = useOmbreData()
  const [toast, setToast] = useState(null)

  const conversation = conversationId ? getConversation(conversationId) : null

  // A conversation id was in the URL but doesn't exist (e.g. stale link) —
  // fall back to a fresh draft rather than showing a dead page.
  if (conversationId && !conversation) {
    navigate('/app/general', { replace: true })
    return null
  }

  const mentorContext = conversation?.mentorId ? getMentorWithPath(conversation.mentorId) : null

  function handleFirstSend(text) {
    const id = createConversation({})
    sendMessage(id, text)
    navigate(`/app/general/${id}`, { replace: true })
  }

  function handleSend(text) {
    sendMessage(conversation.id, text)
  }

  function handleRetry(messageId) {
    retryMessage(conversation.id, messageId)
  }

  function handleLinked(projectId) {
    setToast('Added to project')
    window.setTimeout(() => setToast(null), 1600)
  }

  return (
    <div className="general-ai-page">
      {!conversation ? (
        <EmptyStart onSend={handleFirstSend} />
      ) : (
        <ConversationView
          conversation={conversation}
          mentorContext={mentorContext}
          onSend={handleSend}
          onRetry={handleRetry}
          onLinked={handleLinked}
        />
      )}
      {toast && <div className="general-ai-toast motion-reveal">{toast}</div>}
    </div>
  )
}
