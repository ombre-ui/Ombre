// A4 database integration tests. They run against the REAL local Postgres that `supabase start` / CI creates, after
// `supabase db reset` has applied every migration, and exercise the actual tables, grants, RLS policies, triggers and
// functions. Nothing here is mocked.
//
// How it talks to the database: `docker exec -i supabase_db_ombre psql` (no extra dependencies). Each scenario runs in a
// transaction that does what PostgREST does for a request: `set local role authenticated` (or `anon`) and sets
// `request.jwt.claims` so auth.uid() returns the test user. Statements run as the `postgres` owner (no role switch) are
// used only for seeding and for reading the truth past RLS.
//
// Run:  supabase start && supabase db reset && AUTH_INTEGRATION=1 node --test tests/integration/workspace-db.test.js
//       (or: npm run test:integration)
// Env:  SUPABASE_DB_CONTAINER (default supabase_db_ombre)
//
// Every test creates its own users (random ids) and the suite deletes them at the end, which also exercises the
// auth.users ON DELETE CASCADE path.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const CONTAINER = process.env.SUPABASE_DB_CONTAINER || 'supabase_db_ombre'
// Same convention as the other integration suites: skipped unless AUTH_INTEGRATION=1 (`npm run test:integration` sets it).
const suite = process.env.AUTH_INTEGRATION === '1' ? test : test.skip

function psql(sql) {
  return new Promise((resolve) => {
    const child = execFile(
      'docker',
      ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-qAt', '-f', '-'],
      { maxBuffer: 128 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ ok: !error, stdout, stderr }),
    )
    child.stdin.end(sql)
  })
}

const claims = (uid) => JSON.stringify({ sub: uid, role: 'authenticated', aud: 'authenticated' })
const asUser = (uid, body) =>
  `begin;\nset local role authenticated;\nselect set_config('request.jwt.claims', '${claims(uid)}', true) \\gset\n${body}\ncommit;\n`
const asAnon = (body) => `begin;\nset local role anon;\n${body}\ncommit;\n`
const asOwner = (body) => `begin;\n${body}\ncommit;\n`

// Values are printed as lines starting with "@@" so role/guc chatter can never be mistaken for results.
const values = (stdout) => stdout.split('\n').filter((l) => l.startsWith('@@')).map((l) => l.slice(2))
async function run(sql) {
  const r = await psql(sql)
  assert.ok(r.ok, `SQL failed:\n${r.stderr}\n--- script ---\n${sql.slice(0, 1500)}`)
  return values(r.stdout)
}
async function fails(sql, pattern) {
  const r = await psql(sql)
  assert.equal(r.ok, false, `expected the statement to be refused, but it succeeded.\n--- script ---\n${sql.slice(0, 1500)}`)
  assert.match(r.stderr, pattern, `unexpected error:\n${r.stderr}`)
}

const users = []
async function newUser() {
  const id = randomUUID()
  // The real signup trigger (on_auth_user_created) creates profiles and user_settings (save_history defaults to true).
  await run(asOwner(`insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data) values ('${id}', '${id}@example.test', '{}'::jsonb, '{}'::jsonb);`))
  users.push(id)
  return id
}
after(async () => {
  if (process.env.AUTH_INTEGRATION === '1' && users.length) await psql(asOwner(`delete from auth.users where id in (${users.map((u) => `'${u}'`).join(',')});`))
})

const q = (s) => `'${String(s).replace(/'/g, "''")}'`
const nul = (v) => (v == null ? 'null' : q(v))
const scalar = async (sql) => (await run(asOwner(`select '@@'||(${sql});`)))[0]
const count = (table, where) => scalar(`select count(*) from public.${table} where ${where}`)

