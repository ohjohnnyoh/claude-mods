// Reactions on messages, as in a messenger, while Claude works and after.
//
// The person reacts to any message of Claude's, the ones between tool calls included: a
// faint ☺ sits in the message's bottom right corner, and the row of reactions opens beside
// it while the pointer is on the message, or once ☺ is pressed. One press sets a reaction,
// and it stays under the message with a short burst of pixel sparks; pressing it there
// takes it back. A reaction never interrupts the turn: while Claude
// works it rides on the result of Claude's next tool call, otherwise beside the person's
// next message.
// Claude marks the person's messages: 👀 once it has read one, ✅ (⏹️, ⚠️) when the turn
// that answers it ends, and a reaction of its own through the `react` tool.
import { atom, memberOf, read, update } from 'claude-code'
import type { Hook, Register } from 'claude-code'

import type { Bubble, Note, Pending, Saved, Unread } from '../types'

type Engine = Parameters<Hook<'prompt.submit'>>[0]
type Block = { type: string; text?: unknown }

const EMOJIS = ['👍', '👎', '🤔', '😂', '❤️', '🔥']
const TOOL = 'mcp__reactions__react'
// Prompts typed by a person: in the terminal, in the desktop app, through Remote Control.
const PERSON = new Set(['composer', 'sdk', 'bridge'])
// The person's own words: typed, or typed while Claude worked and sent later by the queue mod.
const isPerson = (origin: unknown) => {
  const from = origin as { kind?: unknown; name?: unknown } | null
  return typeof from?.kind === 'string' && (PERSON.has(from.kind) || (from.kind === 'plugin' && from.name === 'queue'))
}
const FRAME_MS = 70
// A second press of the same reaction this soon after the first is the same click.
const BOUNCE_MS = 400
// Pixel sparks flying out of the emoji, nearest cell first; each frame lists its lit cells.
const SPARKS: ReadonlyArray<ReadonlyArray<readonly [string, string]>> = [
  [['■', '#ffd23f']],
  [['■', '#ffd23f'], ['▪', '#ff8c42']],
  [['■', '#ffd23f'], ['▪', '#ff8c42'], ['·', '#ff5d8f']],
  [['■', '#ff8c42'], ['▪', '#5ce1e6'], ['·', '#ff5d8f'], [' ', '']],
  [['▪', '#ff5d8f'], ['·', '#5ce1e6'], [' ', ''], [' ', '']],
  [['·', '#5ce1e6'], [' ', ''], [' ', ''], [' ', '']],
]
// The same burst in plain text, for a person's message the app draws itself.
const TEXT_SPARKS = [' ✦', ' ·✦', ' · ✧', '  · ·', '    ·']
// What a reaction asks of Claude; the others are just feelings.
const MEANING: Record<string, string> = {
  '👍': '👍 — согласен, продолжай так же',
  '👎': '👎 — ты идёшь не туда: остановись, в двух словах скажи, что делаешь, и спроси, как нужно',
  '🤔': '🤔 — сомневается: перепроверь этот шаг',
}
// Only the most recent chats keep their reactions in the store.
const KEPT_SESSIONS = 30
const EMPTY: Saved = { given: {}, notes: {}, pending: [], at: 0 }

// One member per message drawn, so a change redraws that message alone.
const bubble = atom({ plugin: 'reactions', key: 'bubble' } as const, null as Bubble | null)
const note = atom({ plugin: 'reactions', key: 'note' } as const, null as Note | null)
// Bookkeeping no drawing reads.
const pending = atom({ plugin: 'reactions', key: 'pending' } as const, [] as Pending[])
const saved = atom({ plugin: 'reactions', key: 'saved' } as const, EMPTY)
const unread = atom({ plugin: 'reactions', key: 'unread' } as const, [] as Unread[])
const turnRead = atom({ plugin: 'reactions', key: 'turnRead' } as const, {} as Record<string, string[]>)
const rowOf = atom({ plugin: 'reactions', key: 'rowOf' } as const, {} as Record<string, string>)
const last = atom({ plugin: 'reactions', key: 'last' } as const, null as string | null)
const openId = atom({ plugin: 'reactions', key: 'openId' } as const, null as string | null)
const running = atom({ plugin: 'reactions', key: 'running' } as const, null as string | null)
const loaded = atom({ plugin: 'reactions', key: 'loaded' } as const, null as string | null)

