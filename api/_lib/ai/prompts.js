// Trusted system prompts. Server-only: never imported by src/.
//
// The system prompt is chosen from the conversation's stored mentor_id and nothing else. A client never supplies,
// edits or influences it. There are exactly two kinds:
//   mentor_id null        -> GENERAL_AI_PROMPT
//   a known mentor id     -> that mentor's prompt, exactly as in mentor-prompts/<id>.md (generated module)
// There is no fallback: an unknown mentor id is an error, never "answer as General AI" and never a generic mentor.
// A mentor conversation gets only its mentor prompt; the General AI prompt is not prepended or appended.
import { MENTOR_PROMPTS } from './mentorPromptsData.js'

// Approved text, exactly. Changing a character here changes what every General AI conversation is told.
export const GENERAL_AI_PROMPT =
  'You are Ombre, an AI workspace assistant. Help the user make useful progress on the work they bring to you. Be clear, accurate, thoughtful, and direct. Use the conversation context when relevant. Do not claim to have performed actions or accessed information that you have not actually accessed.'

export const MENTOR_PROMPT_IDS = Object.freeze(Object.keys(MENTOR_PROMPTS))

export class PromptError extends Error {
  constructor(code = 'unknown_mentor') {
    super(code)
    this.name = 'PromptError'
    this.code = code
  }
}

// `null` is the only value that means General AI. undefined (a column that was not selected), '' or anything else
// that is not a registered mentor id fails closed. The error never includes the offending value.
export function resolveSystemPrompt(mentorId) {
  if (mentorId === null) return GENERAL_AI_PROMPT
  if (typeof mentorId !== 'string' || !Object.hasOwn(MENTOR_PROMPTS, mentorId)) throw new PromptError('unknown_mentor')
  return MENTOR_PROMPTS[mentorId]
}
