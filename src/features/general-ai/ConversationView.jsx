import Composer from './Composer.jsx'
import MessageList from './MessageList.jsx'
import AddToProjectMenu from './AddToProjectMenu.jsx'
import PreviewNotice from '../../layout/PreviewNotice.jsx'
import './general-ai.css'

export default function ConversationView({ conversation, mentorContext, onSend, onRetry, onLinked }) {
  const showMentorIntro = mentorContext && conversation.messages.length === 0

  return (
    <div className="conversation-view motion-return">
      <div className="conversation-header">
        <div className="conversation-header-titles">
          {mentorContext && (
            <span className="text-label conversation-mentor-path">
              {mentorContext.category.name} · {mentorContext.subcategory.name}
            </span>
          )}
          <h2 className="text-heading-sm conversation-title">
            {showMentorIntro ? mentorContext.mentor.name : conversation.title}
          </h2>
        </div>
        <AddToProjectMenu
          conversationId={conversation.id}
          currentProjectId={conversation.projectId}
          onLinked={onLinked}
        />
      </div>

      <PreviewNotice kind="demo" />

      {showMentorIntro && (
        <p className="text-body-sm text-secondary conversation-mentor-intro">
          This is a space to work with {mentorContext.mentor.name}. Ask your first question below.
        </p>
      )}

      <MessageList messages={conversation.messages} onRetry={onRetry} />

      <div className="conversation-composer">
        <Composer onSend={onSend} />
      </div>
    </div>
  )
}
