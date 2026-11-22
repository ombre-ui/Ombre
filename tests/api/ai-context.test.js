import test from 'node:test'
import assert from 'node:assert/strict'
import { assertGenerateRequest } from '../../api/_lib/ai/provider.js'
import { ContextError, HISTORY_COLUMNS, MESSAGE_SEPARATOR, buildContext, loadHistoryRows } from '../../api/_lib/ai/context.js'
import { fail, fakeSupabase, ok, opsOf, ID1, USER } from './workspace-helpers.js'

const SYSTEM = 'SYSTEM PROMPT'
const row = (seq, role, content, is_demo = false) => ({ seq, role, content, is_demo })
const build = (rows, over = {}) =>
  buildContext({ systemPrompt: SYSTEM, rows, targetSeq: Math.max(...rows.map((r) => r.seq)), inputCharBudget: 60000, historyMaxMessages: 40, ...over })
const codePoints = (s) => Array.from(s).length
const flat = (messages) => messages.map((m) => `${m.role}:${m.content}`)
// every context must satisfy the S4-A provider contract
const contractOk = (context) =>
  assertGenerateRequest({ system: context.system, messages: context.messages, model: 'm', maxOutputTokens: 10, signal: new AbortController().signal })

test('the simplest context is the system prompt plus the target user message', () => {
  const context = build([row(1, 'user', 'hello')])
  assert.equal(context.system, SYSTEM)
  assert.deepEqual(context.messages, [{ role: 'user', content: 'hello' }])
  assert.deepEqual(context.stats, { historyMessages: 1, mergedMessages: 1, droppedDemo: 0, droppedByCap: 0, droppedBlank: 0, droppedByBudget: 0, promptChars: codePoints(SYSTEM) + 5 })
  contractOk(context)
})

test('messages are built oldest-first whatever order the rows arrive in', () => {
  const rows = [row(3, 'user', 'c'), row(1, 'user', 'a'), row(2, 'assistant', 'b')]
  assert.deepEqual(flat(build(rows).messages), ['user:a', 'assistant:b', 'user:c'])
  assert.deepEqual(flat(build([...rows].reverse()).messages), ['user:a', 'assistant:b', 'user:c'])
})

test('history is only the conversation through the target: later rows are ignored', () => {
  const rows = [row(1, 'user', 'a'), row(2, 'assistant', 'b'), row(3, 'user', 'target'), row(4, 'assistant', 'LATER'), row(5, 'user', 'LATER USER')]
  const context = build(rows, { targetSeq: 3 })
  assert.deepEqual(flat(context.messages), ['user:a', 'assistant:b', 'user:target'])
  assert.ok(!JSON.stringify(context).includes('LATER'))
})

test('demo messages are excluded and counted', () => {
  const rows = [row(1, 'user', 'q1'), row(2, 'assistant', 'DEMO REPLY', true), row(3, 'user', 'q2')]
  const context = build(rows)
  assert.ok(!JSON.stringify(context).includes('DEMO'))
  assert.equal(context.stats.droppedDemo, 1)
  assert.deepEqual(flat(context.messages), [`user:q1${MESSAGE_SEPARATOR}q2`], 'the two user messages around a dropped demo reply merge')
  contractOk(context)
})

test('consecutive same-role messages are merged with exactly one blank line, contents untouched', () => {
  const rows = [
    row(1, 'user', '  first\nwith newline  '),
    row(2, 'user', 'second'),
    row(3, 'assistant', 'answer one'),
    row(4, 'assistant', 'answer two'),
    row(5, 'assistant', 'answer three'),
    row(6, 'user', 'target\n'),
  ]
  const context = build(rows)
  assert.deepEqual(context.messages, [
    { role: 'user', content: '  first\nwith newline  \n\nsecond' },
    { role: 'assistant', content: 'answer one\n\nanswer two\n\nanswer three' },
    { role: 'user', content: 'target\n' },
  ])
  assert.equal(MESSAGE_SEPARATOR, '\n\n')
  assert.equal(context.stats.historyMessages, 6)
  assert.equal(context.stats.mergedMessages, 3)
  contractOk(context)
})