const norm = (text: string) => text.trim().replace(/\s+/g, ' ')
const preview = (text: string) => {
  const line = norm(text)
  return line.length > 80 ? `${line.slice(0, 80)}…` : line
}
// A message of the person's is found by its text where nothing better is known: the
// text's hash and length make a short key two different messages hardly ever share.
const textKey = (text: string) => {
  const line = norm(text)
  let hash = 0x811c9dc5
  for (let i = 0; i < line.length; i += 1) hash = Math.imul(hash ^ line.charCodeAt(i), 0x01000193) >>> 0
  return `t:${hash.toString(36)}:${line.length}`
}
const textOf = (content: readonly Block[]) =>
  content.flatMap(block => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : []))
// One emoji, as the model sends it: no letters, no spaces, a few code points at most.
const oneEmoji = (raw: unknown) => {
  if (typeof raw !== 'string') return ''
  const text = raw.trim()
  const points = Array.from(text)
  if (points.length === 0 || points.length > 8 || /[\p{L}\s]/u.test(text)) return ''
  return points.some(point => (point.codePointAt(0) ?? 0) >= 0x2100) ? text : ''
}

function keepLast<T>(record: Record<string, T>, max: number) {
  const keys = Object.keys(record)
  if (keys.length <= max) return record
  const kept: Record<string, T> = {}
  for (const key of keys.slice(-max)) {
    const value = record[key]
    if (value !== undefined) kept[key] = value
  }
  return kept
}
function without<T>(record: Record<string, T>, key: string) {
  const rest = { ...record }
  delete rest[key]
  return rest
}
// A value with its unset fields dropped, or null when none is left.
function tidy<T extends object>(value: T): T | null {
  const kept = Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined))
  return Object.keys(kept).length ? (kept as T) : null
}

function told(list: readonly Pending[], whileWorking: boolean) {
  const said = list.map(one => `${one.emoji} на «${one.preview}»`).join('; ')
  const meant = [...new Set(list.map(one => one.emoji))].flatMap(emoji => MEANING[emoji] ?? [])
  return [
    `${whileWorking ? 'Пользователь отреагировал по ходу твоей работы' : 'Реакции пользователя на твои сообщения'}: ${said}.`,
    meant.length ? `Что это значит: ${meant.join('; ')}.` : '',
    // 👎 asks for an answer; every other reaction is only taken into account.
    list.some(one => one.emoji === '👎') ? '' : 'Отдельно на реакции не отвечай, просто учти их.',
  ]
    .filter(Boolean)
    .join(' ')
}

// What went wrong goes to the debug log; the chat itself never shows it.
function fail($: Engine, where: string, error: unknown) {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : JSON.stringify(error)
  try {
    $.ui.log(`reactions: ${where}: ${text}`, { to: 'debug' })
  } catch {
    // Nowhere left to say it.
  }
}

// Saves are chained, so two never race, and coalesced: a run of changes is one write.
let saving: Promise<void> = Promise.resolve()
let isSaveQueued = false
function keep($: Engine) {
  if (isSaveQueued) return
  isSaveQueued = true
  saving = saving
    .then(async () => {
      isSaveQueued = false
      const id = await $.session.id()
      await $.store.set(`session:${id}`, { ...(await read($, saved)), at: await $.clock.now() })
    })
    .catch(error => fail($, 'saving', error))
}
async function remember($: Engine, change: (current: Saved) => Saved) {
  await update($, saved, change)
  keep($)
}

// The store as v0.2 left it kept the person's messages by their text, cut at 500 characters.
function upgrade(value: unknown): Saved | null {
  if (!value || typeof value !== 'object') return null
  const old = value as Partial<Saved> & { mine?: Record<string, string>; marks?: Record<string, string> }
  const notes: Saved['notes'] = { ...old.notes }
  for (const [field, list] of [['mark', old.marks], ['mine', old.mine]] as const) {
    for (const [text, emoji] of Object.entries(list ?? {})) {
      if (text.length >= 500) continue
      const key = textKey(text)
      notes[key] = { ...notes[key], [field]: emoji }
    }
  }
  return { given: { ...old.given }, notes, pending: [...(old.pending ?? [])], at: old.at ?? 0 }
}

