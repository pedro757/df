// The keybindings view: every key the session list answers to, as it is bound right now (custom keys included).
import { usePlugin } from "@opencode/plugin/tui"
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { For } from "solid-js"
import { DialogHeader, DialogLayout, useDialogTheme } from "./ui"

export interface HelpRow {
  /** Formatted keys, e.g. "up, ctrl+p". Empty when nothing is bound. */
  readonly keys: string
  readonly label: string
}

export interface HelpGroup {
  readonly title: string
  readonly rows: readonly HelpRow[]
}

const KEY_COLUMN = { min: 10, max: 24 }

/** OpenCode's diff viewer help, for the session list: groups of "key  what it does" rows. */
export function KeybindingsHelp(props: {
  groups: readonly HelpGroup[]
  /** The configured help key (fallback binding; cli.json overrides apply). */
  helpBind: string
  halfPageKeys: { readonly down: string; readonly up: string }
  onClose: () => void
}) {
  const context = usePlugin()
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const theme = useDialogTheme()
  let scroll: ScrollBoxRenderable | undefined

  const keyWidth = Math.min(
    KEY_COLUMN.max,
    Math.max(KEY_COLUMN.min, ...props.groups.flatMap((group) => group.rows.map((row) => (row.keys || "unbound").length))),
  )
  const contentHeight = props.groups.reduce((height, group) => height + group.rows.length + 2, -1)
  const height = () => Math.max(1, Math.min(dimensions().height - 8, contentHeight))
  const scrollBy = (delta: number) => {
    if (scroll && !scroll.isDestroyed) scroll.scrollBy(delta)
  }
  const half = () => Math.max(1, Math.floor(height() / 2))

  context.keymap.layer(() => ({
    mode: "modal",
    priority: 1,
    commands: [
      { id: "dialog.select.prev", title: "Scroll up", group: "Dialog", run: () => scrollBy(-1) },
      { id: "dialog.select.next", title: "Scroll down", group: "Dialog", run: () => scrollBy(1) },
      { id: "dialog.select.page_up", title: "Page up", group: "Dialog", run: () => scrollBy(-height()) },
      { id: "dialog.select.page_down", title: "Page down", group: "Dialog", run: () => scrollBy(height()) },
      { id: "dialog.select.home", title: "Top", group: "Dialog", run: () => scroll?.scrollTo(0) },
      { id: "dialog.select.end", title: "Bottom", group: "Dialog", run: () => scrollBy(contentHeight) },
      {
        id: "better_sessions.half_page_down",
        title: "Half page down",
        group: "Dialog",
        bind: props.halfPageKeys.down,
        run: () => scrollBy(half()),
      },
      {
        id: "better_sessions.half_page_up",
        title: "Half page up",
        group: "Dialog",
        bind: props.halfPageKeys.up,
        run: () => scrollBy(-half()),
      },
      { id: "better_sessions.help", title: "Close keybindings", group: "Dialog", bind: props.helpBind, run: props.onClose },
      {
        bind: "escape",
        title: "Back",
        group: "Dialog",
        run: () => {
          if (renderer.getSelection()) {
            renderer.clearSelection()
            return
          }
          props.onClose()
        },
      },
    ],
  }))

  return (
    <DialogLayout
      header={<DialogHeader title="Keybindings" onClose={props.onClose} />}
      footer={
        <text fg={theme().text.muted} wrapMode="word">
          Set your own keys in cli.json: the plugin's keybinds option, or OpenCode's keybinds for the rest.
        </text>
      }
    >
      <scrollbox
        ref={(value: ScrollBoxRenderable) => {
          scroll = value
        }}
        height={height()}
        horizontalScrollbarOptions={{ visible: false }}
        verticalScrollbarOptions={{ visible: false }}
      >
        <box gap={1}>
          <For each={props.groups}>
            {(group) => (
              <box flexShrink={0}>
                <text fg={theme().text.base} attributes={TextAttributes.BOLD}>
                  {group.title}
                </text>
                <For each={group.rows}>
                  {(row) => (
                    <box flexDirection="row" gap={2}>
                      <text
                        fg={row.keys ? theme().text.base : theme().text.muted}
                        width={keyWidth}
                        flexShrink={0}
                        wrapMode="none"
                      >
                        {row.keys || "unbound"}
                      </text>
                      {/* One line per row: the height above counts rows. */}
                      <text fg={theme().text.muted} flexGrow={1} minWidth={0} wrapMode="none">
                        {row.label}
                      </text>
                    </box>
                  )}
                </For>
              </box>
            )}
          </For>
        </box>
      </scrollbox>
    </DialogLayout>
  )
}
