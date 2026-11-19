// better-sidechats: side conversations that start with everything their session knows, stay out of the session list, and
// show up in the composer's Sidechats tab. /btw opens one. See README.md.
import { Plugin } from "@opencode/plugin/tui"
import type { KeymapCommand } from "@opencode/plugin/tui/context"
import { DEFAULT_TITLE } from "./src/meta"
import { bindOf, parseOptions } from "./src/options"
import { composerKeys } from "./src/keys"
import { createSidechats } from "./src/state"
import { createUI } from "./src/ui"

export default Plugin.define({
  id: "better-sidechats",
  setup(context) {
    const options = parseOptions(context.options)
    const store = createSidechats(context, options)
    const ui = createUI(context, store, options)
    const { data } = context

    const current = () => store.currentSessionID()
    const currentSidechat = () => store.sidechatFor(current())

    const stopTop = context.ui.slot({
      append: "session.composer.top",
      render: (input) => <ui.ComposerTop input={input} />,
    })
    const stopFooter = context.ui.slot({
      append: "prompt.footer.status",
      render: (input) => <ui.FooterStatus input={input} />,
    })

    const ask = async (input?: string) => {
      const sessionID = current()
      if (!sessionID) {
        context.ui.toast.show({ message: "Open a session first", variant: "warning" })
        return
      }
      await ui.newSidechat(sessionID, input?.trim() || undefined)
    }

    const commands = (): KeymapCommand[] => [
      ...(options.replaceBtw
        ? [
            {
              // The built-in /btw's ID, so its slash command, palette entry and any keybind open a sidechat instead.
              id: "session.aside",
              title: "Ask in a sidechat",
              description: "A side conversation that starts with this session's context. /btw <question>",
              group: "Session",
              bind: false as const,
              palette: true as const,
              enabled: () => current() !== undefined,
              slash: { name: "btw", aliases: ["side"], arguments: true as const },
              run: ask,
            },
          ]
        : [
            {
              id: "sidechats.ask",
              title: "Ask in a sidechat",
              group: "Session",
              bind: false as const,
              palette: true as const,
              enabled: () => current() !== undefined,
              slash: { name: "side", arguments: true as const },
              run: ask,
            },
          ]),
      {
        id: "sidechats.list",
        title: "Sidechats",
        description: "Sidechats of this session",
        group: "Session",
        bind: false,
        palette: true,
        enabled: () => current() !== undefined,
        slash: { name: "sidechats" },
        run: () => ui.openDialog(),
      },
      {
        id: "sidechats.new",
        title: "New sidechat",
        description: "An empty sidechat of the main session",
        group: "Session",
        bind: false,
        palette: true,
        enabled: () => current() !== undefined,
        run: () => {
          const sessionID = current()
          if (sessionID) void ui.newSidechat(store.mainOf(sessionID))
        },
      },
      {
        id: "sidechats.parent",
        title: "Back to main session",
        description: "Leave the sidechat for the session it belongs to",
        group: "Session",
        bind: bindOf(options.keybinds.parent),
        palette: true,
        enabled: () => currentSidechat() !== undefined,
        run: () => {
          const sidechat = currentSidechat()
          if (sidechat) context.ui.router.navigate({ type: "session", sessionID: sidechat.parentID })
        },
      },
      {
        id: "sidechats.bring_back",
        title: "Bring sidechat back",
        description: "The main session gets this sidechat with your next message there",
        group: "Session",
        bind: bindOf(options.keybinds.bringBack),
        palette: true,
        enabled: () => currentSidechat() !== undefined,
        run: () => {
          const sidechat = currentSidechat()
          if (sidechat) void ui.bringBack(sidechat.sessionID)
        },
      },
      {
        id: "sidechats.delete",
        title: "Delete sidechat",
        group: "Session",
        bind: false,
        palette: true,
        enabled: () => currentSidechat() !== undefined,
        run: async () => {
          const sidechat = currentSidechat()
          if (!sidechat) return
          const title = data.session.get(sidechat.sessionID)?.title ?? DEFAULT_TITLE
          const confirmed = await context.ui.dialog.confirm({
            title: "Delete sidechat",
            message: `Delete "${title}"?`,
            label: { confirm: "Delete" },
          })
          if (confirmed) await ui.remove(sidechat.sessionID)
        },
      },
    ]

    context.keymap.layer(() => ({
      mode: "global",
      // Above the host's layer, so session.aside resolves here first. The host's configured key for it still applies.
      priority: 1,
      commands: commands(),
    }))

    const keys = composerKeys({ context, options, anchor: ui.composerAnchor, sessionID: current })
    context.keymap.layer(keys.global)
    context.keymap.layer(keys.composer)

    // Sidechats are out of the session list, so say so when one you are not looking at waits on you.
    const notify = async (sessionID: string, title: string) => {
      if (!options.notify) return
      let id: string | undefined = sessionID
      for (let depth = 0; id && depth < 6; depth++) {
        if (!data.session.get(id)) await data.session.sync(id).catch(() => {})
        id = data.session.get(id)?.parentID
      }
      const sidechat = store.sidechatFor(sessionID)
      if (!sidechat) return
      const open = current()
      if (open && data.session.root(open) === sidechat.sessionID) return
      context.ui.toast.show({
        sessionID: sidechat.sessionID,
        title,
        message: data.session.get(sidechat.sessionID)?.title ?? DEFAULT_TITLE,
        variant: "warning",
      })
    }
    const stops = [
      context.data.on("permission.asked", (event) => void notify(event.data.sessionID, "Sidechat needs approval")),
      context.data.on("form.created", (event) => void notify(event.data.form.sessionID, "Sidechat has a question")),
    ]

    return () => {
      stops.forEach((stop) => stop())
      stopTop()
      stopFooter()
      store.dispose()
    }
  },
})