test('blank and newline-only messages are dropped before the provider sees them', () => {
  for (const blank of ['', ' ', '\n\n', ' \t\n ', '\u00a0', '\u2003\n']) {
    const rows = [row(1, 'user', 'a'), row(2, 'assistant', blank), row(3, 'user', 'b')]
    const context = build(rows)
    assert.deepEqual(flat(context.messages), [`user:a${MESSAGE_SEPARATOR}b`], JSON.stringify(blank))
    assert.equal(context.stats.droppedBlank, 1)
    contractOk(context)
  }
  const leading = build([row(1, 'user', '\n\n'), row(2, 'assistant', 'x'), row(3, 'user', 'y')])
  assert.deepEqual(flat(leading.messages), ['assistant:x', 'user:y'])
  assert.equal(leading.stats.droppedBlank, 1)
  contractOk(leading)
})

test('the target must be a usable user message: missing, assistant, demo or blank target is a ContextError', () => {
  const code = (rows, targetSeq) => {
    try {
      buildContext({ systemPrompt: SYSTEM, rows, targetSeq, inputCharBudget: 60000, historyMaxMessages: 40 })
    } catch (error) {
      assert.ok(error instanceof ContextError, String(error))
      return error.code
    }
    assert.fail('expected a ContextError')
  }
  assert.equal(code([row(1, 'user', 'a')], 2), 'target_missing')
  assert.equal(code([row(1, 'user', 'a'), row(2, 'assistant', 'b')], 2), 'target_unusable')
  assert.equal(code([row(1, 'user', 'a'), row(2, 'assistant', 'b', true)], 2), 'target_unusable')
  assert.equal(code([row(1, 'user', 'a'), row(2, 'user', ' \n ')], 2), 'target_unusable')
  assert.equal(code([row(2, 'user', 'a')], 1), 'target_missing', 'a row after the target does not stand in for it')
})

test('invalid rows are a ContextError: bad shape, duplicate seq, unknown role, non-boolean demo flag', () => {
  const bad = [
    [null], ['x'], [row(0, 'user', 'a')], [row(1.5, 'user', 'a')], [row('1', 'user', 'a')],
    [row(1, 'system', 'a')], [row(1, 'user', 42)], [{ seq: 1, role: 'user', content: 'a' }], [row(1, 'user', 'a', 'no')],
    [row(1, 'user', 'a'), row(1, 'assistant', 'b')],
    [row(1, 'user', 'a'), row(9, 'bogus', 'late row is still validated')],
  ]
  for (const rows of bad) {
    assert.throws(
      () => buildContext({ systemPrompt: SYSTEM, rows, targetSeq: 1, inputCharBudget: 60000, historyMaxMessages: 40 }),
      (error) => error instanceof ContextError && error.code === 'invalid_rows',
      JSON.stringify(rows),
    )
  }
})

test('programming errors are TypeErrors', () => {
  const ok1 = { systemPrompt: SYSTEM, rows: [row(1, 'user', 'a')], targetSeq: 1, inputCharBudget: 100, historyMaxMessages: 5 }
  assert.doesNotThrow(() => buildContext(ok1))
  for (const over of [{ systemPrompt: '' }, { systemPrompt: ' ' }, { rows: 'x' }, { targetSeq: 0 }, { targetSeq: 1.5 }, { inputCharBudget: 0 }, { historyMaxMessages: 0 }, { historyMaxMessages: 2.5 }]) {
    assert.throws(() => buildContext({ ...ok1, ...over }), TypeError, JSON.stringify(over))
  }
})

test('at most the newest 40 messages are used and the target is always kept', () => {
  const rows = Array.from({ length: 100 }, (_, i) => row(i + 1, i % 2 === 0 ? 'user' : 'assistant', `m${i + 1}`))
  rows.push(row(101, 'user', 'target')) // 100 is an assistant message, so 101 (user) is the target
  const context = build(rows)
  assert.equal(context.stats.historyMessages, 40)
  assert.equal(context.stats.droppedByCap, 61)
  assert.equal(context.messages.length, 40)
  assert.deepEqual(context.messages[0], { role: 'assistant', content: 'm62' }, 'a window may start with an assistant message')
  assert.deepEqual(context.messages.at(-1), { role: 'user', content: 'target' })
  contractOk(context)
  const tiny = build(rows, { historyMaxMessages: 1 })
  assert.deepEqual(tiny.messages, [{ role: 'user', content: 'target' }])
  assert.equal(tiny.stats.droppedByCap, 100)
})

