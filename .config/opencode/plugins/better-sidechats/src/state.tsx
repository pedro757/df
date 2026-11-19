// Sidechats in the TUI: which sessions are sidechats of which main session, and the actions on them.
import type { Plugin } from "@opencode/plugin/tui"
import type { SessionInfo } from "@opencode/client"
import { createEffect, createRoot, createSignal, on } from "solid-js"
import { DEFAULT_TITLE, sidechatInstructions, sidechatOf, titleFrom, withSidechat, type Sidechat } from "./meta"
import type { Options } from "./options"
import { bringBackText, ownMessages, type MessageLike } from "./transcript"

type Context = Plugin.Context

const PAGE = 100
const INSTRUCTIONS_KEY = "sidechat"

export interface SidechatEntry {
  readonly session: SessionInfo
  readonly sidechat: Sidechat
}

export type Sidechats = ReturnType<typeof createSidechats>

function message(error: unknown) {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string")
    return error.message
  return String(error)
}

export function createSidechats(context: Context, options: Options) {
  const { client, data } = context
  // Survives plugin reloads; rebuilt from the server per main session.
  const [index, setIndex] = context.storage.memory("index", {
    initial: {
      /** Main session ID -> its sidechat IDs. */
      byParent: {} as Record<string, string[]>,
      /** When each main session's list was last read from the server. */
      loaded: {} as Record<string, number>,
      /** Sidechats this TUI opened empty, deleted when left unused. */
      fresh: {} as Record<string, true>,
      /** Pending permission requests and forms per session, for the "needs you" marker. */
      waiting: {} as Record<string, Record<string, true>>,
    },
  })
  const [busy, setBusy] = createSignal(0)

  const currentSessionID = () => {
    const route = context.ui.router.current()
    return route.type === "session" ? route.sessionID : undefined
  }

  /** The sidechat a session is, or runs under (a subagent started in a sidechat). */
  const sidechatFor = (sessionID: string | undefined): Sidechat | undefined => {
    if (!sessionID) return
    const root = data.session.root(sessionID)
    return sidechatOf(data.session.get(root))
  }

  /** The main session a session's sidechats belong to. */
  const mainOf = (sessionID: string): string => {
    const root = data.session.root(sessionID)
    return sidechatOf(data.session.get(root))?.parentID ?? root
  }

  const list = (mainID: string): SidechatEntry[] =>
    (index.byParent[mainID] ?? [])
      .flatMap((id): SidechatEntry[] => {
        const session = data.session.get(id)
        const sidechat = sidechatOf(session)
        return session && sidechat?.parentID === mainID ? [{ session, sidechat }] : []
      })
      .sort((a, b) => b.session.time.updated - a.session.time.updated)

  const waiting = (sessionID: string) =>
    data.session.family(sessionID).some((id) => Object.keys(index.waiting[id] ?? {}).length > 0)

  const remember = (mainID: string, sessionID: string) =>
    setIndex((draft) => {
      const ids = draft.byParent[mainID] ?? []
      if (!ids.includes(sessionID)) draft.byParent[mainID] = [sessionID, ...ids]
    })

  const forget = (sessionID: string) =>
    setIndex((draft) => {
      for (const [mainID, ids] of Object.entries(draft.byParent))
        if (ids.includes(sessionID)) draft.byParent[mainID] = ids.filter((id) => id !== sessionID)
      delete draft.fresh[sessionID]
      delete draft.waiting[sessionID]
    })

  const sessionInfo = async (sessionID: string): Promise<SessionInfo | undefined> => {
    const known = data.session.get(sessionID)
    if (known) return known
    await data.session.sync(sessionID).catch(() => {})
    return data.session.get(sessionID)
  }

  /** Reads a main session's sidechats from the server: archived sessions in its directory marked with its ID. */
  const load = async (mainID: string, maxAge = 0) => {
    if (maxAge > 0 && Date.now() - (index.loaded[mainID] ?? 0) < maxAge) return
    setIndex((draft) => {
      draft.loaded[mainID] = Date.now()
    })
    const main = await sessionInfo(mainID)
    if (!main) return
    const found: SessionInfo[] = []
    let cursor: string | undefined
    for (let page = 0; page < 50; page++) {
      const response = await client.session.list(
        cursor
          ? { cursor, limit: PAGE }
          : { directory: main.location.directory, archived: true, parentID: null, limit: PAGE, order: "desc" },
      )
      for (const session of response.data) if (sidechatOf(session)?.parentID === mainID) found.push(session)
      cursor = response.cursor?.next ?? undefined
      if (!cursor || response.data.length < PAGE) break
    }
    await Promise.all(found.map((session) => data.session.get(session.id) ?? data.session.sync(session.id)))
    setIndex((draft) => {
      draft.byParent[mainID] = found.map((session) => session.id)
    })
  }

  // The server part answers this; without it (a remote server, or a disabled server part) sidechats fall back to
  // session permission rules.
  let serverPart: { readonly at: number; readonly active: boolean } | undefined
  const serverPartActive = async (directory: string) => {
    if (serverPart && Date.now() - serverPart.at < 60_000) return serverPart.active
    const response = await client.plugin.list({ location: { directory } }).catch(() => undefined)
    const active = Boolean(
      response?.data.some(
        (plugin) => plugin.id === "better-sidechats" && plugin.features?.server && plugin.state?.status === "active",
      ),
    )
    serverPart = { at: Date.now(), active }
    return active
  }

  const newestMessageID = (sessionID: string) =>
    client.message
      .list({ sessionID, limit: 1, order: "desc" })
      .then((response) => response.data[0]?.id as string | undefined)

  /**
   * Opens a sidechat. It forks `fromID` (so it starts with everything that session knows) and belongs to `fromID`'s
   * main session. With a question it is sent right away; without one the sidechat opens empty.
   */
  const create = async (fromID: string, question?: string) => {
    const from = await sessionInfo(fromID)
    if (!from) throw new Error("Session not found")
    const parentID = mainOf(fromID)
    const parent = (await sessionInfo(parentID)) ?? from
    setBusy((count) => count + 1)
    try {
      let forked: SessionInfo
      try {
        forked = await client.session.fork({ sessionID: fromID })
      } catch (error) {
        // A session without messages has nothing to fork: start an empty session in the same place.
        if ((await newestMessageID(fromID).catch(() => "unknown")) !== undefined) throw error
        forked = await client.session.create({
          location: { directory: from.location.directory },
          ...(from.agent ? { agent: from.agent } : {}),
          ...(from.model
            ? {
                model: {
                  id: from.model.id,
                  providerID: from.model.providerID,
                  ...(from.model.variant ? { variant: from.model.variant } : {}),
                },
              }
            : {}),
        })
      }
      const base = await newestMessageID(forked.id).catch(() => undefined)
      const text = question?.trim()
      const sidechat: Sidechat = {
        parentID,
        sessionID: forked.id,
        from: fromID,
        base,
        created: Date.now(),
        untitled: text ? undefined : true,
      }
      const fallback = !(await serverPartActive(from.location.directory))
      await client.session.update({
        sessionID: forked.id,
        title: text ? titleFrom(text) : DEFAULT_TITLE,
        metadata: withSidechat(forked.metadata, sidechat),
        archived: true,
        ...(fallback
          ? {
              permissions: [
                ...(forked.permissions ?? []),
                ...options.ask.map((action) => ({ action, resource: "*", effect: "ask" as const })),
              ],
            }
          : {}),
      })
      // Told as an instruction entry, which reaches the model at the next step as a message: the system prompt, and
      // with it the provider's cache of the copied history, stays the same.
      await client.experimental.session.instructions.entry
        .put({ sessionID: forked.id, key: INSTRUCTIONS_KEY, value: sidechatInstructions(parent.title) })
        .catch(() => {})
      await data.session.sync(forked.id).catch(() => {})
      remember(parentID, forked.id)
      if (!text)
        setIndex((draft) => {
          draft.fresh[forked.id] = true
        })
      if (options.openOnCreate) context.ui.router.navigate({ type: "session", sessionID: forked.id })
      if (text) {
        // Load the transcript before the question goes in: when the prompt is delivered between separate reads of the
        // pending inbox and the messages, the TUI shows the question after its answer.
        await Promise.all([data.session.message.sync(forked.id), data.session.pending.sync(forked.id)]).catch(() => {})
        await client.session.prompt({ sessionID: forked.id, text })
      }
      return forked.id
    } finally {
      setBusy((count) => count - 1)
    }
  }

  const remove = async (sessionID: string) => {
    const sidechat = sidechatOf(data.session.get(sessionID))
    if (currentSessionID() && data.session.root(currentSessionID()!) === sessionID && sidechat)
      context.ui.router.navigate({ type: "session", sessionID: sidechat.parentID })
    await client.session.remove({ sessionID })
    forget(sessionID)
  }

  /** Why the sidechat can't be brought back right now, if it can't. */
  const bringBackBlocker = (sessionID: string): string | undefined => {
    const sidechat = sidechatOf(data.session.get(sessionID))
    if (!sidechat) return "Not a sidechat"
    if (data.session.family(sidechat.parentID).some((id) => data.session.status(id) === "running"))
      return "Available when the main session is idle"
    if (data.session.status(sessionID) === "running") return "Available when the sidechat is idle"
  }

  /**
   * Hands the sidechat's conversation to its main session. It waits in the main session's inbox and reaches the model
   * with the next message sent there, like t3code's Bring back.
   */
  const bringBack = async (sessionID: string) => {
    const blocker = bringBackBlocker(sessionID)
    if (blocker) throw new Error(blocker)
    const session = (await sessionInfo(sessionID))!
    const sidechat = sidechatOf(session)!
    const pages: MessageLike[] = []
    let cursor: string | undefined
    for (let page = 0; page < 20; page++) {
      const response = await client.message.list(
        cursor ? { sessionID, cursor, limit: PAGE } : { sessionID, limit: PAGE, order: "desc" },
      )
      pages.push(...(response.data as unknown as MessageLike[]))
      if (sidechat.base && response.data.some((item) => item.id === sidechat.base)) break
      cursor = response.cursor?.next ?? undefined
      if (!cursor || response.data.length < PAGE) break
    }
    const title = session.title ?? DEFAULT_TITLE
    const result = bringBackText({ title, messages: ownMessages(pages, sidechat.base).messages })
    if (!result) throw new Error("Nothing to bring back yet: the sidechat has no reply")
    await client.session.synthetic({
      sessionID: sidechat.parentID,
      text: result.text,
      description: `Sidechat brought back: ${title}`,
      metadata: { source: "sidechat", sidechatID: sessionID },
      resume: false,
    })
    await client.session.update({
      sessionID,
      metadata: withSidechat(session.metadata, { ...sidechat, broughtBack: Date.now() }),
    })
    return result
  }

  /** Deletes a sidechat this TUI opened empty if nothing was sent in it. */
  const discardIfUnused = async (sessionID: string) => {
    setIndex((draft) => {
      delete draft.fresh[sessionID]
    })
    const sidechat = sidechatOf(data.session.get(sessionID))
    if (!sidechat || data.session.status(sessionID) === "running") return
    if (data.session.family(sessionID).length > 1) return
    const newest = await newestMessageID(sessionID).catch(() => "unknown")
    if (newest !== sidechat.base) return
    // OpenCode's fork notice waits in the inbox as a synthetic message; only what you sent counts.
    const pending = await client.session.inbox.list({ sessionID }).catch(() => undefined)
    if (!pending || pending.some((item) => item.type !== "synthetic")) return
    await client.session.remove({ sessionID }).catch(() => {})
    forget(sessionID)
  }

  const dispose = createRoot((dispose) => {
    // Keep the open main session's list current.
    createEffect(
      on(currentSessionID, (sessionID) => {
        if (!sessionID) return
        void sessionInfo(sessionID).then(() => load(mainOf(sessionID), 15_000).catch(() => {}))
      }),
    )
    // An empty sidechat you leave without sending anything is deleted, as in t3code.
    createEffect(
      on(currentSessionID, (next, previous) => {
        if (!options.deleteUnused || !previous || previous === next || !index.fresh[previous]) return
        void discardIfUnused(previous)
      }),
    )
    return dispose
  })

  const stops = [
    context.data.on("session.deleted", (event) => forget(event.data.sessionID)),
    // Sidechats opened elsewhere (another TUI, the web app) join their main session's list.
    context.data.on("session.metadata.updated", (event) => {
      const sidechat = sidechatOf({ id: event.data.sessionID, metadata: event.data.metadata })
      if (!sidechat || !index.byParent[sidechat.parentID]) return
      void sessionInfo(event.data.sessionID).then(() => remember(sidechat.parentID, event.data.sessionID))
    }),
    context.data.on("permission.asked", (event) =>
      setIndex((draft) => {
        ;(draft.waiting[event.data.sessionID] ??= {})[event.data.id] = true
      }),
    ),
    context.data.on("permission.replied", (event) =>
      setIndex((draft) => {
        delete draft.waiting[event.data.sessionID]?.[event.data.requestID]
      }),
    ),
    context.data.on("form.created", (event) =>
      setIndex((draft) => {
        ;(draft.waiting[event.data.form.sessionID] ??= {})[event.data.form.id] = true
      }),
    ),
    context.data.on("form.replied", (event) =>
      setIndex((draft) => {
        for (const forms of Object.values(draft.waiting)) delete forms[event.data.id]
      }),
    ),
    context.data.on("form.cancelled", (event) =>
      setIndex((draft) => {
        for (const forms of Object.values(draft.waiting)) delete forms[event.data.id]
      }),
    ),
  ]

  return {
    index,
    busy,
    currentSessionID,
    sidechatFor,
    mainOf,
    list,
    waiting,
    load,
    create,
    remove,
    bringBack,
    bringBackBlocker,
    errorMessage: message,
    dispose: () => {
      stops.forEach((stop) => stop())
      dispose()
    },
  }
}
