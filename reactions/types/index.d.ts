// What one of Claude's messages shows: the person's reaction on it, whether its row of
// reactions is open (pressed open, not only shown on hover) and the frame of the burst of
// pixel sparks running around a reaction just set.
export type Bubble = { given?: string; open?: true; frame?: number }

// What one of the person's messages shows: the turn's mark (read, then done, stopped or failed),
// Claude's own reaction, and the frame of its burst.
export type Note = { mark?: string; mine?: string; frame?: number }

// A reaction the person gave that Claude has not been told about yet: the message it is
// on and a short preview of that message for the note Claude reads.
export type Pending = { id: string; emoji: string; preview: string }

// A message the person sent that Claude has not read yet: its key (see `textKey`), the
// head of its text to find it by, and whether it came while no turn ran.
export type Unread = { key: string; text: string; idle: boolean }

// What a chat keeps across restarts of the app, in the mod's own store.
export type Saved = {
  given: Record<string, string>
  notes: Record<string, { mark?: string; mine?: string }>
  pending: Pending[]
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    reactions: {
      // One member per message drawn, so a change redraws that message alone.
      bubble: StateFamily<Bubble | null>
      note: StateFamily<Note | null>
      // Bookkeeping no drawing reads.
      pending: Pending[]
      saved: Saved
      unread: Unread[]
      turnRead: Record<string, string[]>
      rowOf: Record<string, string>
      last: string | null
      openId: string | null
      running: string | null
      loaded: string | null
    }
  }
}
