// TUI options, read from the plugin's entry in ~/.config/opencode/cli.json. The server part reads its own options from
// opencode.json(c); see README.md.

export interface Keybinds {
  /** Global: from a sidechat back to its main session. */
  readonly parent: string
  /** Global: bring the open sidechat back to its main session. */
  readonly bringBack: string
  /** Sidechats tab: bring the selected sidechat back. */
  readonly tabBringBack: string
  /** Sidechats tab: delete the selected sidechat (press twice). */
  readonly tabDelete: string
  /** In a session: open or close the composer (the Subagents / Shell / Terminals / Sidechats menu). */
  readonly openComposer: string
  /** In a session: open the composer on a tab, or close it when that tab is showing. */
  readonly openSubagents: string
  readonly openShell: string
  readonly openTerminals: string
  readonly openSidechats: string
  /** In the composer: previous and next tab, like ← and →. Comma-separated for several keys. */
  readonly composerLeft: string
  readonly composerRight: string
  /** In the composer: previous and next row of the tab, like ↑ and ↓. */
  readonly composerUp: string
  readonly composerDown: string
  /** In the composer: select the row, like return. */
  readonly composerSelect: string
}

export interface Options {
  /** Label of the composer tab. */
  readonly label: string
  /** Add the Sidechats tab to the composer (the Subagents / Shell / Terminals menu). */
  readonly composerTab: boolean
  /** Show each subagent's model and variant in the composer's Subagents tab. */
  readonly subagentsTab: boolean
  /** Replace /btw: ask in a new sidechat instead of the one-shot answer dialog. */
  readonly replaceBtw: boolean
  /** Open a sidechat right after creating it. */
  readonly openOnCreate: boolean
  /** Delete a sidechat you opened empty and left without sending anything, like t3code. */
  readonly deleteUnused: boolean
  /** Toast when a sidechat you are not looking at needs a permission or an answer. */
  readonly notify: boolean
  /**
   * Permission actions that ask in sidechats. Enforced by the server part; the TUI uses it only when the server part
   * is not loaded (for example against a remote server), as session rules.
   */
  readonly ask: readonly string[]
  readonly keybinds: Keybinds
}

const defaults: Options = {
  label: "Sidechats",
  composerTab: true,
  subagentsTab: true,
  replaceBtw: true,
  openOnCreate: true,
  deleteUnused: true,
  notify: true,
  ask: ["edit"],
  keybinds: {
    parent: "<leader>p",
    bringBack: "none",
    tabBringBack: "ctrl+r",
    tabDelete: "ctrl+d",
    openComposer: "none",
    openSubagents: "none",
    openShell: "ctrl+.",
    openTerminals: "ctrl+t",
    openSidechats: "ctrl+b",
    composerLeft: "shift+tab",
    composerRight: "tab",
    composerUp: "ctrl+k",
    composerDown: "ctrl+j",
    composerSelect: "ctrl+l",
  },
}

const text = (value: unknown, fallback: string) => (typeof value === "string" && value.trim() ? value.trim() : fallback)
const flag = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback)

export function parseOptions(raw: Readonly<Record<string, unknown>> | undefined): Options {
  const input = raw ?? {}
  const keys = (input.keybinds && typeof input.keybinds === "object" ? input.keybinds : {}) as Record<string, unknown>
  const ask = Array.isArray(input.ask)
    ? input.ask.filter((value): value is string => typeof value === "string" && value.length > 0)
    : defaults.ask
  return {
    label: text(input.label, defaults.label),
    composerTab: flag(input.composerTab, defaults.composerTab),
    subagentsTab: flag(input.subagentsTab, defaults.subagentsTab),
    replaceBtw: flag(input.replaceBtw, defaults.replaceBtw),
    openOnCreate: flag(input.openOnCreate, defaults.openOnCreate),
    deleteUnused: flag(input.deleteUnused, defaults.deleteUnused),
    notify: flag(input.notify, defaults.notify),
    ask,
    keybinds: Object.fromEntries(
      Object.entries(defaults.keybinds).map(([name, fallback]) => [name, text(keys[name], fallback)]),
    ) as unknown as Keybinds,
  }
}

/** A keymap `bind` value: "none" (or empty) disables the default binding. */
export function bindOf(value: string): string | false {
  return value === "none" || value === "" ? false : value
}