async function mkProject(uid, name = 'project') {
  return (await run(asUser(uid, `with r as (insert into public.projects (name) values (${q(name)}) returning id) select '@@'||id from r;`)))[0]
}
async function mkConversation(uid, { project = null, content = 'hello', title = 'a title', mentor = null, key = randomUUID() } = {}) {
  const out = await run(asUser(uid, `select '@@'||(public.create_conversation(${q(title)}, ${nul(mentor)}, ${nul(project)}, ${q(content)}, ${q(key)}))->'conversation'->>'id';`))
  return out[0]
}
async function mkMessage(uid, conv, { role = 'user', demo = false, content = 'm', key = null } = {}) {
  const out = await run(
    asUser(uid, `with r as (insert into public.messages (conversation_id, role, content, is_demo, client_request_id) values (${q(conv)}, ${q(role)}, ${q(content)}, ${demo}, ${nul(key)}) returning id) select '@@'||id from r;`),
  )
  return out[0]
}
const tables = ['projects', 'conversations', 'messages', 'saved_items', 'library_items']

// ---------------------------------------------------------------------------------------------------- structure

suite('all five A4 tables exist with RLS enabled, and the three review-finding indexes are present', async () => {
  const rls = await run(asOwner(`select '@@'||relname||'='||relrowsecurity from pg_class where relnamespace='public'::regnamespace and relname in (${tables.map(q).join(',')}) order by relname;`))
  assert.deepEqual(rls, ['conversations=true', 'library_items=true', 'messages=true', 'projects=true', 'saved_items=true'])
  const idx = await run(asOwner(`select '@@'||indexname from pg_indexes where schemaname='public' and indexname in ('saved_items_message_idx','library_items_project_idx','messages_user_request_key') order by 1;`))
  assert.deepEqual(idx, ['library_items_project_idx', 'messages_user_request_key', 'saved_items_message_idx'])
  // the idempotency index is unique and NOT partial (so its leading user_id serves the auth.users cascade)
  const def = await scalar(`select indexdef from pg_indexes where indexname='messages_user_request_key'`)
  assert.match(def, /CREATE UNIQUE INDEX .* \(user_id, client_request_id\)$/)
})

suite('grants and function privileges are exactly what the design says', async () => {
  const yes = async (expr) => assert.equal(await scalar(expr), 'true', expr)
  const no = async (expr) => assert.equal(await scalar(expr), 'false', expr)
  // messages: select only, plus column-level insert; nothing that mutates
  await yes(`has_table_privilege('authenticated','public.messages','select')`)
  await no(`has_any_column_privilege('authenticated','public.messages','update')`)
  await no(`has_table_privilege('authenticated','public.messages','delete')`)
  for (const c of ['id', 'user_id', 'seq', 'created_at']) await no(`has_column_privilege('authenticated','public.messages','${c}','insert')`)
  for (const c of ['conversation_id', 'role', 'content', 'is_demo', 'client_request_id']) await yes(`has_column_privilege('authenticated','public.messages','${c}','insert')`)
  // conversations: only title/project_id are updatable; counters are database-controlled
  await yes(`has_column_privilege('authenticated','public.conversations','title','update')`)
  await yes(`has_column_privilege('authenticated','public.conversations','project_id','update')`)
  for (const c of ['user_id', 'mentor_id', 'message_count', 'last_message_at', 'updated_at', 'created_at', 'id']) {
    await no(`has_column_privilege('authenticated','public.conversations','${c}','update')`)
  }
  // library: read only
  await yes(`has_table_privilege('authenticated','public.library_items','select')`)
  await no(`has_any_column_privilege('authenticated','public.library_items','insert')`)
  await no(`has_any_column_privilege('authenticated','public.library_items','update')`)
  await no(`has_table_privilege('authenticated','public.library_items','delete')`)
  // anon has nothing on any A4 table
  for (const t of tables) await no(`has_any_column_privilege('anon','public.${t}','select') or has_any_column_privilege('anon','public.${t}','insert') or has_table_privilege('anon','public.${t}','delete')`)
  // create_conversation: authenticated yes, anon no; SECURITY INVOKER; fixed five-argument signature (no role parameter)
  await yes(`has_function_privilege('authenticated','public.create_conversation(text,text,uuid,text,uuid)','execute')`)
  await no(`has_function_privilege('anon','public.create_conversation(text,text,uuid,text,uuid)','execute')`)
  assert.equal(await scalar(`select prosecdef from pg_proc where proname='create_conversation'`), 'false')
  assert.equal(await scalar(`select count(*) from pg_proc where proname='create_conversation'`), '1')
  // private helpers: no schema usage and no execute for API roles
  for (const role of ['authenticated', 'anon']) {
    await no(`has_schema_privilege('${role}','private','usage')`)
    for (const fn of ['enforce_user_row_cap', 'messages_before_insert', 'messages_block_update']) await no(`has_function_privilege('${role}','private.${fn}()','execute')`)
  }
  // the SECURITY DEFINER trigger function pins its search_path
  assert.equal(await scalar(`select array_to_string(proconfig, ',') from pg_proc where proname='messages_before_insert'`), 'search_path=""')
})

