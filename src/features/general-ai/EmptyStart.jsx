import Composer from './Composer.jsx'
import PreviewNotice from '../../layout/PreviewNotice.jsx'
import './general-ai.css'

export default function EmptyStart({ onSend }) {
  return (
    <div className="empty-start motion-reveal">
      <h1 className="text-heading-lg empty-start-heading">What are you thinking?</h1>
      <p className="text-body text-secondary empty-start-support">
        Ask anything, or bring in a specialized mentor once you know which direction this is going.
      </p>
      <PreviewNotice kind="demo" />
      <div className="empty-start-composer">
        <Composer onSend={onSend} autoFocus />
      </div>
    </div>
  )
}
