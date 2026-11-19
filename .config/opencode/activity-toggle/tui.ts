import { Plugin } from "@opencode/plugin/tui"
import { MouseEvent, ScrollBoxRenderable, type Renderable } from "@opentui/core"

type MouseUp = (this: Renderable, event: MouseEvent) => void
type RememberedRow = { row: WeakRef<Renderable>; messageID?: string }

// OpenCode 2.3 renders these as clickable rows, but offers no per-row command.
// Keep access to the host renderable structure and handler in this adapter.
const count = String.raw`\d+ (?:commands?|edits?|thoughts?|reads?|tools?|instructions?)`
const summary = new RegExp(`^${count}(?:, ${count})*$`)
const busy = /^(?:Thinking|(?:Running|Preparing) \S+)…$/

function mouseUp(node: Renderable): MouseUp | undefined {
  return (node as unknown as { _mouseListeners?: { up?: MouseUp } })._mouseListeners?.up
}

function textOf(node: Renderable) {
  const text = (node as Renderable & { plainText?: unknown }).plainText
  return typeof text === "string" ? text.trim() : ""
}

function activityHeader(row: Renderable) {
  // SessionRow -> GroupAnchor -> InlineToolRow. Only inspect the top-level header,
  // not clickable tools or reasoning nested inside an expanded group.
  const header = row.getChildren()[0]?.getChildren()[0]
  if (!header?.visible || !mouseUp(header)) return
  const content = header.getChildren()[0]
  if (!content) return
  const [first, label] = content.getChildren()
  if (first && label && /^[+−-]$/.test(textOf(first))) {
    return summary.test(textOf(label)) ? header : undefined
  }
  // A collapsed group can show a spinner instead of the plus icon while it runs.
  const status =
    first && label && !textOf(first) ? textOf(label) : (textOf(content).match(/^⋯\s+(.+)$/)?.[1] ?? "")
  if (summary.test(status) || busy.test(status)) return header
}

function findTranscript(node: Renderable): ScrollBoxRenderable | undefined {
  if (!node.visible) return
  if (node instanceof ScrollBoxRenderable && node.stickyStart === "bottom") return node
  for (const child of node.getChildren()) {
    const result = findTranscript(child)
    if (result) return result
  }
}

function inViewport(node: Renderable, scroll: ScrollBoxRenderable) {
  const { y, height } = scroll.viewport
  return node.height > 0 && node.y < y + height && node.y + node.height > y
}

export default Plugin.define({
  id: "activity-toggle",
  setup(context) {
    const { renderer } = context
    const root = renderer.root
    const last = new Map<string, RememberedRow>()
    const sessionID = () => {
      const route = context.ui.router.current()
      return route.type === "session" ? route.sessionID : undefined
    }
    const transcript = () => {
      const pane = root.findDescendantById("session-pane")
      return pane ? findTranscript(pane) : undefined
    }
    const remember = (id: string, row: Renderable) =>
      last.set(id, { row: new WeakRef(row), messageID: row.id?.startsWith("msg_") ? row.id : undefined })

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "activity.toggle.last",
          title: "Toggle last activity summary",
          group: "Session",
          palette: true,
          bind: "<leader>z",
          enabled: () => sessionID() !== undefined,
          run(_input, keyEvent) {
            if (keyEvent && context.keymap.mode.current() !== "base") return false
            const id = sessionID()
            const scroll = transcript()
            if (!id || !scroll || renderer.getSelection()?.getSelectedText()) return
            const rows = scroll.getChildren()
            const saved = last.get(id)
            const mounted = saved?.row.deref()
            let row: Renderable | undefined
            if (saved) {
              if (mounted?.parent === scroll) row = mounted
              else if (saved.messageID) row = rows.find((item) => saved.messageID === item.id)
            } else {
              row = rows.findLast((item) => {
                const header = activityHeader(item)
                return header && inViewport(header, scroll)
              })
            }
            const header = row ? activityHeader(row) : undefined
            const toggle = header && mouseUp(header)
            if (!row || !header || !toggle) {
              context.ui.toast.show({
                message: saved
                  ? "Last activity summary isn’t loaded. Scroll back to it or click another summary."
                  : "No activity summary is visible. These rows appear at Low transcript verbosity.",
              })
              return
            }

            if (!inViewport(header, scroll)) scroll.scrollChildIntoView(header)
            const event = new MouseEvent(header, {
              type: "up",
              button: 0,
              x: header.x,
              y: header.y,
              modifiers: { shift: false, alt: false, ctrl: false },
            })
            // Call just the built-in disclosure, without moving focus or bubbling a synthetic click.
            Object.assign(event, { currentTarget: header })
            toggle.call(header, event)
            remember(id, row)
          },
        },
      ],
    }))

    // Native clicks already do the toggling. Observe the bubbled mouse-up to remember the row.
    const previous = mouseUp(root)
    const onMouseUp: MouseUp = function (event) {
      previous?.call(this, event)
      if (event.button !== 0 || renderer.getSelection()?.getSelectedText()) return
      const id = sessionID()
      const scroll = id && transcript()
      if (!id || !scroll) return
      const path = new Set<Renderable>()
      for (let node = event.target; node && node !== scroll; node = node.parent) {
        path.add(node)
        if (node.parent !== scroll) continue
        const header = activityHeader(node)
        if (header && path.has(header)) remember(id, node)
        break
      }
    }
    root.onMouseUp = onMouseUp
    return () => {
      if (mouseUp(root) === onMouseUp) root.onMouseUp = previous
    }
  },
})