// ---------------------------------------------------------------------------------------- isolation and ownership

suite('two-user isolation: B cannot read, update or delete A\'s rows', async () => {
  const a = await newUser()
  const b = await newUser()
  const project = await mkProject(a)
  const conv = await mkConversation(a, { project })
  const message = (await run(asOwner(`select '@@'||id from public.messages where conversation_id=${q(conv)};`)))[0]
  await run(asUser(a, `insert into public.saved_items (conversation_id, message_id) values (${q(conv)}, ${q(message)});`))
  await run(asOwner(`insert into public.library_items (user_id, project_id, kind, title) values (${q(a)}, ${q(project)}, 'note', 'a note');`))

  for (const t of tables) assert.deepEqual(await run(asUser(b, `select '@@'||count(*) from public.${t};`)), ['0'], `B must see no ${t}`)
  for (const t of tables) assert.deepEqual(await run(asUser(a, `select '@@'||count(*) from public.${t};`)), ['1'], `A sees their own ${t}`)

  const zero = async (sql) => assert.deepEqual(await run(asUser(b, `with r as (${sql} returning 1) select '@@'||count(*) from r;`)), ['0'])
  await zero(`update public.projects set name='hacked' where id=${q(project)}`)
  await zero(`update public.conversations set title='hacked' where id=${q(conv)}`)
  await zero(`delete from public.projects where id=${q(project)}`)
  await zero(`delete from public.conversations where id=${q(conv)}`)
  await zero(`delete from public.saved_items where conversation_id=${q(conv)}`)

  assert.equal(await count('projects', `id=${q(project)} and name='project'`), '1')
  assert.equal(await count('conversations', `id=${q(conv)} and title='a title'`), '1')
  assert.equal(await count('messages', `conversation_id=${q(conv)}`), '1')
  assert.equal(await count('saved_items', `conversation_id=${q(conv)}`), '1')
})

suite('spoofed user_id is refused on every table, on insert and on update', async () => {
  const a = await newUser()
  const b = await newUser()
  const project = await mkProject(a)
  const conv = await mkConversation(a)
  const denied = /permission denied/
  await fails(asUser(a, `insert into public.projects (user_id, name) values (${q(b)}, 'x');`), denied)
  await fails(asUser(a, `update public.projects set user_id=${q(b)} where id=${q(project)};`), denied)
  await fails(asUser(a, `insert into public.conversations (user_id, title) values (${q(b)}, 'x');`), denied)
  await fails(asUser(a, `update public.conversations set user_id=${q(b)} where id=${q(conv)};`), denied)
  await fails(asUser(a, `insert into public.messages (user_id, conversation_id, role, content) values (${q(b)}, ${q(conv)}, 'user', 'x');`), denied)
  await fails(asUser(a, `insert into public.saved_items (user_id, conversation_id) values (${q(b)}, ${q(conv)});`), denied)
  // an insert that omits user_id gets auth.uid(), never anything else
  assert.equal(await count('projects', `id=${q(project)} and user_id=${q(a)}`), '1')
})

