import type { On, RenderElement } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const STEP = 'Типизация выявила две мелкие ошибки. Сейчас исправляю их.'
const PROMPT = 'собери мод с реакциями'

// The engine beneath the mod: tools answer (or `tool` decides), prompts and turns go
// through (or `prompt` decides), Claude's messages are drawn as a keyed Box standing for
// the app's own drawing, every drawing of a person's message is recorded by its row, and
// every line the mod logs is kept, so a test sees a failure the chat would hide.
type Bottom = {
  tool?: (e: { tool: string }) => unknown
  prompt?: (e: { text: string; context?: readonly string[] }) => unknown
}
function engine(on: On, bottom: Bottom = {}) {
  const shown = new Map<string, string>()
  const logs: string[] = []
  on('ui.log', ($, e) => {
    logs.push(e.text)
    return { value: undefined } as never
  })
  on('tool.call', ($, e) => (bottom.tool ? bottom.tool(e) : { result: 'ok' }) as never)
  on('prompt.submit', ($, e) => (bottom.prompt ? bottom.prompt(e) : { text: e.text, context: e.context }) as never)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.render', { component: 'UserMessage' }, ($, e) => {
    shown.set(e.requestId, e.props.text)
    return h('Box', { key: `engine-${e.requestId}` }, h('Text', {}, e.props.text)) as RenderElement
  })
  on('ui.render', { component: 'AssistantMessage' }, ($, e) =>
    h('Box', { key: `engine-${e.requestId}` }, h('Text', {}, e.props.text)) as RenderElement,
  )
  return { shown, logs }
}

const reply = ($: Engine, surface: 'terminal' | 'desktop', requestId: string, text: string, isSummary?: true) =>
  $.ui.mount({
    plugin: 'reactions',
    surface,
    component: 'AssistantMessage',
    props: isSummary ? { text, isFirstOfReply: true, isSummary } : { text, isFirstOfReply: true },
    requestId,
  })

const person = ($: Engine, row: string, text: string) =>
  $.ui.mount({
    plugin: 'reactions',
    surface: 'desktop',
    component: 'UserMessage',
    props: { text, origin: { kind: 'composer' }, isExpanded: true },
    requestId: row,
  })

// The row the engine stores for a prompt.
const stored = ($: Engine, row: string, text: string) =>
  $.session.append({
    message: { type: 'user', role: 'user', content: [{ type: 'text', text }] },
    door: 'prompt',
    origin: { kind: 'composer' },
    uuid: row,
  })

// What the engine does with a prompt typed while Claude is idle: the prompt goes through
// the hooks, its row is stored, and its turn starts.
async function ask($: Engine, row: string, text: string, turnId: string) {
  await $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false })
  await stored($, row, text)
  await $.turn.start({ text, turnId })
}
const finish = ($: Engine, turnId: string, reason: 'answer' | 'aborted' = 'answer') =>
  $.turn.complete({ turnId, reason, answer: 'Готово.', durationMs: 5, isAborted: reason === 'aborted' })

