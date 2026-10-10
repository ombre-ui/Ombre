import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from 'react'
import { createId, makeConversation, makeMessage, makeProject, makeMemoryItem } from './types.js'

/**
 * SESSION-ONLY DEMO DATA LAYER
 * ------------------------------------------------------------------
 * Profile, settings and theme are NOT here any more: they are real, server-owned state in
 * src/lib/user/UserStateProvider.jsx (Supabase through the same-origin BFF).
 *
 * What remains is the demo stand-in for domains that have no backend yet: conversations, projects, memory
 * items and the (always empty) library. It is held in React memory only. It is never written to browser
 * storage (scripts/check-browser-storage.mjs enforces that), starts empty, and contains no seeded or
 * invented content, so a reload loses it. The UI says so (see PreviewNotice).
 *
 * Integration boundary: each exported function below is where a real API call replaces the local state update
 * in the phase that owns that domain (conversations, projects, memory, library). Keep the function names and
 * shapes and component code will not need to change.
 *
 * sendMessage() is the AI boundary. It does NOT call a model. It produces a clearly labelled DEMO reply
 * (message.demo === true) so the chat UI can be exercised; nothing it produces is model output.
 */

const DEMO_REPLY_TEXT =
  'Demo response: Ombre isn\u2019t connected to an AI model yet, so this is placeholder text, not an answer. Nothing in this conversation is saved.'

function initialState() {
  return { conversations: {}, projects: {}, libraryItems: {}, memoryItems: {} }
}

function reducer(state, action) {
  switch (action.type) {
    case 'CREATE_CONVERSATION': {
      const conversation = action.conversation
      return { ...state, conversations: { ...state.conversations, [conversation.id]: conversation } }
    }
    case 'ADD_MESSAGE': {
      const { conversationId, message } = action
      const conversation = state.conversations[conversationId]
      if (!conversation) return state
      const isFirstUserMessage = conversation.messages.length === 0 && message.role === 'user'
      const updated = {
        ...conversation,
        title: isFirstUserMessage ? message.content.slice(0, 60) : conversation.title,
        messages: [...conversation.messages, message],
        updatedAt: new Date().toISOString(),
      }
      return { ...state, conversations: { ...state.conversations, [conversationId]: updated } }
    }
    case 'UPDATE_MESSAGE': {
      const { conversationId, messageId, patch } = action
      const conversation = state.conversations[conversationId]
      if (!conversation) return state
      const messages = conversation.messages.map((m) => (m.id === messageId ? { ...m, ...patch } : m))
      return {
        ...state,
        conversations: {
          ...state.conversations,
          [conversationId]: { ...conversation, messages, updatedAt: new Date().toISOString() },
        },
      }
    }
    case 'CREATE_PROJECT': {
      const project = action.project
      return { ...state, projects: { ...state.projects, [project.id]: project } }
    }
    case 'ADD_CONVERSATION_TO_PROJECT': {
      const { conversationId, projectId } = action
      const project = state.projects[projectId]
      const conversation = state.conversations[conversationId]
      if (!project || !conversation) return state
      const conversationIds = project.conversationIds.includes(conversationId)
        ? project.conversationIds
        : [...project.conversationIds, conversationId]
      return {
        ...state,
        projects: { ...state.projects, [projectId]: { ...project, conversationIds } },
        conversations: {
          ...state.conversations,
          [conversationId]: { ...conversation, projectId },
        },
      }
    }
    case 'ADD_MEMORY_ITEM': {
      const item = action.item
      return { ...state, memoryItems: { ...state.memoryItems, [item.id]: item } }
    }
    case 'UPDATE_MEMORY_ITEM': {
      const { id, patch } = action
      const item = state.memoryItems[id]
      if (!item) return state
      return {
        ...state,
        memoryItems: {
          ...state.memoryItems,
          [id]: { ...item, ...patch, updatedAt: new Date().toISOString() },
        },
      }
    }
    case 'DELETE_MEMORY_ITEM': {
      const { id } = action
      const next = { ...state.memoryItems }
      delete next[id]
      return { ...state, memoryItems: next }
    }
    default:
      return state
  }
}

const OmbreDataContext = createContext(null)