// Loading never holds an event up: a store that fails leaves the chat without its old reactions.
const load = ($: Engine) => ensureLoaded($).catch(error => fail($, 'restore', error))

// The chat's reactions come back from the store once per process and chat: after the app
// restarts, and when another chat is resumed in this one.
async function ensureLoaded($: Engine) {
  const id = await $.session.id()
  const before = await read($, loaded)
  if (before === id) return
  await update($, loaded, () => id)
  if (before !== null) {
    await update($, saved, () => EMPTY)
    await update($, pending, () => [])
    await update($, unread, () => [])
    await update($, turnRead, () => ({}))
    await update($, last, () => null)
    await update($, running, () => null)
  }
  const stored = upgrade(await $.store.get(`session:${id}`))
  if (stored) {
    // A turn that was running when the app closed did not finish.
    for (const kept of Object.values(stored.notes)) if (kept.mark === '👀') kept.mark = '⏹️'
    for (const [message, emoji] of Object.entries(stored.given)) {
      await update($, memberOf(bubble, { requestId: message }), current => current ?? { given: emoji })
    }
    for (const [key, kept] of Object.entries(stored.notes)) {
      await update($, memberOf(note, { requestId: key }), current => current ?? tidy({ ...kept }))
    }
    await update($, pending, list => [...stored.pending.filter(one => !list.some(other => other.id === one.id)), ...list].slice(-20))
    const list = await read($, pending)
    await update($, saved, current => ({
      given: keepLast({ ...stored.given, ...current.given }, 300),
      notes: keepLast({ ...stored.notes, ...current.notes }, 400),
      pending: list,
      at: current.at,
    }))
  }
  await prune($, id)
}

async function prune($: Engine, current: string) {
  const keys = (await $.store.keys()).filter(key => key.startsWith('session:') && key !== `session:${current}`)
  if (keys.length < KEPT_SESSIONS) return
  const dated = await Promise.all(
    keys.map(async key => ({ key, at: ((await $.store.get(key)) as { at?: number } | undefined)?.at ?? 0 })),
  )
  dated.sort((a, b) => a.at - b.at)
  for (const old of dated.slice(0, dated.length - KEPT_SESSIONS + 1)) await $.store.delete(old.key)
}

// Takes the reactions Claude has not been told about yet, leaving none behind. One
// versioned write, so two tool calls finishing together never both deliver the same one.
async function takePending($: Engine) {
  if ((await read($, pending)).length === 0) return []
  let taken = [] as Pending[]
  await update($, pending, current => {
    taken = current
    return []
  })
  if (taken.length) await remember($, current => ({ ...current, pending: [] }))
  return taken
}
// Puts back reactions whose ride did not happen; a newer reaction on a message wins.
async function giveBack($: Engine, taken: readonly Pending[]) {
  if (taken.length === 0) return
  await update($, pending, list => [...taken.filter(one => !list.some(other => other.id === one.id)), ...list].slice(-20))
  const list = await read($, pending)
  await remember($, current => ({ ...current, pending: list }))
}

// The person's message is kept under its text's key and, once known, under its row too.
async function setNote($: Engine, key: string, change: (current: Note) => Note) {
  const row = (await read($, rowOf))[key]
  let value = null as Note | null
  await update($, memberOf(note, { requestId: key }), current => (value = tidy(change({ ...current }))))
  if (row) await update($, memberOf(note, { requestId: row }), () => value)
  const kept = value ? tidy({ mark: value.mark, mine: value.mine }) : null
  await remember($, current => {
    const notes = { ...current.notes }
    for (const id of row ? [key, row] : [key]) {
      if (kept) notes[id] = kept
      else delete notes[id]
    }
    return { ...current, notes: keepLast(notes, 400) }
  })
}

// One burst of sparks: a frame every FRAME_MS, then none. A newer burst on the same
// message takes over from an older one.
const bursts = new Map<string, number>()
async function sparkle($: Engine, target: string, frames: number, draw: (frame: number | undefined) => Promise<unknown>) {
  const turn = (bursts.get(target) ?? 0) + 1
  bursts.set(target, turn)
  for (let frame = 0; frame <= frames; frame += 1) {
    if (bursts.get(target) !== turn) return
    await draw(frame)
    await $.clock.sleep(FRAME_MS)
  }
  if (bursts.get(target) !== turn) return
  bursts.delete(target)
  await draw(undefined)
}
const drawBubble = ($: Engine, id: string) => (frame: number | undefined) =>
  update($, memberOf(bubble, { requestId: id }), current => (current?.given ? tidy({ ...current, frame }) : current))
