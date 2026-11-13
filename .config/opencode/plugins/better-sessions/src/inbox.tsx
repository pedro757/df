import type { JobInfo, SessionInfo } from "@opencode/client"
import type { Context } from "@opencode/plugin/tui/context"
import { createMemo, createSignal, onCleanup, untrack } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { readHostPins, type Options } from "./config"
import {
  engagedBy,
  place,
  settleBlocker,
  snoozeBlocker,
  type Entry,
  type Placement,
  type Signals,
} from "./model"
import { errorMessage, sessionTitle } from "./util"

interface PersistedState {
  version: 1
  /** Per root session decisions. */
  sessions: Record<string, Entry>
  /** Pinned root sessions, in pin order. The first nine are the quick switch slots. */
  pins: string[]
  /** Pins were copied from the built-in session list. */
  seeded: boolean
  /** The list shows every project's sessions. Unset until toggled here: the built-in list's choice applies. */
  allProjects?: boolean
}

const JOB_POLL_MS = 4_000
const UNDELIVERED_JOB_GRACE_MS = 2 * 60 * 1_000
const SWEEP_MS = 15_000
/** Wake toasts are skipped for snoozes that ended long before the TUI noticed (it was closed). */
const WAKE_TOAST_WINDOW_MS = 10 * 60 * 1_000

export type Inbox = ReturnType<typeof createInbox>

