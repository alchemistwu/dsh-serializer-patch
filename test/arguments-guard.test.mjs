/**
 * Behavior tests for the dsh-llm-deepseek arguments guard patch.
 *
 * Usage:
 *   1. git clone --depth 1 --branch dsh-v0.1.2-alpha.2 \
 *        https://github.com/deepseek-ai/deepseek-harness.git dsh
 *   2. cd dsh && git apply /path/to/dsh-llm-deepseek-arguments-guard.patch
 *   3. pnpm install --frozen-lockfile && pnpm run build:lib:host
 *   4. node /path/to/test/arguments-guard.test.mjs
 *
 * The script imports the BUILT serialize.js from the clone and runs six
 * assertions. Exit code 0 = all pass; non-zero = failure with details.
 *
 * No test framework needed — plain node (>= 18).
 */

import { strict as assert } from 'node:assert'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO = process.env.DSH_REPO ?? join(process.cwd(), 'dsh')
const SERIALIZE = join(REPO, 'packages/llm/llm-deepseek/lib/types/serialize.js')

if (!existsSync(SERIALIZE)) {
  console.error(`serialize.js not found at ${SERIALIZE}`)
  console.error('Build first: pnpm install --frozen-lockfile && pnpm run build:lib:host')
  process.exit(2)
}

const { serializeMessages, serializeMessagesWithImages } = await import(
  pathToFileURL(SERIALIZE).href
)

const text = (t) => ({ type: 'text', text: t })

// A tool call whose arguments are NOT valid JSON — the exact shape that
// bricked a production session (unescaped inner quotes, GLM-5.3-Flash/vLLM).
const BAD_CALL = {
  type: 'tool-call',
  id: 'call_bad',
  name: 'web_search',
  arguments: '{"queries": [""The Idiots" Szumowska 2026 trailer"]}',
}
const GOOD_CALL = {
  type: 'tool-call',
  id: 'call_good',
  name: 'web_search',
  arguments: '{"queries": ["idiots 2026"]}',
}
const BAD_RESULT = {
  type: 'tool-result',
  toolCallId: 'call_bad',
  content: [text('results from the poisoned call')],
}
const GOOD_RESULT = {
  type: 'tool-result',
  toolCallId: 'call_good',
  content: [text('results from the valid call')],
}

let passed = 0
function check(name, fn) {
  fn()
  passed++
  console.log(`  ok ${passed}. ${name}`)
}

console.log('serializeMessages (text path)')

const wire = serializeMessages([
  { role: 'system', content: [text('you are helpful')] },
  { role: 'user', content: [text('find the trailer')] },
  { role: 'assistant', content: [text('Let me search.'), BAD_CALL, GOOD_CALL] },
  { role: 'user', content: [BAD_RESULT, GOOD_RESULT] },
])

const assistant = wire.find((m) => m.role === 'assistant')
check('malformed call is dropped from tool_calls', () => {
  assert.equal(assistant.tool_calls.length, 1)
  assert.equal(assistant.tool_calls[0].id, 'call_good')
})
check('honest record appended to assistant text with original arguments', () => {
  assert.match(assistant.content, /Let me search\./)
  assert.match(assistant.content, /removed from history because its arguments were malformed JSON/)
  assert.match(assistant.content, /Original arguments as emitted:/)
  assert.ok(assistant.content.includes(BAD_CALL.arguments), 'original arguments verbatim in record')
})
check('dropped call has NO orphan role:"tool" reply', () => {
  const orphan = wire.find((m) => m.role === 'tool' && m.tool_call_id === 'call_bad')
  assert.equal(orphan, undefined)
})
check("dropped call's result re-expressed as a user message", () => {
  const note = wire.find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[Tool Result: call_bad]'))
  assert.ok(note, 'expected user message "[Tool Result: call_bad] ..."')
  assert.ok(note.content.includes('results from the poisoned call'))
})
check("valid call's result stays a proper role:\"tool\" reply", () => {
  const proper = wire.find((m) => m.role === 'tool' && m.tool_call_id === 'call_good')
  assert.ok(proper, 'expected role:"tool" entry for call_good')
  assert.equal(proper.content, 'results from the valid call')
})

console.log('serializeMessagesWithImages (image path, text-only input)')

const imageWire = await serializeMessagesWithImages(
  [
    { role: 'assistant', content: [BAD_CALL] },
    { role: 'user', content: [BAD_RESULT] },
  ],
  {
    // No images in this fixture: resolvers must never be consulted.
    resolveImageAccess: async () => { throw new Error('unexpected image access') },
    attachmentRefs: () => [],
    prepareForRequest: async () => { throw new Error('unexpected image prepare') },
  },
)

const imgAssistant = imageWire.find((m) => m.role === 'assistant')
check('image path: all-dropped call leaves honest record as content (never null)', () => {
  assert.equal(imgAssistant.tool_calls, undefined)
  assert.match(imgAssistant.content, /malformed JSON/)
  assert.ok(imgAssistant.content.length > 0, 'content non-empty avoids the 400 "content or tool_calls must be set"')
})
check('image path: dropped result becomes a user message (content parts)', () => {
  const note = imageWire.find((m) => m.role === 'user')
  assert.ok(note, 'expected user message')
  const parts = Array.isArray(note.content) ? note.content : [{ type: 'text', text: note.content }]
  const joined = parts.filter((p) => p.type === 'text').map((p) => p.text).join('')
  assert.ok(joined.startsWith('[Tool Result: call_bad]'))
  assert.equal(imageWire.find((m) => m.role === 'tool'), undefined, 'no orphan role:"tool"')
})

console.log(`\nAll ${passed} checks passed.`)