const drawNote = ($: Engine, key: string) => async (frame: number | undefined) => {
  const row = (await read($, rowOf))[key]
  for (const id of row ? [key, row] : [key]) {
    await update($, memberOf(note, { requestId: id }), current => (current?.mine ? tidy({ ...current, frame }) : current))
  }
}

let lastPress = { what: '', at: Number.NEGATIVE_INFINITY }
async function choose($: Engine, message: { id: string; preview: string }, emoji: string) {
  const at = await $.clock.now()
  const what = `${message.id} ${emoji}`
  if (what === lastPress.what && at - lastPress.at < BOUNCE_MS) return
  lastPress = { what, at }
  let removed = false
  await update($, memberOf(bubble, { requestId: message.id }), current => {
    removed = current?.given === emoji
    return tidy({ ...current, given: removed ? undefined : emoji, open: undefined, frame: undefined })
  })
  await update($, openId, current => (current === message.id ? null : current))
  await update($, pending, list => {
    const rest = list.filter(one => one.id !== message.id)
    return removed ? rest : [...rest, { id: message.id, emoji, preview: message.preview }].slice(-20)
  })
  const list = await read($, pending)
  await remember($, current => {
    const given = { ...current.given }
    if (removed) delete given[message.id]
    else given[message.id] = emoji
    return { ...current, given: keepLast(given, 300), pending: list }
  })
  if (!removed) {
    void sparkle($, `bubble:${message.id}`, SPARKS.length - 1, drawBubble($, message.id)).catch(error => fail($, 'sparks', error))
  }
}

// ☺ pressed: the row of reactions opens under the pointer and stays open, one at a time.
async function toggle($: Engine, id: string) {
  let isOpening = false
  await update($, memberOf(bubble, { requestId: id }), current => {
    isOpening = !current?.open
    return tidy<Bubble>({ ...current, open: isOpening ? true : undefined })
  })
  const before = await read($, openId)
  if (isOpening && before !== null && before !== id) {
    await update($, memberOf(bubble, { requestId: before }), current => (current ? tidy({ ...current, open: undefined }) : current))
  }
  await update($, openId, current => (isOpening ? id : current === id ? null : current))
}

// The person's message is in the transcript now, under the row the app finds it by.
async function stored($: Engine, row: string, text: string) {
  const key = textKey(text)
  await update($, rowOf, map => keepLast({ ...map, [key]: row }, 200))
  const now = await read($, memberOf(note, { requestId: key }))
  const kept = now ? tidy({ mark: now.mark, mine: now.mine }) : null
  if (!kept) return
  await update($, memberOf(note, { requestId: row }), () => kept)
  await remember($, current => ({ ...current, notes: keepLast({ ...current.notes, [row]: kept }, 400) }))
}

