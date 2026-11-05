import { createContext, useCallback, useContext, useMemo, useReducer } from 'react'
import { createId, makeMemoryItem } from './types.js'
import { apiRequest } from './auth/api.js'

function initialState() {
  return {
    conversations: {},
    projects: {},
    libraryItems: {},
    memoryItems: {},
    conversationStatus: {},
  }
}

function normalizeMessage(message) {
  return {
    id: message.id,
    conversationId: message.conversationId,
    seq: message.seq,
    role: message.role,
    content: message.content,
    status: message.status ?? 'complete',
    demo: message.isDemo === true,
    attachments: message.attachments ?? [],
    createdAt: message.createdAt,
  }
}

function normalizeConversation(conversation, messages = []) {
  return {
    id: conversation.id,
    title: conversation.title,
    projectId: conversation.projectId ?? null,
    mentorId: conversation.mentorId ?? null,
    messageCount: conversation.messageCount ?? messages.length,
    messages,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  }
}

function normalizeProject(project) {
  return {
    id: project.id,
    name: project.name,
    description: project.description ?? '',
    archivedAt: project.archivedAt ?? null,
    conversationCount: project.conversationCount ?? 0,
    conversationIds: [],
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  }
}

function reducer(state, action) {
  switch (action.type) {
    case 'SET_CONVERSATION_STATUS':
      return {
        ...state,
        conversationStatus: { ...state.conversationStatus, [action.id]: action.status },
      }
    case 'SET_CONVERSATION':
      return {
        ...state,
        conversations: { ...state.conversations, [action.conversation.id]: action.conversation },
        conversationStatus: { ...state.conversationStatus, [action.conversation.id]: 'ready' },
      }
    case 'SET_PROJECTS':
      return { ...state, projects: Object.fromEntries(action.projects.map((p) => [p.id, p])) }
    case 'SET_PROJECT':
      return { ...state, projects: { ...state.projects, [action.project.id]: action.project } }
    case 'SET_LIBRARY':
      return { ...state, libraryItems: Object.fromEntries(action.items.map((i) => [i.id, i])) }
    case 'ADD_MEMORY_ITEM':
      return { ...state, memoryItems: { ...state.memoryItems, [action.item.id]: action.item } }
    case 'UPDATE_MEMORY_ITEM': {
      const item = state.memoryItems[action.id]
      if (!item) return state
      return {
        ...state,
        memoryItems: {
          ...state.memoryItems,
          [action.id]: { ...item, ...action.patch, updatedAt: new Date().toISOString() },
        },
      }
    }
    case 'DELETE_MEMORY_ITEM': {
      const next = { ...state.memoryItems }
      delete next[action.id]
      return { ...state, memoryItems: next }
    }
    default:
      return state
  }
}

const OmbreDataContext = createContext(null)

