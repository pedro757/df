import { Plugin } from "@opencode/plugin"
import { spawn, spawnSync } from "node:child_process"
import { basename } from "node:path"

const sounds = {
  permission: "dialog-warning",
  question: "dialog-question",
  done: "complete",
  error: "dialog-error",
}

// "Finished" follows the session-inbox plugin (plugins/session-inbox/src/inbox.tsx): a session is still working
// while any of these is true for it or any of its subagents:
// - it is running,
// - a prompt is queued (an undelivered inbox item that is not parked synthetic context),
// - a background job (shell, subagent, image) is running, or finished less than 2 minutes ago and its result has
//   not been delivered yet,
// - a shell it started is still running.
// session-inbox polls the job list from the TUI. A server plugin has no job list, so the same signals are rebuilt
// from the event stream: background job results arrive as synthetic inbox items with a `jobID` or `childID`.

/** A finished run waits this long for follow-up work (a job result, a queued prompt) before it alerts. */
const SETTLE_MS = 1_500
/** session-inbox's grace window: an undelivered job result stops holding its session in "working" after this. */
const UNDELIVERED_JOB_GRACE_MS = 2 * 60 * 1_000
/** Jobs known only from their tool result (images) stop counting after this, in case their result is missed. */
const UNTRACKED_JOB_LIMIT_MS = 30 * 60 * 1_000
const HANDLED_EVENT_TTL_MS = 5 * 60 * 1_000

const EVENT_TYPES = [
  "permission.asked",
  "session.created",
  "session.deleted",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.inbox.enqueued",
  "session.inbox.delivered",
  "session.inbox.cancelled",
  "session.shell.started",
  "session.shell.ended",
  "session.tool.success",
  "shell.created",
  "shell.exited",
  "shell.deleted",
]

const seen = (globalThis[Symbol.for("pedro.opencode-notifier.seen")] ??= new Set())

function firstDelivery(id) {
  if (seen.has(id)) return false
  seen.add(id)

  const timer = setTimeout(() => seen.delete(id), 60_000)
  timer.unref()
  return true
}

function openCodeIsFocused() {
  const result = spawnSync("hyprctl", ["-j", "activewindow"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  })
  if (result.status !== 0) return false

  try {
    const window = JSON.parse(result.stdout)
    return /opencode/i.test(window.title ?? "")
  } catch {
    return false
  }
}

function alert(id, event, message, directory) {
  if (!firstDelivery(id)) return
  if (openCodeIsFocused()) return

  const project = directory && directory !== "/" ? ` (${basename(directory)})` : ""
  const notification = spawn(
    "notify-send",
    ["--app-name=OpenCode", "--expire-time=5000", `OpenCode${project}`, message],
    { stdio: "ignore" },
  )
  notification.unref()

  const sound = spawn("canberra-gtk-play", ["--id", sounds[event]], { stdio: "ignore" })
  sound.unref()
}

/** A synthetic inbox item carrying a background job's result. Other synthetic items are parked context. */
function isJobResult(metadata) {
  return typeof metadata?.jobID === "string" || (metadata?.source === "subagent" && typeof metadata.childID === "string")
}

