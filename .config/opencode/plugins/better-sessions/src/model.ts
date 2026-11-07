// Pure triage rules. Kept free of Solid and OpenCode imports so they are easy to test.

export type Tab = "active" | "settled" | "snoozed"

export const TABS: readonly Tab[] = ["active", "settled", "snoozed"]

export const TAB_LABEL: Record<Tab, string> = {
  active: "Active",
  settled: "Settled",
  snoozed: "Snoozed",
}

/** What the user decided about a root session. Absent means "follow the defaults". */
export type Entry =
  /** Explicitly settled. Stays settled until restored or the user sends a message. */
  | { readonly state: "settled"; readonly at: number }
  /** Explicitly restored, or woken from a snooze. Counts as activity for auto-settle. */
  | { readonly state: "active"; readonly at: number; readonly woke?: number }
  /**
   * Snoozed until `until`. `permissions` and `forms` are the requests already pending when the snooze
   * started: snoozing an existing question means "ask me later", so only new ones wake it early.
   */
  | {
      readonly state: "snoozed"
      readonly at: number
      readonly until: number
      readonly forms?: readonly string[]
      readonly permissions?: readonly string[]
    }

export type Attention = "permission" | "question" | false

/** Live signals for a session family (the root and every descendant). */
export interface Signals {
  readonly attention: Attention
  /**
   * Fully busy: running, a queued prompt, a running background job (shell, subagent, image) or a
   * running shell. OpenCode's own session list only checks `running`.
   */
  readonly working: boolean
  readonly permissionIDs: readonly string[]
  readonly formIDs: readonly string[]
}

export interface SessionLike {
  readonly id: string
  readonly outcome?: "succeeded" | "failed" | "interrupted"
  readonly time: {
    readonly created: number
    readonly updated: number
    readonly busy?: number
    readonly idle?: number
  }
}

export interface Placement {
  readonly tab: Tab
  /** Settled by inactivity rather than by the user. */
  readonly auto?: boolean
  /** The snooze ended (timer or an early wake) and the user has not looked yet. */
  readonly woke?: boolean
  /** Snoozed sessions: when they wake. */
  readonly until?: number
}

const DAY_MS = 24 * 60 * 60 * 1_000

/**
 * Only a request for the user or a fresh failure ends a snooze early (t3code's
 * `threadRaisedHandWhileSnoozed`). Completed runs never do: a snoozed long-running session keeps
 * working in the background and stays hidden until its timer.
 */
export function raisedHandWhileSnoozed(
  entry: Extract<Entry, { state: "snoozed" }>,
  session: SessionLike,
  signals: Signals,
): boolean {
  // Pending approvals block the agent, so any approval wakes the session.
  if (signals.permissionIDs.length > 0) return true
  // Snoozing an existing question means "ask me later". Only a new question wakes it early.
  const known = new Set(entry.forms ?? [])
  if (signals.formIDs.some((id) => !known.has(id))) return true
  // A failure after the snooze started wakes it.
  if (session.outcome === "failed") {
    const failedAt = session.time.idle ?? session.time.updated
    if (failedAt > entry.at) return true
  }
  return false
}

export function effectiveSnoozed(
  entry: Entry | undefined,
  session: SessionLike,
  signals: Signals,
  now: number,
): entry is Extract<Entry, { state: "snoozed" }> {
  if (entry?.state !== "snoozed") return false
  if (!Number.isFinite(entry.until) || entry.until <= now) return false
  return !raisedHandWhileSnoozed(entry, session, signals)
}

/** The most recent moment the session or the user did something with it. */
export function activityAt(session: SessionLike, entry: Entry | undefined, now: number) {
  const times = [session.time.created, session.time.updated, session.time.busy ?? 0, session.time.idle ?? 0]
  if (entry?.state === "active") times.push(entry.at, entry.woke ?? 0)
  // A snooze that ended counts as activity at its wake time, so it does not settle right away.
  if (entry?.state === "snoozed") times.push(entry.until <= now ? entry.until : entry.at)
  return Math.max(...times)
}

export function place(input: {
  readonly session: SessionLike
  readonly entry: Entry | undefined
  readonly signals: Signals
  readonly now: number
  /** Days without activity before a session settles by itself. `null` disables it. */
  readonly autoSettleAfterDays: number | null
}): Placement {
  const { session, entry, signals, now } = input
  if (entry?.state === "snoozed") {
    if (effectiveSnoozed(entry, session, signals, now)) return { tab: "snoozed", until: entry.until }
    // Expired or woken early: back to Active, flagged until the user looks at it.
    return { tab: "active", woke: true }
  }
  if (entry?.state === "settled") return { tab: "settled" }
  // Sessions that need the user or are still working never settle by themselves.
  if (signals.attention || signals.working) return { tab: "active", woke: entry?.state === "active" && !!entry.woke }
  const days = input.autoSettleAfterDays
  if (days !== null && days > 0 && activityAt(session, entry, now) < now - days * DAY_MS)
    return { tab: "settled", auto: true }
  return { tab: "active", woke: entry?.state === "active" && !!entry.woke }
}

/**
 * Running sessions cannot be settled: one that is still working (the spinner) belongs in Active until it is
 * completely done. Sessions waiting on the user (`!`/`?`) can be settled.
 */
export function settleBlocker(signals: Signals): string | undefined {
  if (signals.working && !signals.attention) return "This session is still running. Settle it once it finishes"
  return undefined
}

/** t3code's `canSnooze`: pending approvals and queued prompts would wake the session at once. */
export function snoozeBlocker(signals: Signals): string | undefined {
  if (signals.permissionIDs.length > 0) return "Answer the pending permission request before snoozing this session"
  return undefined
}

/**
 * Active tab order: sessions waiting on the user first, then finished ones, then the ones still
 * working. Each group is most recent first.
 */
export function activeRank(signals: Signals) {
  if (signals.attention) return 0
  if (!signals.working) return 1
  return 2
}

export function compareActive(
  left: { session: SessionLike; signals: Signals },
  right: { session: SessionLike; signals: Signals },
) {
  return (
    activeRank(left.signals) - activeRank(right.signals) ||
    right.session.time.updated - left.session.time.updated ||
    right.session.time.created - left.session.time.created
  )
}

/** Settled order: most recently updated first, like OpenCode's session list. */
export function compareUpdated(left: { session: SessionLike }, right: { session: SessionLike }) {
  return right.session.time.updated - left.session.time.updated || right.session.time.created - left.session.time.created
}

/** Snoozed order: soonest wake first, like t3code's snoozed section. */
export function compareSnoozed(
  left: { session: SessionLike; until?: number },
  right: { session: SessionLike; until?: number },
) {
  return (left.until ?? Infinity) - (right.until ?? Infinity) || compareUpdated(left, right)
}

/** Category label for the settled tab, the same day buckets as OpenCode's session list. */
export function dayCategory(time: number, now: number) {
  const date = new Date(time).toDateString()
  return date === new Date(now).toDateString() ? "Today" : date
}

/** Category label for the snoozed tab: the day the session wakes. */
export function wakeCategory(until: number, now: number) {
  const date = new Date(until)
  const today = new Date(now)
  if (date.toDateString() === today.toDateString()) return "Wakes today"
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  if (date.toDateString() === tomorrow.toDateString()) return "Wakes tomorrow"
  return `Wakes ${date.toDateString()}`
}
