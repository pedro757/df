// better-sidechats, server part: edits in a sidechat always ask, an empty sidechat is named after its first message, and
// deleting a main session deletes its sidechats. The TUI part (tui.tsx) creates and shows them. See README.md.
import { Plugin } from "@opencode/plugin"
import { matchesAction, sidechatOf, titleFrom, withSidechat, type Sidechat } from "./src/meta"

interface ServerOptions {
  /** Permission actions that always ask in a sidechat, even when a rule or a saved approval allows them. */
  readonly ask: readonly string[]
}

function parseOptions(raw: Readonly<Record<string, unknown>> | undefined): ServerOptions {
  const ask = Array.isArray(raw?.ask)
    ? raw.ask.filter((value): value is string => typeof value === "string" && value.length > 0)
    : ["edit"]
  return { ask }
}

const PAGE = 100

export default Plugin.define({
  id: "better-sidechats",
  async setup(ctx) {
    const options = parseOptions(ctx.options)

    // Which sidechat a session belongs to: itself, or the sidechat a subagent runs under. A session never becomes or
    // stops being a sidechat after its first prompt, and metadata updates clear the cache anyway.
    const owners = new Map<string, Promise<Sidechat | undefined>>()
    const owner = (sessionID: string): Promise<Sidechat | undefined> => {
      const cached = owners.get(sessionID)
      if (cached) return cached
      if (owners.size > 5_000) owners.clear()
      const pending = (async () => {
        let id: string | undefined = sessionID
        for (let depth = 0; id && depth < 10; depth++) {
          const session: Awaited<ReturnType<typeof ctx.session.get>> | undefined = await ctx.session
            .get({ sessionID: id })
            .catch(() => undefined)
          if (!session) return
          const sidechat = sidechatOf(session)
          if (sidechat) return sidechat
          id = session.parentID
        }
      })()
      owners.set(sessionID, pending)
      return pending
    }

    // Edits ask in sidechats. The hook runs after configured rules and saved "Allow always" approvals, and never sees a
    // configured deny, so it can only turn an allow into an ask.
    const permission = await ctx.permission.hook("evaluate", async (event) => {
      if (event.effect !== "allow") return
      if (!matchesAction(event.action, options.ask)) return
      if (!(await owner(event.sessionID))) return
      event.effect = "ask"
      event.message ??= `Sidechat: ${
        event.action === "edit" ? "every edit" : event.action === "shell" ? "every command" : event.action
      } needs your approval`
    })

    // A sidechat opened without a question is named after the first message sent in it.
    const prompt = await ctx.session.hook("prompt", async (event) => {
      const session = await ctx.session.get({ sessionID: event.sessionID }).catch(() => undefined)
      const sidechat = sidechatOf(session)
      if (!session || !sidechat?.untitled) return
      const title = titleFrom(event.prompt.text ?? "")
      if (!title) return
      // Not awaited: admission must not wait on the rename.
      void ctx.session
        .update({
          sessionID: session.id,
          title,
          metadata: withSidechat(session.metadata, { ...sidechat, untitled: undefined }),
        })
        .catch(() => {})
    })

    // Sidechats only show inside their main session, so deleting it deletes them, like t3code.
    const removing = new Set<string>()
    const removeSidechatsOf = async (parentID: string) => {
      if (removing.has(parentID)) return
      removing.add(parentID)
      try {
        const found: string[] = []
        let cursor: string | undefined
        for (let page = 0; page < 50; page++) {
          const response = await ctx.session.list(
            cursor ? { cursor, limit: PAGE } : { archived: true, parentID: null, limit: PAGE, order: "desc" },
          )
          for (const session of response.data) if (sidechatOf(session)?.parentID === parentID) found.push(session.id)
          cursor = response.cursor?.next ?? undefined
          if (!cursor || response.data.length < PAGE) break
        }
        for (const sessionID of found) await ctx.session.remove({ sessionID }).catch(() => {})
      } finally {
        removing.delete(parentID)
      }
    }

    const controller = new AbortController()
    void (async () => {
      const events = ctx.event.subscribe({
        types: ["session.deleted", "session.metadata.updated"],
        signal: controller.signal,
      })
      for await (const event of events) {
        if (event.type === "session.metadata.updated") {
          owners.clear()
          continue
        }
        owners.delete(event.data.sessionID)
        void removeSidechatsOf(event.data.sessionID).catch(() => {})
      }
    })().catch(() => {})

    return async () => {
      controller.abort()
      await Promise.allSettled([permission.dispose(), prompt.dispose()])
    }
  },
})
