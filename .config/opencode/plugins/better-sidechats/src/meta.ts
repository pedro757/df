// The sidechat marker lives in the session's metadata, so the TUI part, the server part and any other client agree on
// which sessions are sidechats without a separate index.

export const KEY = "sidechat"

type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

export interface Sidechat {
  /** The main session the sidechat belongs to. Sidechats never nest: one asked from a sidechat joins the same main session. */
  readonly parentID: string
  /**
   * The sidechat's own ID. Forks and subagents copy their source's metadata, so a copy whose ID differs is not a
   * sidechat: forking a sidechat with /fork gives a regular session.
   */
  readonly sessionID: string
  /** The session it was forked from: the main session, or the sidechat it was asked from. */
  readonly from: string
  /** The newest message the fork copied. Every later message is the sidechat's own. */
  readonly base?: string
  readonly created: number
  /** Set while the sidechat has no title of its own yet; its first message names it. */
  readonly untitled?: boolean
  /** When it was last brought back to the main session. */
  readonly broughtBack?: number
}

interface SessionLike {
  readonly id: string
  readonly metadata?: { readonly [key: string]: unknown } | undefined
}

export function sidechatOf(session: SessionLike | undefined): Sidechat | undefined {
  if (!session) return
  const value = session.metadata?.[KEY]
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const record = value as Record<string, unknown>
  if (typeof record.parentID !== "string" || !record.parentID) return
  if (record.sessionID !== session.id) return
  return {
    parentID: record.parentID,
    sessionID: session.id,
    from: typeof record.from === "string" && record.from ? record.from : record.parentID,
    base: typeof record.base === "string" && record.base ? record.base : undefined,
    created: typeof record.created === "number" ? record.created : 0,
    untitled: record.untitled === true ? true : undefined,
    broughtBack: typeof record.broughtBack === "number" ? record.broughtBack : undefined,
  }
}

/** The session's metadata with the sidechat marker set, or removed when `sidechat` is undefined. Other keys are kept. */
export function withSidechat(
  metadata: { readonly [key: string]: unknown } | undefined,
  sidechat: Sidechat | undefined,
): { [key: string]: Json } {
  const next = { ...(metadata ?? {}) } as { [key: string]: Json }
  if (!sidechat) {
    delete next[KEY]
    return next
  }
  const marker: { [key: string]: Json } = {
    parentID: sidechat.parentID,
    sessionID: sidechat.sessionID,
    from: sidechat.from,
    created: sidechat.created,
  }
  if (sidechat.base) marker.base = sidechat.base
  if (sidechat.untitled) marker.untitled = true
  if (sidechat.broughtBack !== undefined) marker.broughtBack = sidechat.broughtBack
  next[KEY] = marker
  return next
}

/** A one-line title from a message: whitespace collapsed, cut at `max` characters. */
export function titleFrom(text: string, max = 60): string {
  const line = text.replace(/\s+/g, " ").trim()
  if (line.length <= max) return line
  return `${line.slice(0, max - 1).trimEnd()}…`
}

export const DEFAULT_TITLE = "Sidechat"

/** Whether a permission action matches one of the configured patterns (`*` and `?` wildcards, whole value). */
export function matchesAction(action: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern === "*") return true
    const source = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")
    return new RegExp(`^${source}$`).test(action)
  })
}

/**
 * What the model is told about the side conversation, as a session instruction entry on the sidechat. OpenCode's own
 * fork notice already says the history is copied and the original keeps going.
 */
export function sidechatInstructions(parentTitle: string | undefined): string {
  const parent = parentTitle ? `"${parentTitle}"` : "the main session"
  return [
    `This session is a sidechat of ${parent}: a side conversation the user opened to ask about that session or try something without adding to it.`,
    "Answer the user's messages here, and don't carry on that session's task unless they ask.",
    "Every file edit in a sidechat needs the user's approval.",
  ].join(" ")
}
