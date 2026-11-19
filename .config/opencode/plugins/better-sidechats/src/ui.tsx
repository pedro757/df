// What the plugin draws: the Sidechats composer tab, the banner in a sidechat, the prompt footer status and the
// /sidechats dialog.
import type { Plugin } from "@opencode/plugin/tui"
import { TextAttributes, type BaseRenderable, type ScrollBoxRenderable } from "@opentui/core"
import { createEffect, createMemo, createSignal, For, getOwner, on, onCleanup, onMount, Show } from "solid-js"
import {
  composerTabs,
  findComposer,
  isLastTab,
  placeInComposer,
  removeFromComposer,
  type ComposerApi,
} from "./composer"
import { DEFAULT_TITLE, type Sidechat } from "./meta"
import type { Options } from "./options"
import type { SidechatEntry, Sidechats } from "./state"
import { SubagentsTab } from "./subagents"

type Context = Plugin.Context

export const TAB_ID = "sidechats"

type Row =
  | { readonly kind: "main"; readonly sessionID: string; readonly title: string }
  | { readonly kind: "sidechat"; readonly sessionID: string; readonly title: string; readonly entry: SidechatEntry }
  | { readonly kind: "new" }

function ago(time: number) {
  const seconds = Math.max(0, (Date.now() - time) / 1000)
  if (seconds < 60) return "now"
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86_400)}d`
}

export function createUI(context: Context, store: Sidechats, options: Options) {
  const { data } = context
  const theme = () => context.theme

  const toastError = (error: unknown) =>
    context.ui.toast.show({ title: "Sidechats", message: store.errorMessage(error), variant: "error" })

  const running = (sessionID: string) =>
    data.session.family(sessionID).some((id) => data.session.status(id) === "running")

  const status = (entry: SidechatEntry): { readonly text: string; readonly warn?: boolean } => {
    if (store.waiting(entry.session.id)) return { text: "Needs you", warn: true }
    if (running(entry.session.id)) return { text: "Running" }
    if (entry.sidechat.broughtBack) return { text: "Brought back" }
    return { text: ago(entry.session.time.updated) }
  }

  const shortcut = (id: string, fallback: string) =>
    context.keymap.shortcuts(id)[0] ?? (fallback === "none" ? "" : fallback)

  async function newSidechat(fromID: string, question?: string) {
    try {
      await store.create(fromID, question)
    } catch (error) {
      toastError(error)
    }
  }

  async function bringBack(sessionID: string) {
    const blocker = store.bringBackBlocker(sessionID)
    if (blocker) {
      context.ui.toast.show({ title: "Bring back", message: blocker, variant: "warning" })
      return
    }
    try {
      const result = await store.bringBack(sessionID)
      context.ui.toast.show({
        title: "Brought back",
        message: `The main session gets this sidechat${result.omitted ? " (newest messages)" : ""} with your next message there.`,
        variant: "success",
      })
    } catch (error) {
      context.ui.toast.show({ title: "Bring back", message: store.errorMessage(error), variant: "warning" })
    }
  }

  async function remove(sessionID: string) {
    const title = data.session.get(sessionID)?.title ?? DEFAULT_TITLE
    try {
      await store.remove(sessionID)
      context.ui.toast.show({ message: `Deleted sidechat "${title}"`, variant: "success" })
    } catch (error) {
      toastError(error)
    }
  }

  /** Banner shown in a sidechat, above the prompt: what it is and whose it is. Click it to go to the main session. */
  function Banner(props: { readonly sessionID: string }) {
    const sidechat = createMemo(() => store.sidechatFor(props.sessionID))
    createEffect(() => {
      const parentID = sidechat()?.parentID
      if (parentID && !data.session.get(parentID)) void data.session.sync(parentID).catch(() => {})
    })
    const parentTitle = () => {
      const parentID = sidechat()?.parentID
      return (parentID && data.session.get(parentID)?.title) || "the main session"
    }
    const key = () => shortcut("sidechats.parent", options.keybinds.parent)
    return (
      <Show when={sidechat()}>
        {(current: () => Sidechat) => (
          <box
            flexDirection="row"
            flexShrink={0}
            gap={2}
            paddingLeft={1}
            paddingRight={1}
            onMouseUp={() => context.ui.router.navigate({ type: "session", sessionID: current().parentID })}
          >
            <text wrapMode="none" truncate flexGrow={1} flexShrink={1} minWidth={0}>
              <span style={{ fg: theme().hue.accent[200], bold: true }}>Sidechat</span>
              <span style={{ fg: theme().text.muted }}> of </span>
              <span style={{ fg: theme().text.base }}>{parentTitle()}</span>
            </text>
            <Show when={key()}>
              <text wrapMode="none" flexShrink={0}>
                <span style={{ fg: theme().text.base }}>{key()}</span>
                <span style={{ fg: theme().text.muted }}> main session</span>
              </text>
            </Show>
          </box>
        )}
      </Show>
    )
  }

  /**
   * The Sidechats tab of the session composer. Registers with the composer's tab registry and moves its body into the
   * composer's box; see composer.ts. Renders nothing where it is mounted.
   */
  function ComposerTab(props: { readonly sessionID: () => string; readonly anchor: () => BaseRenderable | undefined }) {
    const owner = getOwner()
    const [api, setApi] = createSignal<ComposerApi>()
    const active = () => api()?.active(TAB_ID) ?? false
    const [selected, setSelected] = createSignal(0)
    const [confirm, setConfirm] = createSignal<string>()
    let scroll: ScrollBoxRenderable | undefined

    const rows = createMemo((): Row[] => {
      const sessionID = props.sessionID()
      const mainID = store.mainOf(sessionID)
      const result: Row[] = []
      if (mainID !== data.session.root(sessionID))
        result.push({ kind: "main", sessionID: mainID, title: data.session.get(mainID)?.title ?? "Main session" })
      for (const entry of store.list(mainID))
        result.push({
          kind: "sidechat",
          sessionID: entry.session.id,
          title: entry.session.title ?? DEFAULT_TITLE,
          entry,
        })
      result.push({ kind: "new" })
      return result
    })
    const currentRoot = () => data.session.root(props.sessionID())
    const selectedRow = () => rows()[selected()]

    const moveTo = (index: number, center = false) => {
      setSelected(index)
      setConfirm(undefined)
      if (!scroll) return
      const height = scroll.viewport.height
      if (center) scroll.scrollTo(Math.max(0, index - Math.floor(height / 2)))
      else if (index >= scroll.scrollTop + height) scroll.scrollTo(index - height + 1)
      else if (index < scroll.scrollTop) scroll.scrollTo(index)
    }

    // On opening, select the session you are in, like the Subagents tab.
    createEffect(
      on(active, (isActive) => {
        setConfirm(undefined)
        if (!isActive) return
        void store.load(store.mainOf(props.sessionID()), 5_000).catch(() => {})
        const index = rows().findIndex((row) => row.kind !== "new" && row.sessionID === currentRoot())
        moveTo(index >= 0 ? index : 0, true)
      }),
    )
    createEffect(() => {
      if (selected() >= rows().length) setSelected(Math.max(0, rows().length - 1))
    })

    const open = (row: Row | undefined) => {
      if (!row) return
      if (row.kind === "new") {
        api()?.close()
        void newSidechat(store.mainOf(props.sessionID()))
        return
      }
      if (row.sessionID === currentRoot()) {
        api()?.close()
        return
      }
      context.ui.router.navigate({ type: "session", sessionID: row.sessionID })
    }

    const hints = () => {
      const row = selectedRow()
      if (row?.kind !== "sidechat") return []
      return [
        { label: "bring back", shortcut: shortcut("sidechats.composer.bring_back", options.keybinds.tabBringBack) },
        { label: "delete", shortcut: shortcut("sidechats.composer.delete", options.keybinds.tabDelete) },
      ].filter((hint) => hint.shortcut)
    }

    context.keymap.layer(() => ({
      mode: "composer",
      enabled: active,
      priority: 1,
      commands: [
        {
          id: "sidechats.composer.up",
          title: "Previous sidechat",
          group: "Composer",
          bind: "up",
          run: () => {
            if (selected() === 0) {
              api()?.close()
              return
            }
            moveTo(selected() - 1)
          },
        },
        {
          id: "sidechats.composer.down",
          title: "Next sidechat",
          group: "Composer",
          bind: "down",
          run: () => moveTo((selected() + 1) % Math.max(1, rows().length)),
        },
        {
          id: "sidechats.composer.select",
          title: "Open sidechat",
          group: "Composer",
          bind: "return",
          run: () => open(selectedRow()),
        },
        {
          id: "sidechats.composer.bring_back",
          title: "Bring sidechat back",
          group: "Composer",
          bind: options.keybinds.tabBringBack === "none" ? false : options.keybinds.tabBringBack,
          run: () => {
            const row = selectedRow()
            if (row?.kind === "sidechat") void bringBack(row.sessionID)
          },
        },
        {
          id: "sidechats.composer.delete",
          title: "Delete sidechat",
          group: "Composer",
          bind: options.keybinds.tabDelete === "none" ? false : options.keybinds.tabDelete,
          run: () => {
            const row = selectedRow()
            if (row?.kind !== "sidechat") return
            if (confirm() !== row.sessionID) {
              setConfirm(row.sessionID)
              return
            }
            setConfirm(undefined)
            void remove(row.sessionID)
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
          <For each={rows()}>
            {(row, index) => {
              const focused = createMemo(() => index() === selected())
              const current = () => row.kind !== "new" && row.sessionID === currentRoot()
              const deleting = () => row.kind === "sidechat" && confirm() === row.sessionID
              const state = createMemo(() => (row.kind === "sidechat" ? status(row.entry) : undefined))
              const label = () => {
                if (row.kind === "new") return store.busy() > 0 ? "Opening sidechat…" : "+ New sidechat"
                if (deleting())
                  return `Press ${shortcut("sidechats.composer.delete", options.keybinds.tabDelete)} again to delete`
                if (row.kind === "main") return `Main: ${row.title}`
                return row.title
              }
              const background = () => {
                if (deleting()) return theme().background.action.destructive.focused
                if (focused()) return theme().background.action.primary.focused
                if (current()) return theme().background.action.primary.selected
                return theme().background.action.primary.base
              }
              const foreground = () => {
                if (deleting()) return theme().text.action.destructive.focused
                if (focused()) return theme().text.action.primary.focused
                if (current()) return theme().text.action.primary.selected
                return theme().text.action.primary.base
              }
              return (
                <box
                  flexDirection="row"
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={background()}
                  onMouseMove={() => setSelected(index())}
                  onMouseUp={() => {
                    setSelected(index())
                    open(row)
                  }}
                >
                  <box flexGrow={1} minWidth={0} flexDirection="row">
                    <text
                      fg={foreground()}
                      attributes={focused() ? TextAttributes.BOLD : undefined}
                      wrapMode="none"
                      truncate
                    >
                      {label()}
                    </text>
                  </box>
                  <Show when={state()}>
                    {(value) => (
                      <text
                        fg={
                          value().warn
                            ? theme().text.feedback.warning.base
                            : focused()
                              ? theme().text.action.primary.focused
                              : theme().text.muted
                        }
                        wrapMode="none"
                        flexShrink={0}
                      >
                        {value().text}
                      </text>
                    )}
                  </Show>
                </box>
              )
            }}
          </For>
        </scrollbox>
      </box>
    ) as unknown as BaseRenderable

    let unregister: (() => void) | undefined
    let disposed = false
    const register = (composer: ComposerApi) => {
      unregister?.()
      unregister = composer.register({ id: TAB_ID, label: options.label, hints })
    }
    // Registering again moves the tab to the end, after a tab that registered later than it did. The composer then
    // goes back to its default tab, so show the one that was showing.
    const keepLast = () => {
      const composer = api()
      const anchor = props.anchor()
      if (!composer || !anchor || isLastTab(anchor, panel, options.label) !== false) return
      const showing = composerTabs(anchor, panel)?.find((tab) => tab.active)?.label
      register(composer)
      if (!showing) return
      // Our new label has no text until it is drawn, so look a few times.
      const restore = (attempt: number) =>
        setTimeout(
          () => {
            const tab = composerTabs(anchor, panel)?.find((item) => item.label === showing)
            if (tab && !tab.active) tab.select()
            if (!tab && attempt < 8) restore(attempt + 1)
          },
          attempt === 0 ? 0 : 25,
        )
      restore(0)
    }
    onMount(() => {
      let attempts = 0
      const attach = () => {
        if (disposed) return
        attempts++
        if (!unregister) {
          const found = findComposer(owner)
          if (found) {
            register(found)
            setApi(found)
          }
        }
        const anchor = props.anchor()
        if (unregister && anchor && placeInComposer(anchor, panel, options.label)) {
          keepLast()
          return
        }
        if (attempts < 40) {
          setTimeout(attach, 25)
          return
        }
        // A tab without its body would be an empty tab: take it back out.
        unregister?.()
        unregister = undefined
        setApi(undefined)
      }
      // After the built-in tabs register, so Sidechats comes last and none of them loses the default.
      setTimeout(attach, 0)
    })
    // The composer pushes its mode when it opens, before any key reaches it.
    createEffect(
      on(
        () => context.keymap.mode.current() === "composer",
        (open) => {
          if (open) keepLast()
        },
      ),
    )
    onCleanup(() => {
      disposed = true
      unregister?.()
      removeFromComposer(panel)
    })
    return null
  }

  // The newest session's slot, for the composer keys (src/keys.ts).
  const [composerAnchor, setComposerAnchor] = createSignal<BaseRenderable>()

  /** Everything this plugin puts above the composer. Its box anchors the search for the composer. */
  function ComposerTop(props: { readonly input: { readonly sessionID: string } }) {
    const [anchor, setAnchor] = createSignal<BaseRenderable>()
    onCleanup(() => {
      if (composerAnchor() === anchor()) setComposerAnchor(undefined)
    })
    return (
      <box
        ref={(node: BaseRenderable) => {
          setAnchor(node)
          setComposerAnchor(node)
        }}
        flexShrink={0}
      >
        <Banner sessionID={props.input.sessionID} />
        <Show when={options.composerTab}>
          <ComposerTab sessionID={() => props.input.sessionID} anchor={anchor} />
        </Show>
        <Show when={options.subagentsTab}>
          <SubagentsTab context={context} sessionID={() => props.input.sessionID} anchor={anchor} />
        </Show>
      </box>
    )
  }

  /** Prompt footer: sidechats of this session that are running or wait on you. */
  function FooterStatus(props: { readonly input: { readonly sessionID?: string; readonly mode: string } }) {
    const counts = createMemo(() => {
      const sessionID = props.input.sessionID
      if (!sessionID || props.input.mode !== "normal") return
      const root = data.session.root(sessionID)
      const entries = store.list(store.mainOf(sessionID)).filter((entry) => entry.session.id !== root)
      const waiting = entries.filter((entry) => store.waiting(entry.session.id)).length
      const busy = entries.filter((entry) => !store.waiting(entry.session.id) && running(entry.session.id)).length
      if (!waiting && !busy && store.busy() === 0) return
      return { waiting, busy, opening: store.busy() > 0 }
    })
    const plural = (count: number) => (count === 1 ? "sidechat" : "sidechats")
    return (
      <Show when={counts()}>
        {(value) => (
          <text wrapMode="none" flexShrink={0}>
            <Show when={value().opening}>
              <span style={{ fg: theme().text.muted }}>opening sidechat… </span>
            </Show>
            <Show when={value().waiting}>
              <span style={{ fg: theme().text.feedback.warning.base }}>
                ! {value().waiting} {plural(value().waiting)} need{value().waiting === 1 ? "s" : ""} you{" "}
              </span>
            </Show>
            <Show when={value().busy}>
              <span style={{ fg: theme().text.muted }}>
                {value().busy} {plural(value().busy)} running
              </span>
            </Show>
          </text>
        )}
      </Show>
    )
  }

  const NEW = "\u0000new"

  /** The sidechats of the current session as a dialog: /sidechats, and the fallback when the composer tab is missing. */
  async function openDialog() {
    const sessionID = store.currentSessionID()
    if (!sessionID) {
      context.ui.toast.show({ message: "Open a session first", variant: "warning" })
      return
    }
    const mainID = store.mainOf(sessionID)
    await store.load(mainID).catch(() => {})
    const root = data.session.root(sessionID)
    const entries = store.list(mainID)
    const mainTitle = data.session.get(mainID)?.title ?? "Main session"
    const reopen = () => setTimeout(() => void openDialog(), 0)
    const value = await context.ui.dialog.select<string>({
      title: "Sidechats",
      placeholder: "Search sidechats",
      current: root,
      options: [
        ...(root !== mainID ? [{ title: mainTitle, value: mainID, category: "Main session" }] : []),
        ...entries.map((entry) => ({
          title: entry.session.title ?? DEFAULT_TITLE,
          value: entry.session.id,
          footer: status(entry).text,
          category: "Sidechats",
        })),
        { title: "+ New sidechat", value: NEW, category: "Sidechats" },
      ],
      actions: [
        ...(options.keybinds.tabBringBack === "none"
          ? []
          : [
              {
                bind: options.keybinds.tabBringBack,
                title: "bring back",
                onTrigger: (value: string) => {
                  if (value === NEW || value === mainID) return
                  context.ui.dialog.clear()
                  void bringBack(value)
                },
              },
            ]),
        ...(options.keybinds.tabDelete === "none"
          ? []
          : [
              {
                bind: options.keybinds.tabDelete,
                title: "delete",
                onTrigger: (value: string) => {
                  if (value === NEW || value === mainID) return
                  const title = data.session.get(value)?.title ?? DEFAULT_TITLE
                  context.ui.dialog.clear()
                  void context.ui.dialog
                    .confirm({ title: "Delete sidechat", message: `Delete "${title}"?`, label: { confirm: "Delete" } })
                    .then(async (confirmed) => {
                      if (confirmed) await remove(value)
                      reopen()
                    })
                },
              },
            ]),
      ],
    })
    if (!value) return
    if (value === NEW) {
      await newSidechat(mainID)
      return
    }
    if (value !== root) context.ui.router.navigate({ type: "session", sessionID: value })
  }

  return { ComposerTop, FooterStatus, openDialog, newSidechat, bringBack, remove, composerAnchor }
}