function createTracker() {
  /** Live plugin contexts, used to look up sessions created before the tracker started. */
  const contexts = new Set()
  /** Every plugin instance receives every event; each is handled once. */
  const handled = new Map()
  /** Parent of each known session, null for root sessions. */
  const parents = new Map()
  const lookups = new Map()
  /** Sessions whose agent loop is running. */
  const running = new Set()
  /** Undelivered inbox items that mean more work, by session: inbox ID -> when it stops counting. */
  const pending = new Map()
  /** Running shells: shell ID -> session ID. */
  const shells = new Map()
  /** Background jobs only known from their tool result (images): job ID -> { sessionID, until }. */
  const jobs = new Map()
  /** Job IDs whose result already arrived, so a late tool result does not register them again. */
  const resolvedJobs = new Map()
  /** Root sessions whose run ended, waiting for the whole family to finish: session ID -> alert. */
  const finished = new Map()
  const timers = new Map()

  /** The root of a session when its whole ancestry is known. */
  function rootOf(sessionID) {
    const visited = new Set()
    let current = sessionID
    while (!visited.has(current)) {
      visited.add(current)
      const parent = parents.get(current)
      if (parent === undefined) return undefined
      if (parent === null) return current
      current = parent
    }
    return current
  }

  function lookupParent(sessionID) {
    let lookup = lookups.get(sessionID)
    if (lookup) return lookup
    const ctx = contexts.values().next().value
    if (!ctx) return Promise.resolve(null)
    lookup = ctx.session
      .get({ sessionID })
      .then(
        (info) => {
          const parent = info?.parentID ?? null
          parents.set(sessionID, parent)
          return parent
        },
        // Not cached: a failed lookup is retried next time.
        () => null,
      )
      .finally(() => lookups.delete(sessionID))
    lookups.set(sessionID, lookup)
    return lookup
  }

  async function resolveRoot(sessionID) {
    const visited = new Set()
    let current = sessionID
    while (!visited.has(current)) {
      visited.add(current)
      const parent = parents.has(current) ? parents.get(current) : await lookupParent(current)
      if (!parent) return current
      current = parent
    }
    return current
  }

  /** Whether a root session's family is still working, and when its time-limited signals expire. */
  async function activity(root, now) {
    const ids = new Set(running)
    for (const id of pending.keys()) ids.add(id)
    for (const id of shells.values()) ids.add(id)
    for (const job of jobs.values()) ids.add(job.sessionID)

    const family = new Set()
    for (const id of ids) if ((await resolveRoot(id)) === root) family.add(id)

    let working = false
    let until = Infinity
    const counts = (expires) => {
      if (expires <= now) return
      working = true
      until = Math.min(until, expires)
    }
    for (const id of family) {
      if (running.has(id)) working = true
      for (const expires of pending.get(id)?.values() ?? []) counts(expires)
    }
    for (const id of shells.values()) if (family.has(id)) working = true
    for (const job of jobs.values()) if (family.has(job.sessionID)) counts(job.until)
    return { working, until }
  }

  function schedule(sessionID, delay = SETTLE_MS) {
    if (!finished.has(sessionID)) return
    clearTimeout(timers.get(sessionID))
    const timer = setTimeout(() => {
      check(sessionID).catch((error) => console.error("opencode-notifier check failed", error))
    }, Math.max(delay, SETTLE_MS))
    timer.unref()
    timers.set(sessionID, timer)
  }

  function cancel(sessionID) {
    finished.delete(sessionID)
    clearTimeout(timers.get(sessionID))
    timers.delete(sessionID)
  }

  /** Something in this session's family ended: re-check its root if it is waiting to alert. */
  function touch(sessionID) {
    if (!sessionID || finished.size === 0) return
    const root = rootOf(sessionID)
    if (root !== undefined) return schedule(root)
    void resolveRoot(sessionID).then((resolved) => schedule(resolved))
  }

  async function check(sessionID) {
    timers.delete(sessionID)
    const finish = finished.get(sessionID)
    if (!finish) return
    const root = await resolveRoot(sessionID)
    if (finished.get(sessionID) !== finish) return
    if (root !== sessionID) {
      // A subagent whose parent was not known yet: only its root alerts.
      cancel(sessionID)
      return schedule(root)
    }
    const now = Date.now()
    const { working, until } = await activity(root, now)
    if (finished.get(root) !== finish) return
    if (working) {
      // Events re-check when work ends. Time-limited signals (undelivered results) expire on their own.
      if (until !== Infinity) schedule(root, until - now)
      return
    }
    finished.delete(root)
    alert(finish.id, finish.kind, finish.kind === "error" ? "Session encountered an error" : "Session has finished", finish.directory)
  }

  function addPending(sessionID, inboxID, expires) {
    let items = pending.get(sessionID)
    if (!items) pending.set(sessionID, (items = new Map()))
    items.set(inboxID, expires)
  }

  function removePending(sessionID, inboxID) {
    const items = pending.get(sessionID)
    if (!items) return
    items.delete(inboxID)
    if (items.size === 0) pending.delete(sessionID)
  }

  function endShell(shellID) {
    const sessionID = shells.get(shellID)
    if (sessionID === undefined) return
    shells.delete(shellID)
    touch(sessionID)
  }

  function forget(sessionID) {
    const parent = parents.get(sessionID)
    running.delete(sessionID)
    pending.delete(sessionID)
    parents.delete(sessionID)
    cancel(sessionID)
    for (const [id, owner] of shells) if (owner === sessionID) shells.delete(id)
    for (const [id, job] of jobs) if (job.sessionID === sessionID) jobs.delete(id)
    if (parent) touch(parent)
  }

  function prune(now) {
    for (const [id, at] of handled) {
      if (now - at < HANDLED_EVENT_TTL_MS) break
      handled.delete(id)
    }
    for (const [id, at] of resolvedJobs) {
      if (now - at < UNTRACKED_JOB_LIMIT_MS) break
      resolvedJobs.delete(id)
    }
    for (const [id, job] of jobs) if (job.until <= now) jobs.delete(id)
  }

  function handle(event) {
    if (!event?.id || handled.has(event.id)) return
    const now = Date.now()
    handled.set(event.id, now)
    prune(now)

    const data = event.data ?? {}
    const sessionID = data.sessionID
    switch (event.type) {
      case "permission.asked":
        alert(event.id, "permission", "Session needs permission", event.location?.directory)
        return
      case "session.created":
        parents.set(sessionID, data.parentID ?? null)
        return
      case "session.deleted":
        forget(sessionID)
        return
      case "session.execution.started":
        running.add(sessionID)
        // The session is working again: its earlier finish no longer counts.
        cancel(sessionID)
        return
      case "session.execution.succeeded":
      case "session.execution.failed":
        running.delete(sessionID)
        // Subagents never alert on their own; their root does once the whole family is done.
        if (parents.get(sessionID)) return touch(sessionID)
        finished.set(sessionID, {
          id: event.id,
          kind: event.type === "session.execution.failed" ? "error" : "done",
          directory: event.location?.directory,
        })
        return schedule(sessionID)
      case "session.execution.interrupted":
        running.delete(sessionID)
        cancel(sessionID)
        return touch(sessionID)
      case "session.inbox.enqueued": {
        const item = data.item
        if (item?.type !== "synthetic") {
          addPending(sessionID, data.inboxID, Infinity)
          return
        }
        const metadata = item.payload?.metadata
        // Parked context (user shell output, reminders) stays pending without running the session.
        if (!isJobResult(metadata)) return
        if (typeof metadata.jobID === "string") {
          jobs.delete(metadata.jobID)
          resolvedJobs.set(metadata.jobID, now)
        }
        addPending(sessionID, data.inboxID, now + UNDELIVERED_JOB_GRACE_MS)
        return touch(sessionID)
      }
      case "session.inbox.delivered":
      case "session.inbox.cancelled":
        removePending(sessionID, data.inboxID)
        return touch(sessionID)
      case "shell.created": {
        const owner = data.info?.metadata?.sessionID
        if (data.info?.status === "running" && typeof owner === "string") shells.set(data.info.id, owner)
        return
      }
      case "session.shell.started":
        if (data.shell?.status === "running") shells.set(data.shell.id, sessionID)
        return
      case "shell.exited":
      case "shell.deleted":
        return endShell(data.id)
      case "session.shell.ended":
        return endShell(data.shell?.id)
      case "session.tool.success": {
        // Background shells and subagents are tracked by their own events. Other background jobs (images) only
        // report a job ID in their tool result, and end when a result with that job ID arrives.
        const jobID = data.metadata?.jobID
        if (typeof jobID === "string" && !resolvedJobs.has(jobID))
          jobs.set(jobID, { sessionID, until: now + UNTRACKED_JOB_LIMIT_MS })
        return
      }
    }
  }

  return {
    contexts,
    handle(event) {
      try {
        handle(event)
      } catch (error) {
        console.error("opencode-notifier failed to handle event", event?.type, error)
      }
    },
    dispose() {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    },
  }
}