suite('cross-tenant composite foreign keys: B cannot attach to, post into or bookmark A\'s data', async () => {
  const a = await newUser()
  const b = await newUser()
  const projectA = await mkProject(a)
  const convA = await mkConversation(a)
  const messageA = (await run(asOwner(`select '@@'||id from public.messages where conversation_id=${q(convA)};`)))[0]
  const convB = await mkConversation(b)
  const fk = /violates foreign key constraint/

  await fails(asUser(b, `insert into public.conversations (title, project_id) values ('x', ${q(projectA)});`), fk)
  await fails(asUser(b, `update public.conversations set project_id=${q(projectA)} where id=${q(convB)};`), fk)
  await fails(asUser(b, `insert into public.messages (conversation_id, role, content) values (${q(convA)}, 'user', 'intrusion');`), /conversation not found|foreign key/)
  await fails(asUser(b, `insert into public.saved_items (conversation_id) values (${q(convA)});`), fk)
  await fails(asUser(b, `insert into public.saved_items (conversation_id, message_id) values (${q(convB)}, ${q(messageA)});`), fk)
  await fails(asOwner(`insert into public.library_items (user_id, project_id, kind, title) values (${q(b)}, ${q(projectA)}, 'note', 'x');`), fk)
  // the atomic function refuses a foreign project and leaves nothing behind
  const before = await count('conversations', `user_id=${q(b)}`)
  await fails(asUser(b, `select public.create_conversation('t', null, ${q(projectA)}, 'hi', ${q(randomUUID())});`), fk)
  assert.equal(await count('conversations', `user_id=${q(b)}`), before)
  assert.equal(await count('messages', `conversation_id=${q(convA)}`), '1', 'A\'s conversation is untouched')
})

suite('database-controlled columns cannot be written by clients', async () => {
  const a = await newUser()
  const project = await mkProject(a)
  const conv = await mkConversation(a)
  const denied = /permission denied/
  await fails(asUser(a, `update public.conversations set message_count=0 where id=${q(conv)};`), denied)
  await fails(asUser(a, `update public.conversations set last_message_at=now() where id=${q(conv)};`), denied)
  await fails(asUser(a, `update public.conversations set updated_at=now() where id=${q(conv)};`), denied)
  await fails(asUser(a, `update public.conversations set mentor_id='bug-hunter' where id=${q(conv)};`), denied)
  await fails(asUser(a, `insert into public.conversations (title, message_count) values ('t', 3);`), denied)
  await fails(asUser(a, `update public.projects set created_at=now() where id=${q(project)};`), denied)
  await fails(asUser(a, `update public.projects set id=gen_random_uuid() where id=${q(project)};`), denied)
  await fails(asUser(a, `insert into public.messages (conversation_id, role, content, seq) values (${q(conv)}, 'user', 'x', 7);`), denied)
  await fails(asUser(a, `insert into public.messages (id, conversation_id, role, content) values (gen_random_uuid(), ${q(conv)}, 'user', 'x');`), denied)
  await fails(asUser(a, `insert into public.messages (created_at, conversation_id, role, content) values (now(), ${q(conv)}, 'user', 'x');`), denied)
  // the allowed columns do work
  await run(asUser(a, `update public.conversations set title='renamed' where id=${q(conv)};`))
  assert.equal(await count('conversations', `id=${q(conv)} and title='renamed' and message_count=1`), '1')
})

// ---------------------------------------------------------------------------------------------- messages

suite('forged assistant/demo combinations are refused; the two permitted combinations work', async () => {
  const a = await newUser()
  const conv = await mkConversation(a)
  const refused = /row-level security|check constraint/
  await fails(asUser(a, `insert into public.messages (conversation_id, role, content, is_demo) values (${q(conv)}, 'user', 'x', true);`), refused)
  await fails(asUser(a, `insert into public.messages (conversation_id, role, content, is_demo) values (${q(conv)}, 'assistant', 'x', false);`), /row-level security/)
  await fails(asUser(a, `insert into public.messages (conversation_id, role, content, is_demo) values (${q(conv)}, 'system', 'x', false);`), refused)
  assert.equal(await count('messages', `conversation_id=${q(conv)}`), '1', 'no refused insert left a row')
  await mkMessage(a, conv, { role: 'assistant', demo: true, content: 'demo reply' })
  await mkMessage(a, conv, { role: 'user', demo: false, content: 'follow up' })
  assert.deepEqual(await run(asOwner(`select '@@'||seq||':'||role||':'||is_demo from public.messages where conversation_id=${q(conv)} order by seq;`)), ['1:user:false', '2:assistant:true', '3:user:false'])
})

