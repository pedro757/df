// Keys for the session composer (the Subagents / Shell / Terminals / Sidechats menu): open it on a tab from anywhere in
// a session, and tab/shift+tab, ctrl+j/k and ctrl+l inside it. The composer's own ←/→ have no command ID, so tabs
// switch by selecting their label, the way a mouse click does; ↑/↓ and return dispatch the active tab's own commands.
import type { Plugin } from "@opencode/plugin/tui"
import type { KeymapCommand, KeymapLayer } from "@opencode/plugin/tui/context"
import type { BaseRenderable } from "@opentui/core"
import { composerTabs, type ComposerTabLabel } from "./composer"
import { bindOf, type Options } from "./options"

type Context = Plugin.Context

export type TabName = "subagents" | "shell" | "terminals" | "sidechats"

type RowCommand = "up" | "down" | "select"

/** The built-in tabs' labels and their ↑, ↓ and return commands, as OpenCode 2.3.0 registers them. */
const BUILTIN: Record<Exclude<TabName, "sidechats">, { label: string } & Record<RowCommand, string>> = {
  subagents: {
    label: "Subagents",
    up: "composer.subagent.up",
    down: "composer.subagent.down",
    select: "composer.subagent.select",
  },
  shell: { label: "Shell", up: "composer.shell.up", down: "composer.shell.down", select: "composer.shell.select" },
  terminals: {
    label: "Terminals",
    up: "composer.terminal.up",
    down: "composer.terminal.down",
    select: "composer.terminal.select",
  },
}

export interface ComposerKeysInput {
  readonly context: Context
  readonly options: Options
  /** A node of the open session's `session.composer.top` slot. */
  readonly anchor: () => BaseRenderable | undefined
  readonly sessionID: () => string | undefined
}

export function composerKeys(input: ComposerKeysInput) {
  const { context, options } = input
  const mode = () => context.keymap.mode.current()
  const open = () => mode() === "composer"

  const labelOf = (tab: TabName) => (tab === "sidechats" ? options.label : BUILTIN[tab].label)
  const tabOf = (label: string): TabName | undefined =>
    label === options.label
      ? "sidechats"
      : (Object.entries(BUILTIN).find(([, value]) => value.label === label)?.[0] as TabName | undefined)
  const tabs = () => {
    const anchor = input.anchor()
    return anchor ? composerTabs(anchor) : undefined
  }
  const find = (tab: TabName, list = tabs()) => list?.find((item) => item.label === labelOf(tab))

  // Esc's behavior: a subagent's composer can't close, so leaving it goes to the parent session.
  const close = () => {
    const sessionID = input.sessionID()
    const parentID = sessionID ? context.data.session.get(sessionID)?.parentID : undefined
    if (parentID) context.ui.router.navigate({ type: "session", sessionID: parentID })
    else context.keymap.dispatch("session.child.first")
  }

  /** Whether a shell command is running in this session, so ctrl+b belongs to "Background blocking tools". */
  const backgroundable = () => {
    const sessionID = input.sessionID()
    if (!sessionID) return false
    const messages = context.data.session.message.list(sessionID)
    const current = messages.findLast((message) => message.type === "assistant" && !message.time.completed)
    if (current?.type !== "assistant") return false
    return current.content.some(
      (part) =>
        part.type === "tool" && part.state.status === "running" && (part.name === "shell" || part.name === "bash"),
    )
  }

  /** OpenCode's hint says to press this key to background a running command, so the key does that while one runs. */
  const sharesBackgroundKey = (tab: TabName) => {
    const background = context.keymap.shortcuts("session.background")
    return context.keymap.shortcuts(`sidechats.composer.open.${tab}`).some((key) => background.includes(key))
  }

  /** Opens the composer on `tab`; closes it when that tab is showing. False when the tab isn't available here. */
  const openTab = (tab: TabName): void | false => {
    if (sharesBackgroundKey(tab) && backgroundable()) return false
    const target = find(tab)
    if (!target) return false
    if (open()) {
      if (target.active) close()
      else target.select()
      return
    }
    if (tab === "terminals") context.keymap.dispatch("terminal.select")
    else context.keymap.dispatch("session.child.first", tab === "shell" ? "shell" : "subagents")
    // The composer picks its default tab as it opens, and again when a tab registers (see keepLast in ui.tsx): keep
    // selecting ours until that has settled.
    const settle = (attempt: number) =>
      setTimeout(
        () => {
          // A tab that just registered again has a new label, with no text until it is drawn.
          const again = find(tab)
          if (again && !again.active) again.select()
          if (attempt < 8) settle(attempt + 1)
        },
        attempt === 0 ? 0 : 25,
      )
    settle(0)
  }

  const step = (direction: -1 | 1): void | false => {
    const list = tabs()
    const index = list?.findIndex((item) => item.active) ?? -1
    if (!list || index < 0) return false
    if (list.length < 2) return
    list[(index + direction + list.length) % list.length]!.select()
  }

  /** Runs the showing tab's own ↑, ↓ or return. */
  const row = (command: RowCommand): void | false => {
    const active = tabs()?.find((item: ComposerTabLabel) => item.active)
    const tab = active ? tabOf(active.label) : undefined
    if (!tab) return false
    context.keymap.dispatch(tab === "sidechats" ? `sidechats.composer.${command}` : BUILTIN[tab][command])
  }

  const inSession = () => context.ui.router.current().type === "session"
  const keys = options.keybinds

  const global = (): KeymapLayer => ({
    mode: "global",
    // Above the host's layers, like the composer's own keys. Dialogs and other modes keep their keys.
    priority: 1,
    enabled: () => inSession() && (mode() === "base" || mode() === "composer"),
    commands: [
      {
        id: "sidechats.composer.toggle",
        title: "Open or close the composer",
        group: "Composer",
        bind: bindOf(keys.openComposer),
        run: () => (open() ? close() : context.keymap.dispatch("session.child.first")),
      },
      ...(
        [
          ["subagents", "Subagents", keys.openSubagents],
          ["shell", "Shell", keys.openShell],
          ["terminals", "Terminals", keys.openTerminals],
          ["sidechats", options.label, keys.openSidechats],
        ] as const
      ).map(
        ([tab, title, bind]): KeymapCommand => ({
          id: `sidechats.composer.open.${tab}`,
          title: `Open the ${title} tab`,
          group: "Composer",
          bind: bindOf(bind),
          run: () => openTab(tab),
        }),
      ),
    ],
  })

  const composer = (): KeymapLayer => ({
    mode: "composer",
    priority: 1,
    commands: [
      {
        id: "sidechats.composer.left",
        title: "Previous tab",
        group: "Composer",
        bind: bindOf(keys.composerLeft),
        run: () => step(-1),
      },
      {
        id: "sidechats.composer.right",
        title: "Next tab",
        group: "Composer",
        bind: bindOf(keys.composerRight),
        run: () => step(1),
      },
      {
        id: "sidechats.composer.previous",
        title: "Previous row",
        group: "Composer",
        bind: bindOf(keys.composerUp),
        run: () => row("up"),
      },
      {
        id: "sidechats.composer.next",
        title: "Next row",
        group: "Composer",
        bind: bindOf(keys.composerDown),
        run: () => row("down"),
      },
      {
        id: "sidechats.composer.choose",
        title: "Select the row",
        group: "Composer",
        bind: bindOf(keys.composerSelect),
        run: () => row("select"),
      },
    ],
  })

  return { global, composer }
}