// The server loads this plugin once per location, at different times, and every instance receives every event.
// They share one tracker so work that started before a later instance loaded still counts. The key carries a
// version so a reload with changed code never reuses a tracker built by the previous code.
const shared = (globalThis[Symbol.for("pedro.opencode-notifier.tracker.v2")] ??= { tracker: undefined, users: 0 })

function acquireTracker(ctx) {
  const tracker = (shared.tracker ??= createTracker())
  shared.users++
  tracker.contexts.add(ctx)
  let released = false
  return {
    tracker,
    release() {
      if (released) return
      released = true
      tracker.contexts.delete(ctx)
      shared.users--
      if (shared.users > 0) return
      tracker.dispose()
      shared.tracker = undefined
    },
  }
}

export default Plugin.define({
  id: "pedro.opencode-notifier",
  setup: async (ctx) => {
    const controller = new AbortController()
    const { tracker, release } = acquireTracker(ctx)

    const events = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ types: EVENT_TYPES, signal: controller.signal })) {
          tracker.handle(event)
        }
      } catch (error) {
        if (!controller.signal.aborted) console.error("opencode-notifier event stream failed", error)
      }
    })()

    const toolHook = await ctx.tool.hook("execute.before", (input) => {
      if (input.tool === "question") alert(input.id, "question", "Session has a question")
    })

    return async () => {
      controller.abort()
      await toolHook.dispose()
      await events
      release()
    }
  },
})