export function OmbreDataProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, undefined, initialState)

  const createConversation = useCallback((opts) => {
    const conversation = makeConversation(opts)
    dispatch({ type: 'CREATE_CONVERSATION', conversation })
    return conversation.id
  }, [])

  const getConversation = useCallback((id) => state.conversations[id] ?? null, [state.conversations])

  const listConversations = useCallback(
    () => Object.values(state.conversations).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)),
    [state.conversations]
  )

  // Pending demo-reply timers, cleared on unmount so nothing fires after sign-out/navigation.
  const timers = useRef(new Set())
  useEffect(() => {
    const active = timers.current
    return () => {
      active.forEach((id) => window.clearTimeout(id))
      active.clear()
    }
  }, [])

  // DEMO reply generator. Not a model. Replace with a real API call in the General AI phase.
  const generateDemoReply = useCallback((conversationId, userText, messageId) => {
    const delay = 700 + Math.random() * 700
    const id = window.setTimeout(() => {
      timers.current.delete(id)
      if (userText.trim().toLowerCase() === 'error') {
        dispatch({ type: 'UPDATE_MESSAGE', conversationId, messageId, patch: { status: 'error', content: '' } })
        return
      }
      dispatch({
        type: 'UPDATE_MESSAGE',
        conversationId,
        messageId,
        patch: { status: 'complete', content: DEMO_REPLY_TEXT },
      })
    }, delay)
    timers.current.add(id)
  }, [])

  const sendMessage = useCallback(
    (conversationId, text) => {
      const userMessage = makeMessage({ conversationId, role: 'user', content: text, status: 'complete' })
      dispatch({ type: 'ADD_MESSAGE', conversationId, message: userMessage })

      const assistantMessage = makeMessage({
        conversationId,
        role: 'assistant',
        content: '',
        status: 'pending',
        demo: true,
      })
      dispatch({ type: 'ADD_MESSAGE', conversationId, message: assistantMessage })
      generateDemoReply(conversationId, text, assistantMessage.id)
    },
    [generateDemoReply]
  )

  const retryMessage = useCallback(
    (conversationId, messageId) => {
      dispatch({ type: 'UPDATE_MESSAGE', conversationId, messageId, patch: { status: 'pending' } })
      const conversation = state.conversations[conversationId]
      const lastUser = [...(conversation?.messages ?? [])].reverse().find((m) => m.role === 'user')
      generateDemoReply(conversationId, lastUser?.content ?? '', messageId)
    },
    [generateDemoReply, state.conversations]
  )

  const createProject = useCallback((name, description) => {
    const project = makeProject({ name, description })
    dispatch({ type: 'CREATE_PROJECT', project })
    return project.id
  }, [])

  const getProject = useCallback((id) => state.projects[id] ?? null, [state.projects])

  const addConversationToProject = useCallback((conversationId, projectId) => {
    dispatch({ type: 'ADD_CONVERSATION_TO_PROJECT', conversationId, projectId })
  }, [])

  const listProjects = useCallback(
    () => Object.values(state.projects).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    [state.projects]
  )

  const listConversationsForProject = useCallback(
    (projectId) => {
      const project = state.projects[projectId]
      if (!project) return []
      return project.conversationIds
        .map((id) => state.conversations[id])
        .filter(Boolean)
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    },
    [state.projects, state.conversations]
  )

  // The library has no add path yet, so this is always empty until the Library phase.
  const listLibraryItems = useCallback(
    (filter = 'all') => {
      const items = Object.values(state.libraryItems)
      const filtered = filter === 'all' ? items : items.filter((item) => item.source === filter)
      return filtered.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    },
    [state.libraryItems]
  )

  const listMemoryItems = useCallback(
    () => Object.values(state.memoryItems).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)),
    [state.memoryItems]
  )

  const createMemoryItem = useCallback((label, content) => {
    const item = makeMemoryItem({ label, content })
    dispatch({ type: 'ADD_MEMORY_ITEM', item })
    return item.id
  }, [])

  const updateMemoryItem = useCallback((id, patch) => {
    dispatch({ type: 'UPDATE_MEMORY_ITEM', id, patch })
  }, [])

  const deleteMemoryItem = useCallback((id) => {
    dispatch({ type: 'DELETE_MEMORY_ITEM', id })
  }, [])

  const value = useMemo(
    () => ({
      createConversation,
      getConversation,
      listConversations,
      sendMessage,
      retryMessage,
      createProject,
      getProject,
      addConversationToProject,
      listProjects,
      listConversationsForProject,
      listLibraryItems,
      listMemoryItems,
      createMemoryItem,
      updateMemoryItem,
      deleteMemoryItem,
    }),
    [
      createConversation,
      getConversation,
      listConversations,
      sendMessage,
      retryMessage,
      createProject,
      getProject,
      addConversationToProject,
      listProjects,
      listConversationsForProject,
      listLibraryItems,
      listMemoryItems,
      createMemoryItem,
      updateMemoryItem,
      deleteMemoryItem,
    ]
  )

  return <OmbreDataContext.Provider value={value}>{children}</OmbreDataContext.Provider>
}

export function useOmbreData() {
  const ctx = useContext(OmbreDataContext)
  if (!ctx) throw new Error('useOmbreData must be used within OmbreDataProvider')
  return ctx
}

export { createId }
