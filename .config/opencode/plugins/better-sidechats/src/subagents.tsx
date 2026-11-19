// The composer's Subagents tab, with each subagent's model and variant. OpenCode's own tab has no room for a plugin to
// add to its rows, so this draws the same list itself: it takes over the tab's registration (same ID and label, so the
// tab keeps its place and stays the default), hides OpenCode's list while the tab shows, and answers OpenCode's own
// Subagents commands, so their keys (up, down, return, ctrl+a, interrupt) keep working as configured.
import type { Plugin } from "@opencode/plugin/tui"
import type { SessionInfo } from "@opencode/client"
import { TextAttributes, type BaseRenderable, type ScrollBoxRenderable } from "@opentui/core"
import { createEffect, createMemo, createSignal, getOwner, Index, on, onCleanup, onMount, Show } from "solid-js"
import { findComposer, hideTabBodies, placeInComposer, removeFromComposer, type ComposerApi } from "./composer"
import { modelOf, modelText, rowLabel, sessionFamily } from "./family"

type Context = Plugin.Context

const ID = "subagents"
const LABEL = "Subagents"

interface Entry {
  readonly sessionID: string
  readonly prefix: string
  readonly agent: string
  readonly title: string
  readonly model?: string
  readonly variant?: string
  readonly running: boolean
  readonly current: boolean
}