test('demo rows do not use up the history cap, and the cap counts blank messages it later drops', () => {
  const rows = []
  for (let i = 1; i <= 60; i += 1) rows.push(row(i, i % 2 ? 'user' : 'assistant', `m${i}`, i % 2 === 0)) // even seqs are demo
  rows.push(row(61, 'user', 'target'))
  const context = build(rows, { historyMaxMessages: 10 })
  assert.equal(context.stats.historyMessages, 10, '10 non-demo messages, all users, merged into one')
  assert.equal(context.messages.length, 1)
  const withBlank = build([row(1, 'user', 'a'), row(2, 'assistant', ' '), row(3, 'user', 'b'), row(4, 'assistant', 'c'), row(5, 'user', 'target')], { historyMaxMessages: 4 })
  assert.equal(withBlank.stats.droppedByCap, 1)
  assert.equal(withBlank.stats.droppedBlank, 1)
})

test('the input budget counts code points of the final payload (system + merged messages, separators included)', () => {
  const rows = [row(1, 'user', 'a'.repeat(10)), row(2, 'assistant', 'b'.repeat(10)), row(3, 'user', 'c'.repeat(10))]
  const system = 'S'.repeat(5)
  const size = 5 + 30
  const fits = buildContext({ systemPrompt: system, rows, targetSeq: 3, inputCharBudget: size, historyMaxMessages: 40 })
  assert.equal(fits.messages.length, 3)
  assert.equal(fits.stats.promptChars, size)
  assert.equal(fits.stats.droppedByBudget, 0)
  const over = buildContext({ systemPrompt: system, rows, targetSeq: 3, inputCharBudget: size - 1, historyMaxMessages: 40 })
  assert.deepEqual(flat(over.messages), [`assistant:${'b'.repeat(10)}`, `user:${'c'.repeat(10)}`], 'the oldest whole message is dropped')
  assert.equal(over.stats.droppedByBudget, 1)
  assert.equal(over.stats.promptChars, 5 + 20)
  // separators count: two merged user messages cost 2 extra characters
  const merged = buildContext({ systemPrompt: system, rows: [row(1, 'user', 'x'.repeat(10)), row(2, 'user', 'y'.repeat(10))], targetSeq: 2, inputCharBudget: 5 + 20 + 2, historyMaxMessages: 40 })
  assert.equal(merged.messages.length, 1)
  assert.equal(merged.stats.promptChars, 27)
  const mergedOver = buildContext({ systemPrompt: system, rows: [row(1, 'user', 'x'.repeat(10)), row(2, 'user', 'y'.repeat(10))], targetSeq: 2, inputCharBudget: 5 + 20 + 1, historyMaxMessages: 40 })
  assert.deepEqual(mergedOver.messages, [{ role: 'user', content: 'y'.repeat(10) }])
})

test('the budget is measured in code points, not UTF-16 units or bytes', () => {
  const emoji = '\u{1F600}'.repeat(10) // 10 code points, 20 UTF-16 units, 40 bytes
  const rows = [row(1, 'assistant', emoji), row(2, 'user', emoji)]
  const exact = buildContext({ systemPrompt: 'S', rows, targetSeq: 2, inputCharBudget: 21, historyMaxMessages: 40 })
  assert.equal(exact.messages.length, 2)
  assert.equal(exact.stats.promptChars, 21)
  const tight = buildContext({ systemPrompt: 'S', rows, targetSeq: 2, inputCharBudget: 20, historyMaxMessages: 40 })
  assert.equal(tight.messages.length, 1)
})

