import Composer from './Composer.jsx'
import MessageList from './MessageList.jsx'
import AddToProjectMenu from './AddToProjectMenu.jsx'
import './general-ai.css'

export default function ConversationView({ conversation, onSend, onRetry, onLinked }) {
  return (
    <div className="conversation-view motion-return">
      <div className="conversation-header">
        <h2 className="text-heading-sm conversation-title">{conversation.title}</h2>
        <AddToProjectMenu
          conversationId={conversation.id}
          currentProjectId={conversation.projectId}
          onLinked={onLinked}
        />
      </div>

      <MessageList messages={conversation.messages} onRetry={onRetry} />

      <div className="conversation-composer">
        <Composer onSend={onSend} />
      </div>
    </div>
  )
}