export function SubagentsTab(props: {
  readonly context: Context
  readonly sessionID: () => string
  readonly anchor: () => BaseRenderable | undefined
}) {
  const context = props.context
  const data = context.data
  const theme = () => context.theme
  const owner = getOwner()
  const [api, setApi] = createSignal<ComposerApi>()
  const active = () => api()?.active(ID) ?? false
  const [selected, setSelected] = createSignal(0)
  // Like OpenCode's: kept for this TUI's lifetime, changed only by ctrl+a.
  const [filter, updateFilter] = context.storage.memory("subagents-filter", { initial: { active: true } })
  let scroll: ScrollBoxRenderable | undefined

  const route = () => {
    const current = context.ui.router.current()
    return current.type === "session" ? current.sessionID : undefined
  }

  const entries = createMemo((): Entry[] => {
    const current = data.session.get(props.sessionID())
    if (!current) return []
    return sessionFamily<SessionInfo>(data.session.list(), current.id)
      .map(({ session, prefix }): Entry => {
        const label = rowLabel(session)
        const ref = modelOf(
          session,
          () => data.session.message.list(session.id),
          () => data.location.agent.list(session.location),
        )
        const text = ref ? modelText(ref, data.location.model.list(session.location)) : undefined
        return {
          sessionID: session.id,
          prefix,
          agent: label.agent,
          title: label.title,
          model: text?.model,
          variant: text?.variant,
          running: data.session.status(session.id) === "running",
          current: session.id === route(),
        }
      })
      .filter((entry) => (filter.active ? entry.running : !entry.running))
  })
  const selectedEntry = () => entries()[selected()]

  // Model names and agents come from each location's lists; load the ones not loaded yet.
  createEffect(() => {
    const current = data.session.get(props.sessionID())
    if (!current || !active()) return
    const location = current.location
    if (!data.location.model.list(location)) void data.location.model.sync(location).catch(() => {})
    if (!data.location.agent.list(location)) void data.location.agent.sync(location).catch(() => {})
  })

  const moveTo = (index: number, center = false) => {
    setSelected(index)
    if (!scroll) return
    const height = scroll.viewport.height
    if (center) scroll.scrollTo(Math.max(0, index - Math.floor(height / 2)))
    else if (index >= scroll.scrollTop + height) scroll.scrollTo(index - height + 1)
    else if (index < scroll.scrollTop) scroll.scrollTo(index)
  }

  const open = (entry: Entry | undefined) => {
    if (entry) context.ui.router.navigate({ type: "session", sessionID: entry.sessionID })
  }

  // OpenCode draws its own list each time the tab shows; hide it then.
  const panels: BaseRenderable[] = []
  const hidden: BaseRenderable[] = []
  const hideBuiltIn = () => {
    const anchor = props.anchor()
    if (!anchor || !active()) return
    hidden.push(...hideTabBodies(anchor, panels))
  }

  createEffect(
    on(active, (isActive) => {
      if (!isActive) return
      const index = entries().findIndex((entry) => entry.current)
      moveTo(index >= 0 ? index : 0, true)
      hideBuiltIn()
      setTimeout(hideBuiltIn, 0)
    }),
  )
  createEffect(() => {
    if (selected() >= entries().length) setSelected(Math.max(0, entries().length - 1))
  })

  const shortcut = (id: string) => context.keymap.shortcuts(id)[0] ?? ""
  const hints = () => [
    ...(selectedEntry()?.running ? [{ label: "interrupt", shortcut: shortcut("composer.subagent.interrupt") }] : []),
    {
      label: `show ${filter.active ? "inactive" : "active"}`,
      shortcut: shortcut("composer.subagent.toggle-activity"),
    },
  ]

  // OpenCode's command IDs, above its Subagents layer (priority 1), so its configured keys reach these.
  context.keymap.layer(() => ({
    mode: "composer",
    enabled: active,
    priority: 2,
    commands: [
      {
        id: "composer.subagent.up",
        title: "Previous subagent",
        group: "Composer",
        bind: false,
        run: () => {
          if (selected() === 0) {
            api()?.close()
            return
          }
          moveTo(selected() - 1, true)
        },
      },
      {
        id: "composer.subagent.down",
        title: "Next subagent",
        group: "Composer",
        bind: false,
        run: () => {
          const count = entries().length
          if (count > 0) moveTo((selected() + 1) % count, true)
        },
      },
      {
        id: "composer.subagent.select",
        title: "Navigate to subagent",
        group: "Composer",
        bind: false,
        run: () => open(selectedEntry()),
      },
      {
        id: "composer.subagent.toggle-activity",
        title: "Toggle active subagents",
        group: "Composer",
        bind: false,
        run: () => {
          updateFilter((draft) => {
            draft.active = !draft.active
          })
          setSelected(0)
          scroll?.scrollTo(0)
        },
      },
      {
        id: "composer.subagent.interrupt",
        title: "Interrupt subagent",
        group: "Composer",
        bind: false,
        run: () => {
          const entry = selectedEntry()
          if (entry?.running) void context.client.session.interrupt({ sessionID: entry.sessionID }).catch(() => {})
        },
      },
    ],
  }))

  const panel = (
    <box flexDirection="column" flexShrink={0} visible={active()}>
      <scrollbox
        scrollbarOptions={{ visible: false }}
        maxHeight={5}
        ref={(node: ScrollBoxRenderable) => (scroll = node)}
      >
        <Show
          when={entries().length > 0}
          fallback={<text fg={theme().text.muted}> No {filter.active ? "active" : "inactive"} subagents</text>}
        >
          {/* Index, not For: entries are new objects each time, and For would redraw every row on each change. */}
          <Index each={entries()}>
            {(entry, index) => {
              const focused = createMemo(() => index === selected())
              const foreground = () =>
                focused()
                  ? theme().text.action.primary.focused
                  : entry().current
                    ? theme().text.action.primary.selected
                    : theme().text.action.primary.base
              const quiet = () => (focused() ? theme().text.action.primary.focused : theme().text.muted)
              return (
                <box
                  flexDirection="row"
                  gap={2}
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={
                    focused()
                      ? theme().background.action.primary.focused
                      : entry().current
                        ? theme().background.action.primary.selected
                        : theme().background.action.primary.base
                  }
                  onMouseMove={() => setSelected(index)}
                  onMouseUp={() => {
                    setSelected(index)
                    open(entry())
                  }}
                >
                  <box flexGrow={1} flexShrink={1} minWidth={0} flexDirection="row">
                    <text
                      fg={foreground()}
                      attributes={focused() ? TextAttributes.BOLD : undefined}
                      wrapMode="none"
                      truncate
                    >
                      {entry().prefix}
                      {entry().agent}: {entry().title}
                    </text>
                  </box>
                  <Show when={entry().model}>
                    <text wrapMode="none" flexShrink={0}>
                      <span style={{ fg: quiet() }}>{entry().model}</span>
                      <Show when={entry().variant}>
                        <span style={{ fg: quiet() }}> · </span>
                        <span style={{ fg: focused() ? quiet() : theme().text.feedback.warning.base }}>
                          {entry().variant}
                        </span>
                      </Show>
                    </text>
                  </Show>
                  <Show when={entry().running}>
                    <text fg={quiet()} wrapMode="none" flexShrink={0}>
                      Running
                    </text>
                  </Show>
                </box>
              )
            }}
          </Index>
        </Show>
      </scrollbox>
    </box>
  ) as unknown as BaseRenderable
  panels.push(panel)

  let disposed = false
  onMount(() => {
    let attempts = 0
    const attach = () => {
      if (disposed) return
      attempts++
      const composer = api() ?? findComposer(owner)
      const anchor = props.anchor()
      if (composer && !api()) {
        // Same ID: replaces OpenCode's registration in place, keeping the tab's position and default.
        composer.register({ id: ID, label: LABEL, hints })
        setApi(composer)
      }
      if (composer && anchor && placeInComposer(anchor, panel, LABEL)) {
        hideBuiltIn()
        return
      }
      if (attempts < 40) {
        setTimeout(attach, 25)
        return
      }
      // Without a place for our list, hand the tab back to OpenCode's.
      giveBack()
    }
    // After OpenCode's tabs register, so ours replaces its registration.
    setTimeout(attach, 0)
  })

  const giveBack = () => {
    const composer = api()
    setApi(undefined)
    for (const node of hidden.splice(0)) {
      try {
        if (!(node as unknown as { isDestroyed?: boolean }).isDestroyed) node.visible = true
      } catch {}
    }
    // OpenCode's list draws again. Its footer hints come back when the session's composer is next created.
    composer?.register({ id: ID, label: LABEL })
  }

  onCleanup(() => {
    disposed = true
    giveBack()
    removeFromComposer(panel)
  })
  return null
}
