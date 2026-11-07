// Better sessions: OpenCode's session list split into Active, Settled and Snoozed tabs.
// See README.md for behavior and options.
import { Plugin } from "@opencode/plugin/tui"
import type { KeymapCommand } from "@opencode/plugin/tui/context"
import { createEffect, createRoot, on } from "solid-js"
import { parseOptions } from "./src/config"
import { InboxDialog, isInboxOpen, type DialogStart } from "./src/dialog"
import { createInbox } from "./src/inbox"
import { toggleJump } from "./src/select"
import { sessionTitle } from "./src/util"

export default Plugin.define({
  id: "better-sessions",
  setup(context) {
    const options = parseOptions(context.options)
    const data = context.data
    const currentRoot = () => {
      const route = context.ui.router.current()
      return route.type === "session" ? data.session.root(route.sessionID) : undefined
    }
    // The inbox owns effects and timers, so it lives in its own root. Keymap layers must not: they need
    // the host's context, which they get when created outside any plugin-owned root.
    const { inbox, cleanup } = createRoot((dispose) => {
      const inbox = createInbox(context, options)
      // Looking at a woken session acknowledges it.
      createEffect(on(currentRoot, (id) => id && inbox.visit(id)))
      return { inbox, cleanup: dispose }
    })

    const open = (start?: DialogStart) => {
      context.ui.dialog.show(() => <InboxDialog inbox={inbox} options={options} start={start} />)
      context.ui.dialog.set({ size: start ? "medium" : "large" })
    }
    // Pressed again while the list is showing, the same key toggles jump labels (flash.nvim) instead of reopening it.
    const openOrJump = () => {
      if (!isInboxOpen()) return open()
      toggleJump()
    }

    const currentPlacement = () => {
      const id = currentRoot()
      const session = id ? data.session.get(id) : undefined
      return session ? inbox.placement(session, Date.now()) : undefined
    }
    const currentTitle = () => {
      const id = currentRoot()
      const session = id ? data.session.get(id) : undefined
      return session ? sessionTitle(session) : undefined
    }

    const commands = (): KeymapCommand[] => [
      ...(options.replaceSessionList
        ? [
            {
              // Same id as the built-in command: its keybind, palette entry and /sessions now open this list.
              id: "session.list",
              title: "Switch session",
              group: "Session",
              bind: false as const,
              palette: true as const,
              suggested: () => data.session.list().length > 0,
              slash: { name: "sessions", aliases: ["resume", "continue"] },
              run: openOrJump,
            },
          ]
        : []),
      {
        id: "better_sessions.open",
        title: "Better sessions",
        group: "Session",
        bind: false,
        ...(options.replaceSessionList ? {} : { palette: true as const, slash: { name: "better-sessions" } }),
        run: openOrJump,
      },
      {
        id: "better_sessions.settle.current",
        title: "Settle session",
        group: "Session",
        bind: false,
        palette: true,
        enabled: () => currentPlacement() !== undefined && currentPlacement()?.tab !== "settled",
        run: () => {
          const id = currentRoot()
          if (!id) return
          const error = inbox.settle(id)
          if (error) {
            context.ui.toast.show({ message: error, variant: "warning" })
            return
          }
          context.ui.toast.show({ title: currentTitle(), message: "Session settled", variant: "success" })
        },
      },
      {
        id: "better_sessions.snooze.current",
        title: "Snooze session…",
        group: "Session",
        bind: false,
        palette: true,
        enabled: () => currentRoot() !== undefined,
        run: () => {
          const id = currentRoot()
          if (!id) return
          const blocker = inbox.canSnooze(id)
          if (blocker) {
            context.ui.toast.show({ message: blocker, variant: "warning" })
            return
          }
          open({ view: "snooze", sessionID: id })
        },
      },
      {
        id: "better_sessions.restore.current",
        title: "Restore session to Active",
        group: "Session",
        bind: false,
        palette: true,
        enabled: () => {
          const tab = currentPlacement()?.tab
          return tab === "settled" || tab === "snoozed"
        },
        run: () => {
          const id = currentRoot()
          if (!id) return
          void inbox
            .restore(id)
            .then(() =>
              context.ui.toast.show({
                title: currentTitle(),
                message: "Session is back in Active",
                variant: "success",
              }),
            )
        },
      },
      // Quick switch follows this plugin's pins, so the slot numbers in the list are the ones that work.
      ...Array.from({ length: 9 }, (_, index): KeymapCommand => ({
        id: `session.quick_switch.${index + 1}`,
        title: `Switch to session in quick slot ${index + 1}`,
        group: "Session",
        bind: false,
        enabled: () => !context.ui.tabs.enabled(),
        run: () => inbox.quickSwitch(index + 1),
      })),
    ]

    context.keymap.layer(() => ({
      mode: "global",
      // Above the host's command layer, so same-id commands resolve here first. No bindings are added:
      // the host's configured keys for these ids keep working and now reach these commands.
      priority: 1,
      commands: commands(),
    }))

    return () => cleanup()
  },
})