suite('messages are append-only: no update or delete for clients, and an update guard even for the owner', async () => {
  const a = await newUser()
  const conv = await mkConversation(a)
  const denied = /permission denied/
  await fails(asUser(a, `update public.messages set content='edited' where conversation_id=${q(conv)};`), denied)
  await fails(asUser(a, `delete from public.messages where conversation_id=${q(conv)};`), denied)
  await fails(asOwner(`update public.messages set content='edited' where conversation_id=${q(conv)};`), /append-only/)
  assert.equal(await count('messages', `conversation_id=${q(conv)} and content='hello'`), '1')
})

suite('anonymous access is refused on every table and on create_conversation', async () => {
  const denied = /permission denied/
  for (const t of tables) {
    await fails(asAnon(`select count(*) from public.${t};`), denied)
    await fails(asAnon(`delete from public.${t};`), denied)
  }
  await fails(asAnon(`insert into public.projects (name) values ('x');`), denied)
  await fails(asAnon(`select public.create_conversation('t', null, null, 'hi', ${q(randomUUID())});`), denied)
})

suite('private trigger functions cannot be called by API roles, yet triggers still fire for them', async () => {
  const a = await newUser()
  await fails(asUser(a, `select private.messages_before_insert();`), /permission denied/)
  await fails(asUser(a, `select private.enforce_user_row_cap();`), /permission denied/)
  await fails(asUser(a, `select private.messages_block_update();`), /permission denied/)
  await fails(asAnon(`select private.messages_before_insert();`), /permission denied/)
  // Triggers fire without EXECUTE or schema USAGE: the sequence number and counters are assigned for an API role.
  const conv = await mkConversation(a)
  await mkMessage(a, conv)
  assert.deepEqual(await run(asOwner(`select '@@'||seq from public.messages where conversation_id=${q(conv)} order by seq;`)), ['1', '2'])
  assert.equal(await scalar(`select message_count from public.conversations where id=${q(conv)}`), '2')
})

// ------------------------------------------------------------------------------------------------- caps

suite('per-user cap: 100 projects, exact, and a bulk insert past the cap is atomic', async () => {
  const a = await newUser()
  await run(asUser(a, `insert into public.projects (name) select 'p'||g from generate_series(1,100) g;`))
  await fails(asUser(a, `insert into public.projects (name) values ('one too many');`), /limit_reached/)
  assert.equal(await count('projects', `user_id=${q(a)}`), '100')
  const b = await newUser()
  await fails(asUser(b, `insert into public.projects (name) select 'p'||g from generate_series(1,101) g;`), /limit_reached/)
  assert.equal(await count('projects', `user_id=${q(b)}`), '0', 'the failed statement inserted nothing')
})

suite('per-user cap: 2000 conversations', async () => {
  const a = await newUser()
  await run(asUser(a, `insert into public.conversations (title) select 'c'||g from generate_series(1,2000) g;`))
  await fails(asUser(a, `insert into public.conversations (title) values ('too many');`), /limit_reached/)
  await fails(asUser(a, `select public.create_conversation('t', null, null, 'hi', ${q(randomUUID())});`), /limit_reached/)
  assert.equal(await count('conversations', `user_id=${q(a)}`), '2000')
})

suite('500-message cap: exact, counters stay consistent, and the 501st is refused', async () => {
  const a = await newUser()
  const conv = await mkConversation(a)
  await run(asUser(a, `insert into public.messages (conversation_id, role, content) select ${q(conv)}, 'user', 'm'||g from generate_series(1,499) g;`))
  assert.equal(await scalar(`select message_count from public.conversations where id=${q(conv)}`), '500')
  await fails(asUser(a, `insert into public.messages (conversation_id, role, content) values (${q(conv)}, 'user', 'one too many');`), /limit_reached/)
  assert.equal(await scalar(`select count(*)||':'||max(seq)||':'||min(seq) from public.messages where conversation_id=${q(conv)}`), '500:500:1')
  assert.equal(await scalar(`select message_count from public.conversations where id=${q(conv)}`), '500', 'the refused insert did not move the counter')
})