export function OmbreDataProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, undefined, initialState)

  const loadConversation = useCallback(async (id) => {
    if (!id) return { ok: false, status: 400, error: { code: 'invalid_id', message: 'Conversation id is required.' } }

    dispatch({ type: 'SET_CONVERSATION_STATUS', id, status: 'loading' })
    const meta = await apiRequest(`/api/conversations/${id}`)
    if (!meta.ok) {
      dispatch({ type: 'SET_CONVERSATION_STATUS', id, status: meta.status === 404 ? 'missing' : 'error' })
      return meta
    }

    const messages = await apiRequest(`/api/conversations/${id}/messages?limit=100`)
    if (!messages.ok) {
      dispatch({ type: 'SET_CONVERSATION_STATUS', id, status: messages.status === 404 ? 'missing' : 'error' })
      return messages
    }

    const conversation = normalizeConversation(
      meta.data.conversation,
      (messages.data.messages ?? []).map(normalizeMessage),
    )
    dispatch({ type: 'SET_CONVERSATION', conversation })
    return { ok: true, data: { conversation } }
  }, [])

  const getConversation = useCallback((id) => state.conversations[id] ?? null, [state.conversations])

  const getConversationStatus = useCallback(
    (id) => (id ? state.conversationStatus[id] ?? 'idle' : 'idle'),
    [state.conversationStatus],
  )

  const listConversations = useCallback(async () => {
    const result = await apiRequest('/api/conversations?limit=100')
    if (!result.ok) return result
    const conversations = (result.data.conversations ?? []).map((c) => normalizeConversation(c))
    conversations.forEach((conversation) => dispatch({ type: 'SET_CONVERSATION', conversation }))
    return { ok: true, data: { conversations } }
  }, [])

  const createConversation = useCallback(async ({
    content,
    mentorId = null,
    projectId = null,
    clientRequestId = createId(),
  } = {}) => {
    if (!content?.trim()) {
      return { ok: false, status: 400, error: { code: 'invalid_content', message: 'A first message is required.' } }
    }

    const result = await apiRequest('/api/conversations', {
      method: 'POST',
      body: { content, clientRequestId, mentorId, projectId },
    })
    if (!result.ok) return result

    const message = normalizeMessage(result.data.message)
    const conversation = normalizeConversation(result.data.conversation, [message])
    dispatch({ type: 'SET_CONVERSATION', conversation })
    return { ok: true, data: { conversation, message } }
  }, [])

  const sendMessage = useCallback(async (conversationId, text, clientRequestId = createId()) => {
    if (!text?.trim()) {
      return { ok: false, status: 400, error: { code: 'invalid_content', message: 'Message cannot be empty.' } }
    }

    const result = await apiRequest(`/api/conversations/${conversationId}/messages`, {
      method: 'POST',
      body: { role: 'user', content: text, clientRequestId },
    })
    if (!result.ok) return result

    const message = normalizeMessage(result.data.message)
    const current = state.conversations[conversationId]
    if (current) {
      dispatch({
        type: 'SET_CONVERSATION',
        conversation: {
          ...current,
          messages: [...current.messages, message],
          messageCount: Math.max(current.messageCount ?? 0, message.seq),
          updatedAt: message.createdAt,
        },
      })
    } else {
      await loadConversation(conversationId)
    }
    return { ok: true, data: { message } }
  }, [loadConversation, state.conversations])

  const retryMessage = useCallback(async () => ({
    ok: false,
    status: 501,
    error: { code: 'ai_unavailable', message: 'AI generation is not connected yet.' },
  }), [])

  const loadProjects = useCallback(async () => {
    const result = await apiRequest('/api/projects?limit=100')
    if (!result.ok) return result
    const projects = (result.data.projects ?? []).map(normalizeProject)
    dispatch({ type: 'SET_PROJECTS', projects })
    return { ok: true, data: { projects } }
  }, [])

  const createProject = useCallback(async (name, description = '') => {
    const result = await apiRequest('/api/projects', {
      method: 'POST',
      body: { name, description },
    })
    if (!result.ok) return result
    const project = normalizeProject(result.data.project)
    dispatch({ type: 'SET_PROJECT', project })
    return { ok: true, data: { project } }
  }, [])

  const getProject = useCallback((id) => state.projects[id] ?? null, [state.projects])

  const addConversationToProject = useCallback(async (conversationId, projectId) => {
    const result = await apiRequest(`/api/conversations/${conversationId}`, {
      method: 'PATCH',
      body: { projectId },
    })
    if (!result.ok) return result

    const current = state.conversations[conversationId]
    const conversation = normalizeConversation(result.data.conversation, current?.messages ?? [])
    dispatch({ type: 'SET_CONVERSATION', conversation })
    await loadProjects()
    return { ok: true, data: { conversation } }
  }, [loadProjects, state.conversations])

  const listProjects = useCallback(
    () => Object.values(state.projects).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)),
    [state.projects],
  )

  const listConversationsForProject = useCallback(async (projectId) => {
    const result = await apiRequest(`/api/conversations?projectId=${encodeURIComponent(projectId)}&limit=100`)
    if (!result.ok) return result
    const conversations = (result.data.conversations ?? []).map((c) => normalizeConversation(c))
    conversations.forEach((conversation) => dispatch({ type: 'SET_CONVERSATION', conversation }))
    return { ok: true, data: { conversations } }
  }, [])

  const listLibraryItems = useCallback(async (filter = 'all') => {
    const query = filter === 'all' ? '' : `?source=${encodeURIComponent(filter)}`
    const result = await apiRequest(`/api/library${query}`)
    if (!result.ok) return result
    const items = result.data.items ?? []
    dispatch({ type: 'SET_LIBRARY', items })
    return { ok: true, data: { items } }
  }, [])

  const listMemoryItems = useCallback(
    () => Object.values(state.memoryItems).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)),
    [state.memoryItems],
  )

  const createMemoryItem = useCallback((label, content) => {
    const item = makeMemoryItem({ label, content })
    dispatch({ type: 'ADD_MEMORY_ITEM', item })
    return item.id
  }, [])

  const updateMemoryItem = useCallback((id, patch) => dispatch({ type: 'UPDATE_MEMORY_ITEM', id, patch }), [])
  const deleteMemoryItem = useCallback((id) => dispatch({ type: 'DELETE_MEMORY_ITEM', id }), [])

  const value = useMemo(() => ({
    loadConversation,
    getConversation,
    getConversationStatus,
    listConversations,
    createConversation,
    sendMessage,
    retryMessage,
    loadProjects,
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
  }), [
    loadConversation, getConversation, getConversationStatus, listConversations, createConversation,
    sendMessage, retryMessage, loadProjects, createProject, getProject, addConversationToProject,
    listProjects, listConversationsForProject, listLibraryItems, listMemoryItems, createMemoryItem,
    updateMemoryItem, deleteMemoryItem,
  ])

  return <OmbreDataContext.Provider value={value}>{children}</OmbreDataContext.Provider>
}

export function useOmbreData() {
  const ctx = useContext(OmbreDataContext)
  if (!ctx) throw new Error('useOmbreData must be used within OmbreDataProvider')
  return ctx
}

export { createId }