const contextOf = (ran: unknown) => ((ran as { context?: readonly string[] }).context ?? []).join(' ')
// Lines the mod logs while no store answers (as in most tests here) are about restoring.
const failures = (logs: readonly string[]) => logs.filter(line => !line.includes(': restore:') && !line.includes(': saving:'))

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: a reaction on a message between tool calls reaches Claude with its next tool result`, async ($, on) => {
    const clock = mock.clock(on)
    const { logs } = engine(on)
    const step = await reply($, surface, 'm1', STEP)
    // The app's own drawing of the message stays inside; nothing is chosen yet: ☺ shows,
    // and the row of reactions waits for the pointer.
    expect(await step.find({ key: 'engine-m1' })).toBeDefined()
    expect(await step.find({ key: 'chosen-m1' })).toBeUndefined()
    expect((await step.find({ key: 'open-m1' }))?.text).toBe('☺')
    expect(await step.findAll({ type: 'Button' })).toHaveLength(7)
    expect(JSON.stringify(await step.drawn())).toContain('"display":"none"')

    await step.press({ key: 'pick-m1-👎' })
    expect((await step.find({ key: 'chosen-m1' }))?.text).toBe('👎')
    expect(await step.find({ type: 'Text', text: '■' })).toBeDefined()
    await clock.advance(1000)
    expect(await step.find({ type: 'Text', text: '■' })).toBeUndefined()

    const ran = await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'b1' })
    expect(contextOf(ran)).toContain('👎 на «Типизация выявила две мелкие ошибки.')
    expect(contextOf(ran)).toContain('остановись')
    // 👎 asks for an answer, so the note does not say to leave it unanswered.
    expect(contextOf(ran)).not.toContain('не отвечай')

    const again = await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'b2' })
    expect(contextOf(again)).toBe('')
    expect(failures(logs)).toEqual([])
  })
}

test('☺ opens the row of reactions without hovering, one message at a time', async ($, on) => {
  mock.clock(on)
  engine(on)
  const first = await reply($, 'desktop', 'o1', 'Первое сообщение.')
  const second = await reply($, 'desktop', 'o2', 'Второе сообщение.')
  const isOpen = async (step: typeof first) => !JSON.stringify(await step.drawn()).includes('"display":"none"')
  expect(await isOpen(first)).toBe(false)

  await first.press({ key: 'open-o1' })
  expect(await isOpen(first)).toBe(true)
  // Opening another one closes the first.
  await second.press({ key: 'open-o2' })
  expect(await isOpen(first)).toBe(false)
  expect(await isOpen(second)).toBe(true)
  // Picking a reaction closes the row; pressing ☺ again would close it too.
  await second.press({ key: 'pick-o2-🔥' })
  expect(await isOpen(second)).toBe(false)
  await first.press({ key: 'open-o1' })
  await first.press({ key: 'open-o1' })
  expect(await isOpen(first)).toBe(false)
})

test('a reaction given between turns goes beside the next prompt, once', async ($, on) => {
  const clock = mock.clock(on)
  let context: readonly string[] | undefined
  engine(on, {
    prompt: e => {
      context = e.context
      return { text: e.text, context: e.context }
    },
  })
  const done = await reply($, 'desktop', 'm2', 'Готово, мод собран.')
  await done.press({ key: 'pick-m2-😂' })
  await clock.advance(1000)

  await $.prompt.submit({ text: 'дальше', origin: { kind: 'composer' }, wait: false })
  expect(context?.join(' ')).toContain('😂 на «Готово, мод собран.»')
  expect(context?.join(' ')).toContain('Отдельно на реакции не отвечай')

  await $.prompt.submit({ text: 'ещё', origin: { kind: 'composer' }, wait: false })
  expect(context).toBeUndefined()
})

test('pressing the reaction under the message takes it back, and Claude is not told', async ($, on) => {
  const clock = mock.clock(on)
  engine(on)
  const step = await reply($, 'desktop', 'm3', 'Проверяю файлы.')
  await step.press({ key: 'pick-m3-❤️' })
  await clock.advance(1000)
  await step.press({ key: 'chosen-m3' })
  expect(await step.find({ key: 'chosen-m3' })).toBeUndefined()

  const ran = await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'b3' })
  expect(contextOf(ran)).toBe('')
})

test('a double click sets the reaction once instead of setting and taking it back', async ($, on) => {
  const clock = mock.clock(on)
  engine(on)
  const step = await reply($, 'desktop', 'm4', 'Собираю тесты.')
  await step.press({ key: 'pick-m4-🔥' })
  await clock.advance(120)
  await step.press({ key: 'pick-m4-🔥' })
  expect((await step.find({ key: 'chosen-m4' }))?.text).toBe('🔥')

  // A press later on is meant: it takes the reaction back.
  await clock.advance(1000)
  await step.press({ key: 'chosen-m4' })
  expect(await step.find({ key: 'chosen-m4' })).toBeUndefined()
})

test('a summary between tool calls and an empty block stay exactly as the app draws them', async ($, on) => {
  engine(on)
  const summary = await reply($, 'desktop', 'm5', 'Прочитал три файла', true)
  expect(await summary.drawn()).toMatchObject({ type: 'Box', props: { key: 'engine-m5' } })
  const empty = await reply($, 'desktop', 'm6', '   ')
  expect(await empty.drawn()).toMatchObject({ type: 'Box', props: { key: 'engine-m6' } })
})

test("the person's message gets 👀 when Claude reads it, then ✅ and Claude's reaction", async ($, on) => {
  const clock = mock.clock(on)
  const { shown, logs } = engine(on)
  await ask($, 'u1', PROMPT, 't1')
  await person($, 'u1', PROMPT)
  expect(shown.get('u1')).toBe(`${PROMPT}\n👀`)

  const reacted = await $.tool.call({ tool: 'mcp__reactions__react', emoji: '❤️', tool_use_id: 'r1' })
  expect('result' in reacted && String(reacted.result)).toContain('❤️')
  await finish($, 't1')
  await clock.advance(1000)
  expect(shown.get('u1')).toBe(`${PROMPT}\n❤️  ✅`)
  expect(failures(logs)).toEqual([])
})

test('two messages with the same text keep their own marks', async ($, on) => {
  const { shown, logs } = engine(on)
  await ask($, 'u1', 'гуд', 't1')
  await finish($, 't1')
  await ask($, 'u2', 'гуд', 't2')
  const first = await person($, 'u1', 'гуд')
  const second = await person($, 'u2', 'гуд')
  expect(shown.get('u1')).toBe('гуд\n✅')
  expect(shown.get('u2')).toBe('гуд\n👀')
  await finish($, 't2', 'aborted')
  await first.redraw()
  await second.redraw()
  expect(failures(logs)).toEqual([])
  expect(shown.get('u2')).toBe('гуд\n⏹️')
  expect(shown.get('u1')).toBe('гуд\n✅')
})

test('a message typed while Claude works gets 👀 once Claude has read it, then ✅', async ($, on) => {
  const { shown, logs } = engine(on)
  await ask($, 'u1', PROMPT, 't1')
  const typed = 'и добавь эффект искр'
  await $.prompt.submit({ text: typed, origin: { kind: 'composer' }, wait: false, turnId: 't1' })
  const bubble = await person($, 'q1', typed)
  expect(shown.get('q1')).toBe(typed)

  await $.session.append({
    message: {
      type: 'attachment',
      name: 'queued_command',
      content: [{ type: 'text', text: `<system-reminder>\nThe user sent a new message while you were working:\n${typed}\n</system-reminder>` }],
    },
    door: 'attachment',
    origin: { kind: 'composer' },
    uuid: 'q1',
  })
  await bubble.redraw()
  expect(failures(logs)).toEqual([])
  expect(shown.get('q1')).toBe(`${typed}\n👀`)

  // Claude's reaction lands on the message Claude has read last.
  await $.tool.call({ tool: 'mcp__reactions__react', emoji: '🔥', tool_use_id: 'r2' })
  await finish($, 't1')
  await bubble.redraw()
  await (await person($, 'u1', PROMPT)).redraw()
  expect(shown.get('q1')).toContain('🔥')
  expect(shown.get('q1')?.endsWith('✅')).toBe(true)
  expect(shown.get('u1')?.endsWith('✅')).toBe(true)
})

test('a message typed at the very end of a turn is marked by the turn it starts', async ($, on) => {
  const { shown, logs } = engine(on)
  await ask($, 'u1', PROMPT, 't1')
  const typed = 'а теперь README'
  await $.prompt.submit({ text: typed, origin: { kind: 'composer' }, wait: false, turnId: 't1' })
  await finish($, 't1')
  const bubble = await person($, 'u2', typed)
  expect(shown.get('u2')).toBe(typed)

  await stored($, 'u2', typed)
  await $.turn.start({ text: typed, turnId: 't2' })
  await bubble.redraw()
  expect(failures(logs)).toEqual([])
  expect(shown.get('u2')).toBe(`${typed}\n👀`)
  await finish($, 't2')
  await bubble.redraw()
  expect(shown.get('u2')).toBe(`${typed}\n✅`)
})

test('a message the queue mod sends later is marked as the person\'s own', async ($, on) => {
  const { shown, logs } = engine(on)
  const queued = { kind: 'plugin', name: 'queue', asUser: true } as const
  await $.prompt.submit({ text: 'из очереди', origin: queued as never, wait: false })
  await $.session.append({
    message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'из очереди' }] },
    door: 'prompt',
    origin: queued as never,
    uuid: 'u7',
  })
  await $.turn.start({ text: 'из очереди', turnId: 't7' })
  const bubble = await $.ui.mount({
    plugin: 'reactions',
    surface: 'desktop',
    component: 'UserMessage',
    props: { text: 'из очереди', origin: queued as never, isExpanded: true },
    requestId: 'u7',
  })
  expect(shown.get('u7')).toBe('из очереди\n👀')
  await finish($, 't7')
  await bubble.redraw()
  expect(shown.get('u7')).toBe('из очереди\n✅')
  expect(failures(logs)).toEqual([])
})

test("a subagent's tool call and a refused one leave the reaction for Claude's next call", async ($, on) => {
  const clock = mock.clock(on)
  engine(on, { tool: e => (e.tool === 'Write' ? { deny: 'нет' } : { result: 'ok' }) })
  const step = await reply($, 'desktop', 'm7', 'Пишу файл.')
  await step.press({ key: 'pick-m7-🤔' })
  await clock.advance(1000)

  const child = await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'b4', agentId: 'a1' } as never)
  expect(contextOf(child)).toBe('')
  const refused = await $.tool.call({ tool: 'Write', file_path: '/tmp/x', content: 'x', tool_use_id: 'w1' })
  expect(contextOf(refused)).toBe('')
  const ran = await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'b5' })
  expect(contextOf(ran)).toContain('🤔 на «Пишу файл.»')
  expect(contextOf(ran)).toContain('перепроверь')
})

// Stands for the person interrupting a running tool: it settles the call at once and
// leaves the hooks beneath running on, their result thrown away.
const interrupt = {
  name: 'interrupt',
  tier: 'prepend',
  register(on: On) {
    on('tool.call', async ($, e, next) => {
      if (e.tool !== 'mcp__t__slow') return next(e)
      void next(e).catch(() => undefined)
      return { result: 'Interrupted by user' } as never
    })
  },
} as const

test('a reaction is not lost when the person interrupts the running tool', { plugins: [interrupt as never] }, async ($, on) => {
  const clock = mock.clock(on)
  engine(on, {
    tool: async e => {
      if (e.tool === 'mcp__t__slow') await clock.sleep(1000)
      return { result: 'ok' }
    },
  })
  const step = await reply($, 'desktop', 'm11', 'Запускаю долгую сборку.')
  await step.press({ key: 'pick-m11-👍' })
  await clock.advance(500)
  const cut = await $.tool.call({ tool: 'mcp__t__slow', tool_use_id: 's1' } as never)
  expect(contextOf(cut)).toBe('')
  await clock.advance(1500)
  const ran = await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'b9' })
  expect(contextOf(ran)).toContain('👍 на «Запускаю долгую сборку.»')
})

test('a prompt that did not go in gives its reactions back', async ($, on) => {
  const clock = mock.clock(on)
  let drop = true
  engine(on, {
    prompt: e => {
      if (!drop) return { text: e.text, context: e.context }
      drop = false
      return { drop: 'занято' }
    },
  })
  const step = await reply($, 'desktop', 'm8', 'Обновляю README.')
  await step.press({ key: 'pick-m8-👍' })
  await clock.advance(1000)

  expect(await $.prompt.submit({ text: 'гуд', origin: { kind: 'composer' }, wait: false })).toMatchObject({ drop: 'занято' })
  const ran = await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'b6' })
  expect(contextOf(ran)).toContain('👍 на «Обновляю README.»')
})

test('the react tool takes one emoji from the main agent, on a message there is', async ($, on) => {
  engine(on)
  const early = await $.tool.call({ tool: 'mcp__reactions__react', emoji: '👍', tool_use_id: 'r3' })
  expect('deny' in early && early.deny).toContain('Пока нет сообщения')
  await ask($, 'u1', PROMPT, 't1')
  const words = await $.tool.call({ tool: 'mcp__reactions__react', emoji: 'ок', tool_use_id: 'r4' })
  expect('deny' in words && words.deny).toContain('одно эмодзи')
  const child = await $.tool.call({ tool: 'mcp__reactions__react', emoji: '👍', tool_use_id: 'r5', agentId: 'a1' } as never)
  expect('deny' in child && child.deny).toContain('основной агент')
  const family = await $.tool.call({ tool: 'mcp__reactions__react', emoji: '👨‍👩‍👧', tool_use_id: 'r6' })
  expect('result' in family).toBe(true)
})

// The mod's own store, in memory: what the app keeps on disk between launches.
function storeOn(on: On, start: Record<string, unknown>) {
  const store = new Map<string, unknown>(Object.entries(start))
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('store.delete', ($, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('tool.register', () => ({ value: { tool: 'mcp__reactions__react' } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  return store
}

test('reactions and marks come back after the app restarts, a turn cut short as ⏹️', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  const { shown, logs } = engine(on)
  const store = storeOn(on, {
    'session:s1': {
      given: { m9: '🔥' },
      notes: { u1: { mark: '👀', mine: '❤️' } },
      pending: [{ id: 'm8', emoji: '👍', preview: 'Старое' }],
      at: 1,
    },
  })
  on('session.id', () => ({ value: 's1' }))
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })

  const old = await reply($, 'desktop', 'm9', 'Старый ответ.')
  expect((await old.find({ key: 'chosen-m9' }))?.text).toBe('🔥')
  await person($, 'u1', 'старое сообщение')
  expect(shown.get('u1')).toBe('старое сообщение\n❤️  ⏹️')

  // The reaction that had not reached Claude before the restart still does.
  const ran = await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'b7' })
  expect(contextOf(ran)).toContain('👍 на «Старое»')

  const fresh = await reply($, 'desktop', 'm10', 'Новый ответ.')
  await fresh.press({ key: 'pick-m10-❤️' })
  await clock.advance(1000)
  const saved = store.get('session:s1') as { given: Record<string, string>; pending: unknown[] } | undefined
  expect(saved?.given).toEqual({ m9: '🔥', m10: '❤️' })
  expect(saved?.pending).toHaveLength(1)
  expect(logs).toEqual([])
})

test('a store v0.2 left is read, and old chats beyond the last 30 are let go', async ($, on) => {
  const { shown, logs } = engine(on)
  const start: Record<string, unknown> = {
    'session:s1': { given: { m1: '👍' }, mine: { 'старый гуд': '🤝' }, marks: { 'старый гуд': '✅' }, at: 50 },
  }
  for (let i = 0; i < 31; i += 1) start[`session:old${i}`] = { given: {}, notes: {}, pending: [], at: i }
  const store = storeOn(on, start)
  on('session.id', () => ({ value: 's1' }))
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })

  await person($, 'u9', 'старый гуд')
  expect(shown.get('u9')).toBe('старый гуд\n🤝  ✅')
  expect(store.has('session:s1')).toBe(true)
  expect(store.has('session:old0')).toBe(false)
  expect(store.has('session:old1')).toBe(false)
  expect(store.has('session:old2')).toBe(true)
  expect([...store.keys()].filter(key => key.startsWith('session:'))).toHaveLength(30)
  expect(logs).toEqual([])
})

test('a chat resumed in the same process brings its own reactions', async ($, on) => {
  const { logs } = engine(on)
  storeOn(on, {
    'session:s1': { given: { a1: '👍' }, notes: {}, pending: [], at: 1 },
    'session:s2': { given: { b1: '😂' }, notes: {}, pending: [], at: 2 },
  })
  let session = 's1'
  on('session.id', () => ({ value: session }))
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  expect((await (await reply($, 'desktop', 'a1', 'Первый чат.')).find({ key: 'chosen-a1' }))?.text).toBe('👍')

  session = 's2'
  await $.prompt.submit({ text: 'продолжим', origin: { kind: 'composer' }, wait: false })
  expect((await (await reply($, 'desktop', 'b1', 'Второй чат.')).find({ key: 'chosen-b1' }))?.text).toBe('😂')
  expect(logs).toEqual([])
})