suite('per-user cap: 2000 saved items', async () => {
  const a = await newUser()
  const convs = []
  for (let i = 0; i < 4; i += 1) {
    const c = await mkConversation(a)
    await run(asUser(a, `insert into public.messages (conversation_id, role, content) select ${q(c)}, 'user', 'm'||g from generate_series(1,499) g;`))
    convs.push(c)
  }
  await run(asUser(a, `insert into public.saved_items (conversation_id, message_id) select conversation_id, id from public.messages;`))
  assert.equal(await count('saved_items', `user_id=${q(a)}`), '2000')
  await fails(asUser(a, `insert into public.saved_items (conversation_id) values (${q(convs[0])});`), /limit_reached/)
})

suite('concurrent message inserts get contiguous, unique sequence numbers', async () => {
  const a = await newUser()
  const conv = await mkConversation(a)
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) => psql(asUser(a, `insert into public.messages (conversation_id, role, content, client_request_id) values (${q(conv)}, 'user', 'c${i}', ${q(randomUUID())});`))),
  )
  assert.ok(results.every((r) => r.ok), results.find((r) => !r.ok)?.stderr)
  assert.equal(await scalar(`select string_agg(seq::text, ',' order by seq) from public.messages where conversation_id=${q(conv)}`), Array.from({ length: 21 }, (_, i) => i + 1).join(','))
  assert.equal(await scalar(`select message_count from public.conversations where id=${q(conv)}`), '21')
})

suite('the project cap is exact under concurrency', async () => {
  const a = await newUser()
  await run(asUser(a, `insert into public.projects (name) select 'p'||g from generate_series(1,95) g;`))
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => psql(asUser(a, `insert into public.projects (name) values ('race${i}');`))))
  assert.equal(results.filter((r) => r.ok).length, 5)
  assert.ok(results.filter((r) => !r.ok).every((r) => /limit_reached/.test(r.stderr)))
  assert.equal(await count('projects', `user_id=${q(a)}`), '100')
})

// ----------------------------------------------------------------------------------------------- save_history

suite('save_history = false: nothing is written, atomically, and counters do not move', async () => {
  const a = await newUser()
  const conv = await mkConversation(a)
  await run(asOwner(`update public.user_settings set save_history=false where user_id=${q(a)};`))
  const refused = /row-level security/
  await fails(asUser(a, `select public.create_conversation('t', null, null, 'hi', ${q(randomUUID())});`), refused)
  await fails(asUser(a, `insert into public.conversations (title) values ('x');`), refused)
  await fails(asUser(a, `insert into public.messages (conversation_id, role, content) values (${q(conv)}, 'user', 'x');`), refused)
  await fails(asUser(a, `insert into public.messages (conversation_id, role, content, is_demo) values (${q(conv)}, 'assistant', 'x', true);`), refused)
  assert.equal(await count('conversations', `user_id=${q(a)}`), '1')
  assert.equal(await count('messages', `user_id=${q(a)}`), '1')
  assert.equal(await scalar(`select message_count from public.conversations where id=${q(conv)}`), '1', 'the refused insert rolled the counter back')
  // things that are not history still work while it is off
  await run(asUser(a, `update public.conversations set title='still renamable' where id=${q(conv)};`))
  await mkProject(a)
  await run(asUser(a, `delete from public.conversations where id=${q(conv)};`))
})

suite('save_history toggled between requests is honoured, with no gaps in the sequence', async () => {
  const a = await newUser()
  const conv = await mkConversation(a)
  await mkMessage(a, conv, { content: 'second' })
  await run(asOwner(`update public.user_settings set save_history=false where user_id=${q(a)};`))
  await fails(asUser(a, `insert into public.messages (conversation_id, role, content) values (${q(conv)}, 'user', 'lost');`), /row-level security/)
  await run(asOwner(`update public.user_settings set save_history=true where user_id=${q(a)};`))
  await mkMessage(a, conv, { content: 'third' })
  assert.equal(await scalar(`select string_agg(seq::text||':'||content, ',' order by seq) from public.messages where conversation_id=${q(conv)}`), '1:hello,2:second,3:third')
  assert.equal(await scalar(`select message_count from public.conversations where id=${q(conv)}`), '3')
})