// A message typed while Claude worked reached Claude between two steps of its turn.
async function absorbed($: Engine, row: string, shown: string) {
  const text = norm(shown)
  let found = null as Unread | null
  await update($, unread, list => {
    const waiting = list.filter(one => !one.idle)
    found = waiting.find(one => text.includes(one.text)) ?? waiting[0] ?? null
    return found ? list.filter(one => one !== found) : list
  })
  const one = found as Unread | null
  if (!one) return
  const turn = await read($, running)
  if (turn) await update($, turnRead, map => ({ ...map, [turn]: [...(map[turn] ?? []), one.key] }))
  await update($, rowOf, map => keepLast({ ...map, [one.key]: row }, 200))
  await update($, last, () => one.key)
  await setNote($, one.key, current => ({ ...current, mark: '👀' }))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool
      .register({
        name: 'react',
        description:
          'Поставить реакцию-эмодзи на последнее сообщение пользователя, как в мессенджере. Ставь живо, как в чате с другом: 😂 на шутку, ❤️ на тёплые слова и благодарность, 👍 на согласие, 🔥 на сильную идею, 🤝 когда договорились, 🙏 в ответ на спасибо, 🤯 на неожиданное. Новая реакция заменяет прежнюю; реакция не заменяет ответ.',
        isDeferred: false,
        inputSchema: {
          type: 'object',
          properties: { emoji: { type: 'string', description: 'Одно эмодзи' } },
          required: ['emoji'],
          additionalProperties: false,
        },
      })
      .catch(error => fail($, 'react tool', error))
    // Restoring the chat's reactions does not depend on the tool being registered.
    await load($)
    return next(e)
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    // The tool's arguments arrive beside `tool` on the event itself, not under an `input` key.
    const raw = (e as unknown as { emoji?: unknown }).emoji
    if ((e as { agentId?: string }).agentId !== undefined) return { deny: 'Реакции ставит только основной агент.' }
    const emoji = oneEmoji(raw)
    if (!emoji) return { deny: 'Нужно одно эмодзи, без слов.' }
    await load($)
    const key = await read($, last)
    if (!key) return { deny: 'Пока нет сообщения пользователя, на которое можно поставить реакцию.' }
    await setNote($, key, current => ({ ...current, mine: emoji }))
    void sparkle($, `note:${key}`, TEXT_SPARKS.length - 1, drawNote($, key)).catch(error => fail($, 'sparks', error))
    return { result: `Реакция ${emoji} стоит на последнем сообщении пользователя.` }
  }).catch(($, e, next) => {
    fail($, 'react', next.error)
    return { deny: `Реакцию поставить не удалось: ${next.error.message ?? next.error.kind}.` }
  })

  // While Claude works: a reaction rides on the result of Claude's next tool call, so it
  // is read at once and the turn goes on uninterrupted. Only the model's own calls on the
  // main loop carry it: a subagent's and another plugin's `$.tool.call` answer someone else.
  on('tool.call', async ($, e, next) => {
    if (e.tool === TOOL || e.agentId !== undefined || next.origin.plugin !== 'engine') return next(e)
    const ran = await next(e)
    // A refused call, or one the person interrupted (its result is thrown away), carries
    // nothing: the reactions wait for the next call.
    if (ran.deny !== undefined || next.signal.aborted) return ran
    const taken = await takePending($)
    if (taken.length === 0) return ran
    return { ...ran, context: [...(ran.context ?? []), told(taken, true)] }
  }).catch(($, e, next) => {
    fail($, 'tool.call', next.error)
    return next(e)
  })

  // Between turns: the reactions go beside the person's next message.
  on('prompt.submit', async ($, e, next) => {
    if (!isPerson(e.origin)) return next(e)
    await load($)
    const key = textKey(e.text)
    const idle = e.turnId === undefined
    // The text's key names this message from now on; an earlier one with the same text
    // keeps what it shows under its own row.
    await update($, rowOf, map => without(map, key))
    await update($, memberOf(note, { requestId: key }), () => null)
    await update($, unread, list =>
      [...list.filter(one => one.key !== key), { key, text: norm(e.text).slice(0, 200), idle }].slice(-10),
    )
    // Typed while Claude works, the message waits in the queue: the reactions ride on
    // Claude's next tool result instead, which comes sooner.
    const taken = idle ? await takePending($) : []
    const ran = await next(taken.length ? { ...e, context: [...(e.context ?? []), told(taken, false)] } : e)
    if (ran.drop !== undefined || next.signal.aborted) {
      await update($, unread, list => list.filter(one => one.key !== key))
      await giveBack($, taken)
    }
    return ran
    // A failure here must never hold the person's message back: it goes on without the note.
  }).catch(($, e, next) => {
    fail($, 'prompt.submit', next.error)
    return next(e)
  })

  // A turn reads the messages the person sent while Claude was idle: each gets 👀.
  on('turn.start', async ($, e, next) => {
    await load($)
    await update($, running, () => e.turnId)
    const key = textKey(e.text)
    let taken = [] as Unread[]
    await update($, unread, list => {
      taken = list.filter(one => one.idle || one.key === key)
      return list.filter(one => !taken.includes(one))
    })
    if (taken.length) {
      await update($, turnRead, map => keepLast({ ...map, [e.turnId]: taken.map(one => one.key) }, 20))
      await update($, last, () => taken[taken.length - 1]?.key ?? null)
      for (const one of taken) await setNote($, one.key, current => ({ ...current, mark: '👀' }))
    }
    return next(e)
  }).catch(($, e, next) => {
    fail($, 'turn.start', next.error)
    return next(e)
  })

  // The turn ended: every message it read gets ✅, or ⏹️ when it was stopped, ⚠️ on an error.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const keys = (await read($, turnRead))[e.turnId] ?? []
    const mark = e.reason === 'answer' ? '✅' : e.reason === 'aborted' ? '⏹️' : '⚠️'
    for (const key of keys) await setNote($, key, current => ({ ...current, mark }))
    await update($, turnRead, map => without(map, e.turnId))
    await update($, running, current => (current === e.turnId ? null : current))
    return next(e)
  }).catch(($, e, next) => {
    fail($, 'turn.complete', next.error)
    return next(e)
  })

  // Where the person's messages are stored: a prompt's row, and the row of a message
  // typed mid-turn once Claude has read it.
  on('session.append', async ($, e, next) => {
    const kept = await next(e)
    if (kept.deny !== undefined || e.agentId !== undefined) return kept
    const content = e.message.content as readonly Block[]
    if (e.door === 'prompt' && e.message.type === 'user' && isPerson(e.origin)) {
      await stored($, e.uuid, textOf(content)[0] ?? '')
    } else if (e.message.type === 'attachment' && e.message.name === 'queued_command') {
      await absorbed($, e.uuid, textOf(content).join(' '))
    }
    return kept
  }).catch(($, e, next) => {
    fail($, 'session.append', next.error)
    return next(e)
  })

  // The person's messages: Claude's reaction and the turn's mark on the bubble's last line.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (!isPerson(e.props.origin) || !e.props.text.trim()) return next(e)
    const view = (await read($, memberOf(note, e))) ?? (await read($, memberOf(note, { requestId: textKey(e.props.text) })))
    const sparks = view?.mine && view.frame !== undefined ? (TEXT_SPARKS[view.frame] ?? '') : ''
    const line = [view?.mine ? `${view.mine}${sparks}` : '', view?.mark ?? ''].filter(Boolean).join('  ')
    if (!line) return next(e)
    return next({ ...e, props: { ...e.props, text: `${e.props.text}\n${line}` } })
  })

  // Claude's messages, the ones between tool calls included: the app draws the message
  // itself; the reaction picked sits under it, ☺ in its bottom right corner, and the row of
  // reactions opens beside ☺ on hover or once ☺ is pressed. All of it stays inside the
  // message's own box, painted over it, so nothing moves and nothing is cut off.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const own = await next(e)
    // A summary of what Claude wrote between tool calls, and a block with no text, stay
    // as the app draws them.
    if (e.props.isSummary || !e.props.text.trim()) return own
    const id = e.requestId
    const view = await read($, memberOf(bubble, e))
    const given = view?.given
    const message = { id, preview: preview(e.props.text) }
    const cells = given && view.frame !== undefined ? (SPARKS[view.frame] ?? []) : []
    const { Box, Button, Text } = $.ui.resolve(e)
    // On the desktop the open row is a small card over the text; the terminal draws no card.
    const card = e.surface === 'desktop' ? ({ paddingX: 1, borderStyle: 'round', borderColor: 'subtle', backgroundColor: 'inverseText' } as const) : {}
    return (
      <Box key={`reactions-${id}`} flexDirection="column">
        {own}
        {given && (
          <Box flexDirection="row">
            <Button key={`chosen-${id}`} label={given} plain onPress={() => choose($, message, given)} />
            {cells.map(([glyph, color], index) => (
              <Text key={`spark-${id}-${index}`} color={color || undefined} bold>
                {glyph}
              </Text>
            ))}
          </Box>
        )}
        <Box position="absolute" bottom={0} right={0} flexDirection="row" alignItems="center" gap={1}>
          {/* Pressed open it is simply shown; closed, the pointer on the message reveals it. */}
          <Box
            display={view?.open ? 'flex' : 'none'}
            {...(view?.open ? {} : { hover: { display: 'flex' } as const })}
            flexDirection="row"
            gap={1}
            {...card}
          >
            {EMOJIS.map(emoji => (
              <Button key={`pick-${id}-${emoji}`} label={emoji} plain onPress={() => choose($, message, emoji)} />
            ))}
          </Box>
          <Button key={`open-${id}`} label="☺" plain dimColor onPress={() => toggle($, id)} />
        </Box>
      </Box>
    )
  })
}
