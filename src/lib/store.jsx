import { createContext, useCallback, useContext, useEffect, useMemo, useReducer } from 'react'
import { createId, makeConversation, makeMessage, makeProject } from './types.js'

/**
 * MOCK / LOCAL DATA LAYER
 * ------------------------------------------------------------------
 * Everything in this file is a stand-in for a future backend. It persists
 * to localStorage only so the frontend architecture feels real to build
 * against — it is NOT a database and NOT an API client.
 *
 * Integration boundary: every exported function below (createConversation,
 * sendMessage, createProject, addConversationToProject, ...) is where a real
 * API / Supabase call will eventually replace the local state update. As
 * long as callers keep using these function names and shapes, swapping the
 * implementation later should not require changing General AI or Projects
 * components.
 *
 * sendMessage() specifically is the AI-integration boundary: it currently
 * fakes a delayed assistant reply. Replace its body with a real request
 * when the model/master-prompt are ready — the pending -> complete/error
 * message lifecycle it drives is already what the UI expects.
 */

const STORAGE_KEY = 'ombre-mock-data-v1'

function loadInitialState() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw)
  } catch {
    // ignore corrupt local data and fall back to empty state
  }
  return { conversations: {}, projects: {} }
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
    default:
      return state
  }
}

const OmbreDataContext = createContext(null)

export function OmbreDataProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, undefined, loadInitialState)

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }, [state])

  const createConversation = useCallback((opts) => {
    const conversation = makeConversation(opts)
    dispatch({ type: 'CREATE_CONVERSATION', conversation })
    return conversation.id
  }, [])

  const getConversation = useCallback((id) => state.conversations[id] ?? null, [state.conversations])

  // MOCK reply generator. Replace with a real API call — see file header.
  const generateMockReply = useCallback((conversationId, userText, messageId) => {
    const delay = 700 + Math.random() * 700
    window.setTimeout(() => {
      if (userText.trim().toLowerCase() === 'error') {
        dispatch({
          type: 'UPDATE_MESSAGE',
          conversationId,
          messageId,
          patch: { status: 'error', content: '' },
        })
        return
      }
      dispatch({
        type: 'UPDATE_MESSAGE',
        conversationId,
        messageId,
        patch: {
          status: 'complete',
          content:
            'This is a placeholder response — Ombre isn\u2019t connected to a reasoning model yet. Once the General AI integration is in place, this is where a real answer will appear.',
        },
      })
    }, delay)
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
      })
      dispatch({ type: 'ADD_MESSAGE', conversationId, message: assistantMessage })
      generateMockReply(conversationId, text, assistantMessage.id)
    },
    [generateMockReply]
  )

  const retryMessage = useCallback(
    (conversationId, messageId) => {
      dispatch({ type: 'UPDATE_MESSAGE', conversationId, messageId, patch: { status: 'pending' } })
      const conversation = state.conversations[conversationId]
      const lastUser = [...(conversation?.messages ?? [])].reverse().find((m) => m.role === 'user')
      generateMockReply(conversationId, lastUser?.content ?? '', messageId)
    },
    [generateMockReply, state.conversations]
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

  const value = useMemo(
    () => ({
      createConversation,
      getConversation,
      sendMessage,
      retryMessage,
      createProject,
      getProject,
      addConversationToProject,
      listProjects,
      listConversationsForProject,
    }),
    [
      createConversation,
      getConversation,
      sendMessage,
      retryMessage,
      createProject,
      getProject,
      addConversationToProject,
      listProjects,
      listConversationsForProject,
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