suite('a missing user_settings row fails closed', async () => {
  const a = await newUser()
  await run(asOwner(`delete from public.user_settings where user_id=${q(a)};`))
  await fails(asUser(a, `insert into public.conversations (title) values ('x');`), /row-level security/)
})

// ------------------------------------------------------------------------ create_conversation, idempotency

suite('create_conversation is atomic: success creates both rows; any failure leaves nothing', async () => {
  const a = await newUser()
  const out = await run(
    asUser(a, `select '@@'||(r->'conversation'->>'message_count')||'|'||(r->'message'->>'seq')||'|'||(r->'message'->>'role')||'|'||(r->'message'->>'is_demo')||'|'||(r->'conversation'->>'title') from (select public.create_conversation('Hello', 'bug-hunter', null, 'first message', ${q(randomUUID())}) r) s;`),
  )
  assert.deepEqual(out, ['1|1|user|false|Hello'])
  assert.equal(await count('conversations', `user_id=${q(a)}`), '1')
  assert.equal(await count('messages', `user_id=${q(a)}`), '1')

  const before = [await count('conversations', `user_id=${q(a)}`), await count('messages', `user_id=${q(a)}`)]
  const k = () => q(randomUUID())
  await fails(asUser(a, `select public.create_conversation('t', null, null, repeat('x', 8001), ${k()});`), /check constraint|messages_content_check/)
  await fails(asUser(a, `select public.create_conversation('t', null, null, '   ', ${k()});`), /check constraint|messages_content_check/)
  await fails(asUser(a, `select public.create_conversation('', null, null, 'hi', ${k()});`), /check constraint|conversations_title_check/)
  await fails(asUser(a, `select public.create_conversation(repeat('t', 121), null, null, 'hi', ${k()});`), /check constraint|conversations_title_check/)
  await fails(asUser(a, `select public.create_conversation('t', 'Not_A_Slug', null, 'hi', ${k()});`), /check constraint|conversations_mentor_id_check/)
  assert.deepEqual([await count('conversations', `user_id=${q(a)}`), await count('messages', `user_id=${q(a)}`)], before, 'no failed call left an orphan conversation or message')
})

suite('idempotency: a retried or conflicting create is refused by the database and leaves no rows', async () => {
  const a = await newUser()
  const b = await newUser()
  const key = randomUUID()
  await mkConversation(a, { key, content: 'original' })
  const before = [await count('conversations', `user_id=${q(a)}`), await count('messages', `user_id=${q(a)}`)]
  await fails(asUser(a, `select public.create_conversation('t', null, null, 'original', ${q(key)});`), /duplicate key value violates unique constraint "messages_user_request_key"/)
  await fails(asUser(a, `select public.create_conversation('t', null, null, 'DIFFERENT CONTENT', ${q(key)});`), /messages_user_request_key/)
  assert.deepEqual([await count('conversations', `user_id=${q(a)}`), await count('messages', `user_id=${q(a)}`)], before, 'the whole create rolled back, including its conversation')
  // the key is scoped to the user: B may use the same value
  await mkConversation(b, { key })
  // messages: the same key twice in one user's data is refused, and the counter does not move
  const conv = await mkConversation(a)
  const k2 = randomUUID()
  await mkMessage(a, conv, { key: k2 })
  await fails(asUser(a, `insert into public.messages (conversation_id, role, content, client_request_id) values (${q(conv)}, 'user', 'again', ${q(k2)});`), /messages_user_request_key/)
  assert.equal(await scalar(`select message_count from public.conversations where id=${q(conv)}`), '2')
  // messages sent without a key never conflict
  await mkMessage(a, conv, { key: null })
  await mkMessage(a, conv, { key: null })
  assert.equal(await scalar(`select message_count from public.conversations where id=${q(conv)}`), '4')
})

// ------------------------------------------------------------------------------------- deletes and cascades