test('trimming drops whole messages only: no message is ever truncated, and the target survives', () => {
  const rows = [row(1, 'user', 'a'.repeat(900)), row(2, 'assistant', 'b'.repeat(900)), row(3, 'user', 'c'.repeat(900)), row(4, 'assistant', 'd'.repeat(900)), row(5, 'user', 'e'.repeat(900))]
  for (const budget of [4600, 3700, 2800, 1900, 1000]) {
    const context = buildContext({ systemPrompt: 'S', rows, targetSeq: 5, inputCharBudget: budget, historyMaxMessages: 40 })
    assert.ok(context.stats.promptChars <= budget)
    for (const message of context.messages) assert.ok(/^(?:[abcde]{900})$/.test(message.content), 'every message is intact')
    assert.equal(context.messages.at(-1).content, 'e'.repeat(900))
    assert.equal(context.messages.at(-1).role, 'user')
    contractOk(context)
  }
})

test('a target that cannot fit the budget on its own is a ContextError, never a truncation', () => {
  assert.throws(
    () => buildContext({ systemPrompt: 'S'.repeat(100), rows: [row(1, 'user', 'x'.repeat(100))], targetSeq: 1, inputCharBudget: 150, historyMaxMessages: 40 }),
    (error) => error instanceof ContextError && error.code === 'budget_exceeded',
  )
})

test('the system prompt is passed through unchanged and is not counted twice', () => {
  const system = '  Exact system prompt\nwith whitespace  '
  const context = buildContext({ systemPrompt: system, rows: [row(1, 'user', 'q')], targetSeq: 1, inputCharBudget: 1000, historyMaxMessages: 5 })
  assert.equal(context.system, system)
  assert.equal(context.stats.promptChars, codePoints(system) + 1)
})

test('input rows are not mutated', () => {
  const rows = Object.freeze([Object.freeze(row(2, 'user', 'b')), Object.freeze(row(1, 'user', 'a'))])
  assert.doesNotThrow(() => buildContext({ systemPrompt: SYSTEM, rows, targetSeq: 2, inputCharBudget: 100, historyMaxMessages: 5 }))
  assert.deepEqual(rows.map((r) => r.seq), [2, 1])
})

test('property check: any mix of roles, blanks, demo rows and budgets yields a valid provider request', () => {
  let state = 12345
  const next = (n) => {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    return state % n
  }
  for (let run = 0; run < 300; run += 1) {
    const count = 1 + next(30)
    const rows = []
    for (let seq = 1; seq < count; seq += 1) {
      const kind = next(6)
      rows.push(row(seq, next(2) ? 'user' : 'assistant', kind === 0 ? '\n\n' : kind === 1 ? '' : `msg ${seq} ${'x'.repeat(next(200))}`, next(5) === 0))
    }
    rows.push(row(count, 'user', `target ${run}`))
    const budget = 200 + next(3000)
    const cap = 1 + next(45)
    const context = buildContext({ systemPrompt: SYSTEM, rows, targetSeq: count, inputCharBudget: budget, historyMaxMessages: cap })
    contractOk(context)
    assert.ok(context.stats.promptChars <= budget)
    assert.equal(context.messages.at(-1).role, 'user')
    assert.ok(context.messages.at(-1).content.endsWith(`target ${run}`))
    assert.ok(context.stats.historyMessages <= cap)
    assert.ok(!context.messages.some((m) => m.content.trim() === ''))
    for (let i = 1; i < context.messages.length; i += 1) assert.notEqual(context.messages[i].role, context.messages[i - 1].role)
  }
})

// ---------------------------------------------------------------------------------------- the database read

const makeCtx = () => {
  const logs = []
  return { logs, log: (event, fields) => logs.push(['log', event, fields]), logAuthError: (event, fields) => logs.push(['authError', event, fields]) }
}