export function createInbox(context: Context, options: Options) {
  const data = context.data
  const [state, update] = context.storage.store<PersistedState>("state", {
    initial: { version: 1, sessions: {}, pins: [], seeded: false },
  })

  const write = (mutation: (draft: PersistedState) => void) =>
    update((draft) => {
      draft.sessions ??= {}
      draft.pins ??= []
      mutation(draft)
    }).catch((error) =>
      context.ui.toast.show({
        message: `Failed to save session inbox: ${errorMessage(error)}`,
        variant: "error",
        duration: 5000,
      }),
    )

  if (!state.seeded) {
    const pins = readHostPins()
    void write((draft) => {
      if (draft.seeded) return
      draft.seeded = true
      if (draft.pins.length === 0) draft.pins = pins
    })
  }

  const [now, setNow] = createSignal(Date.now())
  /** The current time. Reading it subscribes to the sweep tick, so time-based views refresh on their own. */
  const clock = () => {
    now()
    return Date.now()
  }

  // Background jobs (shells, subagents, images) have no events, so they are polled while someone
  // is looking, and refreshed right away when shells start or end.
  const [jobs, setJobs] = createStore<{ list: JobInfo[] }>({ list: [] })
  let watchers = 0
  let jobTimer: ReturnType<typeof setInterval> | undefined
  let jobRequest: Promise<void> | undefined
  const refreshJobs = () => {
    if (jobRequest) return jobRequest
    jobRequest = context.client.experimental.job
      .list({})
      .then((list) => {
        setJobs("list", reconcile(Array.isArray(list) ? list : [], { key: "id" }))
        // Jobs can belong to sessions this TUI has not loaded; load them so roots resolve.
        for (const job of list) {
          for (const id of [job.sessionID, job.kind === "subagent" ? job.childSessionID : undefined]) {
            if (id && !data.session.get(id)) void data.session.sync(id).catch(() => {})
          }
        }
      })
      .catch(() => {})
      .finally(() => {
        jobRequest = undefined
      })
    return jobRequest
  }

  /** Called by the dialog while it is open: loads what the live signals need and keeps it fresh. */
  function watch() {
    watchers++
    if (watchers === 1) {
      void refreshJobs()
      jobTimer = setInterval(() => void refreshJobs(), JOB_POLL_MS)
    }
    void prime()
    return () => {
      watchers--
      if (watchers > 0) return
      clearInterval(jobTimer)
      jobTimer = undefined
    }
  }

  // Questions and permission requests arrive by event, but ones asked before this TUI started are
  // only known after a sync. A pending request blocks its run, so only running sessions can have one.
  const primed = new Set<string>()
  async function prime() {
    const active = await context.client.session.active().catch(() => ({}) as Record<string, unknown>)
    const ids = Object.keys(active)
    await Promise.allSettled(
      ids.map(async (id) => {
        if (!data.session.get(id)) await data.session.sync(id).catch(() => {})
        if (primed.has(id)) return
        primed.add(id)
        await Promise.allSettled([
          data.session.permission.sync(id),
          data.session.form.sync(id),
          data.session.pending.sync(id),
        ])
      }),
    )
  }

  const shellSessions = createMemo(() => {
    // Running shells reported by events, for every location the TUI has seen.
    const result = new Set<string>()
    const locations = new Map<string, { directory: string }>()
    for (const session of data.session.list()) locations.set(session.location.directory, session.location)
    for (const location of locations.values()) {
      for (const shell of data.shell.list(location)) {
        const sessionID = shell.metadata?.sessionID
        if (shell.status === "running" && typeof sessionID === "string") result.add(sessionID)
      }
    }
    return result
  })

  const jobSessions = createMemo(() => {
    const result = new Set<string>()
    const time = clock()
    for (const job of jobs.list) {
      // Finished jobs stay listed until their result is delivered, which wakes the session again. The
      // grace window keeps an undelivered leftover from holding a session in "working" forever.
      if (job.status !== "running" && time - (job.time.completed ?? job.time.started) > UNDELIVERED_JOB_GRACE_MS)
        continue
      result.add(job.sessionID)
      if (job.kind === "subagent") result.add(job.childSessionID)
    }
    return result
  })

  const rootOf = (id: string) => data.session.root(id)

  /** Every known member of a session family, root included. */
  function members(root: string) {
    const family = data.session.family(root)
    const result = new Set(family)
    result.add(root)
    // Jobs and shells can name sessions whose family is not indexed yet.
    for (const id of jobSessions()) if (rootOf(id) === root) result.add(id)
    for (const id of shellSessions()) if (rootOf(id) === root) result.add(id)
    return [...result]
  }

  function signals(root: string): Signals {
    const ids = members(root)
    const permissionIDs: string[] = []
    const formIDs: string[] = []
    let working = false
    for (const id of ids) {
      for (const request of data.session.permission.list(id) ?? []) permissionIDs.push(request.id)
      for (const form of data.session.form.list(id) ?? []) formIDs.push(form.id)
      if (working) continue
      working =
        data.session.status(id) === "running" ||
        // Parked synthetic context (user shells, plan reminders) stays pending without execution.
        data.session.pending.list(id).some((item) => item.type !== "synthetic") ||
        jobSessions().has(id) ||
        shellSessions().has(id)
    }
    return {
      attention: permissionIDs.length > 0 ? "permission" : formIDs.length > 0 ? "question" : false,
      working,
      permissionIDs,
      formIDs,
    }
  }

  function placement(session: SessionInfo, at = clock()): Placement {
    return place({
      session,
      entry: state.sessions?.[session.id],
      signals: signals(session.id),
      now: at,
      autoSettleAfterDays: options.autoSettleAfterDays,
    })
  }

  function entry(id: string) {
    return state.sessions?.[id]
  }

  /** Returns an error message when the session cannot be settled right now. */
  function settle(id: string): string | undefined {
    const blocker = settleBlocker(signals(id))
    if (blocker) return blocker
    setNow(Date.now())
    void write((draft) => {
      draft.sessions[id] = { state: "settled", at: Date.now() }
    })
    return undefined
  }

  function canSettle(id: string) {
    return settleBlocker(signals(id))
  }

  function restore(id: string) {
    setNow(Date.now())
    return write((draft) => {
      draft.sessions[id] = { state: "active", at: Date.now() }
    })
  }

  /** Returns an error message when the session cannot be snoozed right now. */
  function snooze(id: string, until: number): string | undefined {
    const live = signals(id)
    const blocker = snoozeBlocker(live)
    if (blocker) return blocker
    if (!(until > Date.now())) return "Pick a time in the future"
    setNow(Date.now())
    void write((draft) => {
      draft.sessions[id] = {
        state: "snoozed",
        at: Date.now(),
        until,
        forms: live.formIDs,
        permissions: live.permissionIDs,
      }
    })
    return undefined
  }

  function canSnooze(id: string) {
    return snoozeBlocker(signals(id))
  }

  /** Clears the woke flag once the user looks at the session. */
  function visit(id: string) {
    const current = state.sessions?.[id]
    if (!current) return
    const time = Date.now()
    if (current.state === "active" && current.woke) {
      void write((draft) => {
        const value = draft.sessions[id]
        if (value?.state === "active") draft.sessions[id] = { state: "active", at: value.at }
      })
      return
    }
    if (current.state === "snoozed" && current.until <= time) {
      void write((draft) => {
        const value = draft.sessions[id]
        if (value?.state === "snoozed" && value.until <= time) draft.sessions[id] = { state: "active", at: value.until }
      })
    }
  }

  /**
   * The user acted on the session (a message, `/compact`, a `!` command): it is being worked on again, whatever its
   * tab was. The entry records that moment, so a session that settled by itself after days of inactivity comes back
   * too, even when the action does not touch the session's own timestamps.
   */
  function engage(id: string) {
    const current = state.sessions?.[id]
    const session = data.session.get(id)
    // Already in Active with no marker: nothing to record.
    if (session ? placement(session).tab === "active" && !(current?.state === "active" && current.woke) : !current)
      return
    setNow(Date.now())
    void write((draft) => {
      draft.sessions[id] = { state: "active", at: Date.now() }
    })
  }

  function forget(id: string) {
    if (!state.sessions?.[id] && !state.pins?.includes(id)) return
    void write((draft) => {
      delete draft.sessions[id]
      draft.pins = draft.pins.filter((pin) => pin !== id)
    })
  }

  function setAllProjects(value: boolean) {
    return write((draft) => {
      draft.allProjects = value
    })
  }

  const pins = () => state.pins ?? []
  function isPinned(id: string) {
    return pins().includes(id)
  }
  function togglePin(id: string) {
    return write((draft) => {
      draft.pins = draft.pins.includes(id) ? draft.pins.filter((pin) => pin !== id) : [...draft.pins, id]
    })
  }

  /** The first nine pinned root sessions this TUI knows, like the built-in quick switch slots. */
  const slots = createMemo(() => {
    const existing = new Set(
      data.session
        .list()
        .filter((session) => session.parentID === undefined)
        .map((session) => session.id),
    )
    return pins()
      .filter((id) => existing.has(id))
      .slice(0, 9)
  })

  function quickSwitch(slot: number) {
    const target = slots()[slot - 1]
    if (!target) return
    const route = context.ui.router.current()
    if (route.type === "session" && route.sessionID === target) return
    context.ui.router.navigate({ type: "session", sessionID: target })
  }

  const viewingRoot = () => {
    const route = context.ui.router.current()
    return route.type === "session" ? rootOf(route.sessionID) : undefined
  }

  // Snooze timers: move ended snoozes back to Active with a woke flag, and say so.
  const toasted = new Set<string>()
  function sweep(initial = false) {
    const time = Date.now()
    setNow(time)
    const ended = Object.entries(state.sessions ?? {}).filter(
      (item): item is [string, Extract<Entry, { state: "snoozed" }>] =>
        item[1].state === "snoozed" && item[1].until <= time,
    )
    if (ended.length === 0) return
    const viewing = viewingRoot()
    void write((draft) => {
      for (const [id] of ended) {
        const value = draft.sessions[id]
        if (value?.state !== "snoozed" || value.until > time) continue
        // Someone already looking at the session needs no "woke" marker.
        draft.sessions[id] =
          id === viewing ? { state: "active", at: value.until } : { state: "active", at: value.until, woke: value.until }
      }
    })
    if (!options.notifyOnWake) return
    for (const [id, value] of ended) {
      const key = `${id}:${value.until}`
      if (toasted.has(key)) continue
      toasted.add(key)
      if (initial && time - value.until > WAKE_TOAST_WINDOW_MS) continue
      const session = data.session.get(id)
      context.ui.toast.show({
        title: session ? sessionTitle(session) : undefined,
        message: "Snooze ended. The session is back in Active",
        variant: "info",
        sessionID: id,
      })
    }
  }

  const disposers: Array<() => void> = []
  disposers.push(
    data.on("session.inbox.enqueued", (event) => {
      // Only input for the tracked root itself counts: subagent prompts are user items on children.
      const id = event.data.sessionID
      if (engagedBy(event.data.item.type, data.session.status(id) === "running")) engage(id)
    }),
    data.on("session.deleted", (event) => forget(event.data.sessionID)),
    data.on("session.shell.started", (event) => {
      // Only the user's own `!` commands publish this; the agent's shell tool runs as a background job.
      engage(event.data.sessionID)
      if (watchers > 0) void refreshJobs()
    }),
    data.on("session.shell.ended", () => watchers > 0 && void refreshJobs()),
    data.on("session.execution.succeeded", () => watchers > 0 && void refreshJobs()),
    data.on("session.execution.started", () => watchers > 0 && void refreshJobs()),
  )
  // Load pinned sessions so quick switch slots resolve before the list is first opened.
  for (const id of untrack(pins)) if (!data.session.get(id)) void data.session.sync(id).catch(() => {})
  sweep(true)
  const sweeper = setInterval(() => sweep(), SWEEP_MS)
  onCleanup(() => {
    clearInterval(sweeper)
    clearInterval(jobTimer)
    disposers.forEach((dispose) => dispose())
  })

  return {
    state,
    clock,
    tick: () => setNow(Date.now()),
    watch,
    signals,
    placement,
    entry,
    settle,
    canSettle,
    restore,
    snooze,
    canSnooze,
    visit,
    forget,
    pins,
    isPinned,
    togglePin,
    setAllProjects,
    slots,
    quickSwitch,
  }
}