suite('deleting a project detaches its conversations and library items; nothing a user wrote is deleted', async () => {
  const a = await newUser()
  const project = await mkProject(a)
  const keep = await mkProject(a, 'other')
  const conv = await mkConversation(a, { project })
  const other = await mkConversation(a, { project: keep })
  await run(asOwner(`insert into public.library_items (user_id, project_id, kind, title) values (${q(a)}, ${q(project)}, 'note', 'in project'), (${q(a)}, ${q(keep)}, 'note', 'elsewhere');`))
  await run(asUser(a, `delete from public.projects where id=${q(project)};`))
  assert.equal(await scalar(`select count(*) from public.projects where id=${q(project)}`), '0')
  assert.equal(await scalar(`select project_id is null from public.conversations where id=${q(conv)}`), 'true')
  assert.equal(await scalar(`select user_id=${q(a)} from public.conversations where id=${q(conv)}`), 'true', 'only project_id was nulled; the owner is intact')
  assert.equal(await count('messages', `conversation_id=${q(conv)}`), '1')
  assert.equal(await scalar(`select project_id is null from public.library_items where title='in project' and user_id=${q(a)}`), 'true')
  assert.equal(await scalar(`select user_id=${q(a)} from public.library_items where title='in project' and user_id=${q(a)}`), 'true')
  // other projects' items are untouched
  assert.equal(await scalar(`select project_id=${q(keep)} from public.conversations where id=${q(other)}`), 'true')
  assert.equal(await scalar(`select project_id=${q(keep)} from public.library_items where title='elsewhere' and user_id=${q(a)}`), 'true')
})

suite('deleting a conversation cascades its messages and saved items, and nothing else', async () => {
  const a = await newUser()
  const conv = await mkConversation(a)
  const other = await mkConversation(a)
  await mkMessage(a, conv)
  const ids = await run(asOwner(`select '@@'||id from public.messages where conversation_id=${q(conv)} order by seq;`))
  await run(asUser(a, `insert into public.saved_items (conversation_id) values (${q(conv)}), (${q(other)});`))
  await run(asUser(a, `insert into public.saved_items (conversation_id, message_id) values (${q(conv)}, ${q(ids[0])}), (${q(conv)}, ${q(ids[1])});`))
  await run(asUser(a, `delete from public.conversations where id=${q(conv)};`))
  assert.equal(await count('messages', `conversation_id=${q(conv)}`), '0')
  assert.equal(await count('saved_items', `conversation_id=${q(conv)}`), '0')
  assert.equal(await count('conversations', `id=${q(other)}`), '1')
  assert.equal(await count('messages', `conversation_id=${q(other)}`), '1')
  assert.equal(await count('saved_items', `conversation_id=${q(other)}`), '1')
})

suite('library has no client write path, and its rows are private', async () => {
  const a = await newUser()
  const b = await newUser()
  await run(asOwner(`insert into public.library_items (user_id, source, kind, title) values (${q(a)}, 'ombre', 'note', 'seeded');`))
  const denied = /permission denied/
  await fails(asUser(a, `insert into public.library_items (title, kind) values ('mine', 'note');`), denied)
  await fails(asUser(a, `update public.library_items set title='edited';`), denied)
  await fails(asUser(a, `delete from public.library_items;`), denied)
  assert.deepEqual(await run(asUser(a, `select '@@'||title from public.library_items;`)), ['seeded'])
  assert.deepEqual(await run(asUser(b, `select '@@'||count(*) from public.library_items;`)), ['0'])
})

suite('deleting the auth user cascades every A4 table', async () => {
  const a = await newUser()
  const project = await mkProject(a)
  const conv = await mkConversation(a, { project })
  const message = (await run(asOwner(`select '@@'||id from public.messages where conversation_id=${q(conv)};`)))[0]
  await run(asUser(a, `insert into public.saved_items (conversation_id, message_id) values (${q(conv)}, ${q(message)});`))
  await run(asOwner(`insert into public.library_items (user_id, kind, title) values (${q(a)}, 'note', 'n');`))
  await run(asOwner(`delete from auth.users where id=${q(a)};`))
  users.splice(users.indexOf(a), 1)
  for (const t of tables) assert.equal(await count(t, `user_id=${q(a)}`), '0', t)
})