test('loadHistoryRows is scoped by conversation AND user, excludes demo rows in the query, and caps by the limit', async () => {
  const dbRows = [{ seq: 3, role: 'user', content: 'c', is_demo: false }, { seq: 2, role: 'assistant', content: 'b', is_demo: false }]
  const { supabase, calls } = fakeSupabase({ handler: async () => ok(dbRows) })
  const rows = await loadHistoryRows(makeCtx(), { supabase, conversationId: ID1, userId: USER, targetSeq: 3, limit: 40 })
  assert.deepEqual(rows, dbRows)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].table, 'messages')
  assert.deepEqual(calls[0].ops, [
    ['select', HISTORY_COLUMNS],
    ['eq', 'conversation_id', ID1],
    ['eq', 'user_id', USER],
    ['eq', 'is_demo', false],
    ['lte', 'seq', 3],
    ['order', 'seq', { ascending: false }],
    ['limit', 40],
  ])
  assert.equal(HISTORY_COLUMNS, 'seq, role, content, is_demo')
  assert.deepEqual(opsOf(calls[0], 'eq').map((o) => o[1]).sort(), ['conversation_id', 'is_demo', 'user_id'])
  assert.ok(!HISTORY_COLUMNS.includes('user_id'), 'the user id is a filter, never selected back')
})

test('loadHistoryRows reads only the messages table: nothing from conversations, projects, memory, library or settings', async () => {
  const { supabase, calls } = fakeSupabase({ handler: async () => ok([]) })
  await loadHistoryRows(makeCtx(), { supabase, conversationId: ID1, userId: USER, targetSeq: 1, limit: 40 })
  assert.deepEqual(calls.map((c) => c.table), ['messages'])
})

test('loadHistoryRows maps database failures through the existing workspace error mapping, without leaking details', async () => {
  const ctx = makeCtx()
  const { supabase } = fakeSupabase({ handler: async () => fail('XX000', 503) })
  await assert.rejects(loadHistoryRows(ctx, { supabase, conversationId: ID1, userId: USER, targetSeq: 1, limit: 40 }), (error) => error.status === 503 && error.code === 'service_unavailable')
  assert.ok(!JSON.stringify(ctx.logs).includes('SECRET-DB-DETAIL'))
  const other = fakeSupabase({ handler: async () => fail('42P01', 400) })
  await assert.rejects(loadHistoryRows(makeCtx(), { supabase: other.supabase, conversationId: ID1, userId: USER, targetSeq: 1, limit: 40 }), (error) => error.status === 500 && error.code === 'internal_error')
  const bad = fakeSupabase({ handler: async () => ({ data: null, error: null, status: 200 }) })
  await assert.rejects(loadHistoryRows(makeCtx(), { supabase: bad.supabase, conversationId: ID1, userId: USER, targetSeq: 1, limit: 40 }), (error) => error.status === 500)
})

test('loadHistoryRows rejects missing scoping arguments before any query (programming errors)', async () => {
  const { supabase, calls } = fakeSupabase({ handler: async () => ok([]) })
  const good = { supabase, conversationId: ID1, userId: USER, targetSeq: 1, limit: 40 }
  for (const over of [{ conversationId: '' }, { conversationId: undefined }, { userId: '' }, { userId: undefined }, { targetSeq: 0 }, { limit: 0 }, { limit: 1.5 }]) {
    await assert.rejects(loadHistoryRows(makeCtx(), { ...good, ...over }), TypeError, JSON.stringify(over))
  }
  assert.equal(calls.length, 0)
})

test('rows a faulty query returns (a demo row, a later row) are still handled by the builder', async () => {
  const dbRows = [
    { seq: 4, role: 'assistant', content: 'LATER', is_demo: false },
    { seq: 3, role: 'user', content: 'target', is_demo: false },
    { seq: 2, role: 'assistant', content: 'DEMO', is_demo: true },
    { seq: 1, role: 'user', content: 'first', is_demo: false },
  ]
  const { supabase } = fakeSupabase({ handler: async () => ok(dbRows) })
  const rows = await loadHistoryRows(makeCtx(), { supabase, conversationId: ID1, userId: USER, targetSeq: 3, limit: 40 })
  const context = buildContext({ systemPrompt: SYSTEM, rows, targetSeq: 3, inputCharBudget: 60000, historyMaxMessages: 40 })
  assert.deepEqual(context.messages, [{ role: 'user', content: `first${MESSAGE_SEPARATOR}target` }])
})
