import { useEffect, useState } from 'react'
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useOmbreData } from '../../lib/store.jsx'
import { getMentorWithPath } from '../mentors/categories.js'
import EmptyStart from './EmptyStart.jsx'
import ConversationView from './ConversationView.jsx'
import './general-ai.css'

export default function GeneralAIPage() {
  const { conversationId } = useParams()
  const [searchParams] = useSearchParams()
  const projectId = searchParams.get('projectId') || null
  const mentorId = searchParams.get('mentorId') || null
  const navigate = useNavigate()
  const {
    getConversation,
    getConversationStatus,
    loadConversation,
    createConversation,
    sendMessage,
    retryMessage,
  } = useOmbreData()
  const [toast, setToast] = useState(null)
  const [sending, setSending] = useState(false)

  const conversation = conversationId ? getConversation(conversationId) : null
  const conversationStatus = conversationId ? getConversationStatus(conversationId) : 'idle'

  useEffect(() => {
    if (!conversationId || conversation || conversationStatus !== 'idle') return
    loadConversation(conversationId)
  }, [conversationId, conversation, conversationStatus, loadConversation])

  if (conversationId && conversationStatus === 'missing') {
    return <Navigate to="/app/general" replace />
  }

  async function handleReloadConversation() {
    await loadConversation(conversationId)
  }

  async function handleFirstSend(text) {
    setSending(true)
    const result = await createConversation({ content: text, projectId, mentorId })
    setSending(false)

    if (!result.ok) {
      setToast(result.error?.message ?? 'Couldn’t start the conversation.')
      window.setTimeout(() => setToast(null), 2400)
      return
    }

    navigate(`/app/general/${result.data.conversation.id}`, { replace: true })
  }

  async function handleSend(text) {
    const result = await sendMessage(conversation.id, text)
    if (!result.ok) {
      setToast(result.error?.message ?? 'Couldn’t send your message.')
      window.setTimeout(() => setToast(null), 2400)
    }
  }

  async function handleRetry(messageId) {
    const result = await retryMessage(conversation.id, messageId)
    if (!result.ok) {
      setToast(result.error?.message ?? 'Couldn’t retry this message.')
      window.setTimeout(() => setToast(null), 2400)
    }
  }

  function handleLinked() {
    setToast('Added to project')
    window.setTimeout(() => setToast(null), 1600)
  }

  const mentorContext = conversation?.mentorId ? getMentorWithPath(conversation.mentorId) : null

  return (
    <div className="general-ai-page">
      {conversationId && !conversation && (conversationStatus === 'idle' || conversationStatus === 'loading') ? (
        <div className="empty-start motion-reveal">
          <p className="text-body text-secondary empty-start-support">Loading conversation…</p>
        </div>
      ) : conversationId && !conversation && conversationStatus === 'error' ? (
        <div className="empty-start motion-reveal">
          <p className="text-body text-secondary empty-start-support">Couldn’t load this conversation.</p>
          <button type="button" className="button button-secondary" onClick={handleReloadConversation}>Try again</button>
        </div>
      ) : !conversation ? (
        <EmptyStart onSend={handleFirstSend} disabled={sending} />
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
