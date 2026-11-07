// A port of the TUI's DialogSelect (ui/dialog-select.tsx, legacy design) for this plugin. External
// plugins cannot import host components, so the rows, keyboard and mouse behavior are mirrored here.
import { CliRenderEvents, InputRenderable, RGBA, ScrollBoxRenderable, TextAttributes, type KeyEvent } from "@opentui/core"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
  untrack,
  type JSX,
} from "solid-js"
import { createStore } from "solid-js/store"
import { usePlugin } from "@opencode/plugin/tui"
import type { KeymapCommand } from "@opencode/plugin/tui/context"
import { cursorStyle, scrollAcceleration, type CliConfig } from "./config"
import { assignJumpLabels, halfPage } from "./navigate"
import {
  DIALOG_INSET,
  DIALOG_LIST_INSET,
  DialogBleed,
  DialogFooter,
  DialogHeader,
  DialogLayout,
  transparent,
  useDialogTheme,
  type FooterAction,
} from "./ui"
import { joinShortcuts, moveSelection, reconcileSelection, same, truncate } from "./util"

export interface SelectOption<T> {
  title: string
  value: T
  description?: string
  footer?: JSX.Element | string
  footerColor?: RGBA
  category?: string
  disabled?: boolean
  bg?: RGBA
  fg?: RGBA
  gutter?: (color: RGBA) => JSX.Element
}

type ActionBase<T> = {
  /** Keymap command id. Configured keybinds for the id apply; `bind` is the fallback. */
  command: string
  title: string | ((option: SelectOption<T> | undefined) => string)
  bind?: string
  side?: "left" | "right"
  hidden?: boolean
  disabled?: boolean | ((option: SelectOption<T> | undefined) => boolean)
  /** Why the action is unavailable for the selected option. Greys it out; pressing it shows the reason. */
  blocked?: (option: SelectOption<T>) => string | undefined
}

export type SelectAction<T> =
  | (ActionBase<T> & { selection?: "required"; onTrigger: (option: SelectOption<T>) => void })
  | (ActionBase<T> & { selection: "none"; onTrigger: () => void })

export type SelectHint = { title: string; label: string; side?: "left" | "right" }

export interface SelectRef<T> {
  readonly selected: SelectOption<T> | undefined
  moveTo(value: T): void
}

// The mounted lists, newest last. The session-list command toggles jump labels on the top one instead of
// reopening the dialog.
const jumpers: (() => void)[] = []

/** Toggles jump labels on the newest mounted list. Returns false when no list is mounted. */
export function toggleJump() {
  const toggle = jumpers.at(-1)
  if (!toggle) return false
  toggle()
  return true
}

/** The character a key press types, if any. Modified keys and named keys such as `return` type nothing. */
function typedCharacter(event: KeyEvent) {
  if (event.ctrl || event.meta || event.super || event.hyper) return undefined
  const sequence = event.sequence
  if (sequence && [...sequence].length === 1 && sequence >= " " && sequence !== "\x7f") return sequence
  if (event.name.length === 1) return event.shift ? event.name.toUpperCase() : event.name
  return undefined
}

export interface SelectProps<T> {
  title: string
  titleView?: JSX.Element
  /** Rendered between the title row and the search input, e.g. tabs. */
  headerExtra?: JSX.Element
  placeholder?: string
  /** Hides the search input, for short pickers. */
  renderFilter?: boolean
  initialFilter?: string
  options: SelectOption<T>[]
  current?: T
  /** Selected on mount instead of `current`, e.g. to restore the selection after a sub-view. */
  focus?: T
  /** Changes when the option set is replaced wholesale (a tab switch): selection resets to `current` or the top. */
  resetKey?: unknown
  /** Rows taken by extra header or footer content, subtracted from the list height. */
  reservedRows?: number
  config: CliConfig
  emptyView?: JSX.Element
  noMatchView?: JSX.Element
  actions?: SelectAction<T>[]
  footerHints?: SelectHint[]
  bindings?: readonly KeymapCommand[]
  ref?: (ref: SelectRef<T>) => void
  onMove?: (option: SelectOption<T>) => void
  onFilter?: (query: string) => void
  onSelect?: (option: SelectOption<T>) => void
  /** Adds an escape binding that runs this instead of closing the dialog. */
  onCancel?: () => void
  /** Keys for vim-style half-page scrolling (CTRL-D / CTRL-U). */
  halfPageKeys?: { readonly down: string; readonly up: string }
  /** Key that toggles jump labels. */
  jumpKey?: string
}

export function Select<T>(props: SelectProps<T>) {
  type Action = SelectAction<T>
  const context = usePlugin()
  const theme = useDialogTheme()
  const renderer = useRenderer()
  const acceleration = createMemo(() => scrollAcceleration(props.config))

  const [store, setStore] = createStore({ selected: 0, filter: props.initialFilter ?? "" })
  let selection: { value: T; category?: string } | undefined
  let resetSelection = false
  // Whether the user moved the selection. Until then, a list opened without a current option keeps the top row
  // selected while sessions load in, instead of following whichever row happened to be first.
  let touched = false
  let pendingScroll: (() => void) | undefined
  let input: InputRenderable | undefined
  let scroll: ScrollBoxRenderable | undefined

  const filtered = createMemo(() => props.options.filter((option) => option.disabled !== true))
  const grouped = createMemo<[string, SelectOption<T>[]][]>(() => {
    const groups = new Map<string, SelectOption<T>[]>()
    for (const option of filtered()) {
      const key = option.category ?? ""
      const list = groups.get(key)
      if (list) list.push(option)
      else groups.set(key, [option])
    }
    return [...groups.entries()]
  })
  const flat = createMemo(() => grouped().flatMap(([, options]) => options))
  const selected = createMemo(() => flat()[store.selected])

  const rows = createMemo(() => {
    const headers = grouped().reduce((acc, [category], index) => (category ? acc + (index > 0 ? 2 : 1) : acc), 0)
    return flat().length + headers
  })
  const dimensions = useTerminalDimensions()
  const limit = createMemo(() => Math.max(3, Math.floor(dimensions().height / 2) - 6 - (props.reservedRows ?? 0)))
  const height = createMemo(() => Math.min(rows(), limit()))

  function scrollAfterLayout(center: boolean, value: T) {
    if (pendingScroll) renderer.off(CliRenderEvents.FRAME, pendingScroll)
    pendingScroll = () => {
      pendingScroll = undefined
      if (!same(selected()?.value, value)) return
      scrollToSelection(center)
    }
    renderer.once(CliRenderEvents.FRAME, pendingScroll)
    renderer.requestRender()
  }
  onCleanup(() => {
    if (!pendingScroll) return
    renderer.off(CliRenderEvents.FRAME, pendingScroll)
    pendingScroll = undefined
  })

  function focusIndex(value: T | undefined) {
    if (value === undefined) return -1
    return flat().findIndex((option) => same(option.value, value))
  }

  // Focus the current option when it appears, centered. On mount and when the option set is replaced
  // (resetKey), the `focus` option wins, so a sub-view can hand the selection back.
  createEffect(
    on([() => props.current, () => props.resetKey], ([current, key], previous) => {
      const reset = previous === undefined || previous[1] !== key
      const target = reset ? (untrack(() => props.focus) ?? current) : current
      const index = focusIndex(target)
      if (index >= 0) {
        setStore("selected", index)
        selection = flat()[index]
        scrollAfterLayout(true, target as T)
        return
      }
      if (!reset || previous === undefined) return
      // A new tab without the focused session starts at the top.
      setStore("selected", 0)
      selection = flat()[0]
      if (scroll && !scroll.isDestroyed) scroll.scrollTo(0)
    }),
  )

  // Keep the selected option selected while the list updates around it (DialogSelect's logic).
  createEffect(
    on(
      () => props.options,
      () => {
        if ((props.focus ?? props.current) === undefined) {
          const count = flat().length
          if (count === 0) return
          if (selection && touched) {
            const index = focusIndex(selection.value)
            if (index >= 0) {
              setStore("selected", index)
              selection = flat()[index]
              return
            }
          }
          const next = reconcileSelection(store.selected, count)
          if (next !== store.selected) setStore("selected", next)
          selection = flat()[next]
          return
        }
        if (resetSelection && store.filter.length > 0) {
          const option = flat()[0]
          if (!option) return
          setStore("selected", 0)
          selection = option
          return
        }
        if (!selection) {
          const index = focusIndex(props.focus ?? props.current)
          if (index >= 0) {
            setStore("selected", index)
            selection = flat()[index]
            return
          }
          const option = selected()
          if (!option) return
          selection = option
          return
        }
        const previous = selection
        const index = focusIndex(previous.value)
        if (index >= 0) {
          const option = flat()[index]!
          const moved = index !== store.selected || option.category !== previous.category
          setStore("selected", index)
          selection = option
          if (!moved || store.filter.length > 0) return
          scrollAfterLayout(false, option.value)
          return
        }
        if (flat().length === 0) return
        const next = reconcileSelection(store.selected, flat().length)
        setStore("selected", next)
        selection = flat()[next]
      },
    ),
  )

  createEffect(
    on([() => store.filter, () => props.current], ([filter, current]) => {
      if (filter.length > 0) resetSelection = true
      if (filter.length > 0) {
        const option = flat()[0]
        if (!option) return
        moveTo(0, true, false, false)
        scrollAfterLayout(true, option.value)
        return
      }
      if (current === undefined) return
      const index = focusIndex(current)
      if (index < 0) return
      moveTo(index, true, true, false)
      scrollAfterLayout(true, current)
    }, { defer: true }),
  )

  function move(direction: number) {
    if (flat().length === 0) return
    moveTo(moveSelection(store.selected, { count: flat().length, delta: direction, policy: "wrap" }), true)
  }

  function moveTo(next: number, center = false, preserve = true, user = true) {
    select(next, preserve, user)
    scrollToSelection(center)
  }

  function select(next: number, preserve = true, user = true) {
    if (user) touched = true
    setStore("selected", next)
    const option = selected()
    if (option) {
      selection = option
      resetSelection = !preserve
      props.onMove?.(option)
    }
  }

  /** Each option's row, by flat index, with its line relative to the top of the visible list. */
  function rowLines() {
    if (!scroll || scroll.isDestroyed) return []
    const children = scroll.getChildren()
    const result: { index: number; line: number }[] = []
    let child = 0
    let index = 0
    for (const [category, options] of grouped()) {
      if (category) child++
      for (let item = 0; item < options.length; item++) {
        const row = children[child++]
        if (row) result.push({ index, line: row.y - scroll.y })
        index++
      }
    }
    return result
  }

  function scrollHalfPage(direction: 1 | -1) {
    if (!scroll || scroll.isDestroyed || flat().length === 0) return
    const rows = rowLines()
    if (rows.length !== flat().length) return
    const top = scroll.scrollTop
    const next = halfPage({
      lines: rows.map((row) => row.line + top),
      selected: store.selected,
      top,
      height: scroll.height,
      contentHeight: scroll.scrollHeight,
      direction,
    })
    select(next.index)
    scroll.scrollTo(next.top)
  }

  // Jump labels (flash.nvim): every visible row gets a label; typing it moves the selection there.
  const [jumpLabels, setJumpLabels] = createSignal<readonly { value: T; label: string }[]>()
  const labelOf = (value: T) => jumpLabels()?.find((item) => same(item.value, value))?.label

  function onJumpKey(event: KeyEvent) {
    const labels = jumpLabels()
    if (!labels) return
    const consume = () => {
      event.preventDefault()
      event.stopPropagation()
    }
    if (event.name === "escape" && !event.ctrl && !event.meta) {
      consume()
      stopJump()
      return
    }
    const typed = typedCharacter(event)
    if (typed !== undefined || event.name === "backspace" || event.name === "delete") {
      // Nothing reaches the search input while labels are shown; a key that is not a label just ends the jump.
      consume()
      const hit = labels.find((item) => item.label === typed)
      stopJump()
      if (!hit) return
      const index = focusIndex(hit.value)
      if (index >= 0) moveTo(index)
      return
    }
    // Any other key ends the jump and then does what it always does (move, settle, open, switch tab, ...).
    queueMicrotask(stopJump)
  }

  function startJump() {
    if (!scroll || scroll.isDestroyed) return
    const rows = rowLines()
    const height = scroll.height
    const cursor = rows.find((row) => row.index === store.selected)?.line ?? 0
    const visible = rows.filter((row) => row.line >= 0 && row.line < height)
    const labels = assignJumpLabels(
      visible.map((row) => ({ key: row.index, line: row.line })),
      cursor,
    ).flatMap(({ key, label }) => {
      const option = flat()[key]
      return option ? [{ value: option.value, label }] : []
    })
    if (labels.length === 0) return
    setJumpLabels(labels)
    // Ahead of the keymap's own listener, so labels win over bindings and the search input.
    renderer.keyInput.prependListener("keypress", onJumpKey)
  }

  function stopJump() {
    if (!jumpLabels()) return
    setJumpLabels(undefined)
    renderer.keyInput.off("keypress", onJumpKey)
  }

  const toggle = () => (jumpLabels() ? stopJump() : startJump())
  jumpers.push(toggle)
  onCleanup(() => {
    stopJump()
    const index = jumpers.lastIndexOf(toggle)
    if (index >= 0) jumpers.splice(index, 1)
  })
  // Labels belong to the rows on screen: a tab switch or new search replaces them.
  createEffect(on([() => props.resetKey, () => store.filter], () => stopJump(), { defer: true }))

  function scrollToSelection(center: boolean) {
    if (!scroll || scroll.isDestroyed) return
    let remaining = store.selected
    let index = 0
    // Locate the row by position, counting category headers, like DialogSelect.
    for (const [category, options] of grouped()) {
      if (category) index++
      if (remaining < options.length) {
        index += remaining
        break
      }
      index += options.length
      remaining -= options.length
    }
    const target = scroll.getChildren()[index]
    if (!target) return
    const y = target.y - scroll.y
    if (center) {
      scroll.scrollBy(y - Math.floor(scroll.height / 2))
      return
    }
    if (y >= scroll.height) scroll.scrollBy(y - scroll.height + 1)
    if (y < 0) {
      scroll.scrollBy(y)
      if (same(flat()[0]?.value, selected()?.value)) scroll.scrollTo(0)
    }
  }

  function submit() {
    const option = selected()
    if (!option) return
    props.onSelect?.(option)
  }

  const shownActions = createMemo(() => (props.actions ?? []).filter((item) => !item.hidden))

  function blockedReason(item: Action) {
    const option = selected()
    return option && item.selection !== "none" ? item.blocked?.(option) : undefined
  }

  function isDisabled(item: Action) {
    const option = selected()
    if (item.selection !== "none" && !option) return true
    if (blockedReason(item)) return true
    return typeof item.disabled === "function" ? item.disabled(option) : item.disabled === true
  }

  function trigger(item: Action | undefined) {
    if (!item) return
    const reason = blockedReason(item)
    if (reason) {
      context.ui.toast.show({ message: reason, variant: "warning" })
      return
    }
    if (isDisabled(item)) return
    if (item.selection === "none") {
      item.onTrigger()
      return
    }
    const option = selected()
    if (!option) return
    item.onTrigger(option)
  }

  context.keymap.layer(() => {
    const visible = shownActions()
    return {
      mode: "modal",
      commands: [
        { id: "dialog.select.prev", title: "Previous item", group: "Dialog", run: () => move(-1) },
        { id: "dialog.select.next", title: "Next item", group: "Dialog", run: () => move(1) },
        { id: "dialog.select.page_up", title: "Page up", group: "Dialog", run: () => move(-10) },
        { id: "dialog.select.page_down", title: "Page down", group: "Dialog", run: () => move(10) },
        { id: "dialog.select.home", title: "First item", group: "Dialog", run: () => moveTo(0) },
        { id: "dialog.select.end", title: "Last item", group: "Dialog", run: () => moveTo(flat().length - 1) },
        { id: "dialog.select.submit", title: "Select item", group: "Dialog", run: submit },
        ...(props.halfPageKeys
          ? [
              {
                id: "better_sessions.half_page_down",
                title: "Half page down",
                group: "Dialog",
                bind: props.halfPageKeys.down,
                run: () => scrollHalfPage(1),
              },
              {
                id: "better_sessions.half_page_up",
                title: "Half page up",
                group: "Dialog",
                bind: props.halfPageKeys.up,
                run: () => scrollHalfPage(-1),
              },
            ]
          : []),
        ...(props.jumpKey
          ? [
              {
                id: "better_sessions.jump",
                title: "Jump to a row",
                group: "Dialog",
                bind: props.jumpKey,
                run: () => toggle(),
              },
            ]
          : []),
        ...visible.map(
          (item): KeymapCommand => ({
            id: item.command,
            // Resolved without a selection so moving through the list does not rebuild the layer.
            title: typeof item.title === "function" ? item.title(undefined) : item.title,
            group: "Dialog",
            ...(item.bind ? { bind: item.bind } : {}),
            run: () => trigger(item),
          }),
        ),
        ...(props.bindings ?? []),
        ...(props.onCancel
          ? [
              {
                bind: "escape",
                title: "Back",
                group: "Dialog",
                run: () => {
                  if (renderer.getSelection()) {
                    renderer.clearSelection()
                    return
                  }
                  props.onCancel?.()
                },
              } satisfies KeymapCommand,
            ]
          : []),
      ],
    }
  })

  const ref: SelectRef<T> = {
    get selected() {
      return selected()
    },
    moveTo(value) {
      const index = focusIndex(value)
      if (index >= 0) moveTo(index, true)
    },
  }
  onMount(() => props.ref?.(ref))

  const footerActions = createMemo(() => {
    if (jumpLabels())
      return [
        { side: "left" as const, action: { title: "type a label to jump" } satisfies FooterAction },
        { side: "right" as const, action: { title: "cancel", key: "esc" } satisfies FooterAction },
      ]
    const actions = shownActions().flatMap((item) => {
      const label = joinShortcuts(context.keymap.shortcuts(item.command))
      if (!label) return []
      return [
        {
          side: item.side,
          action: {
            title: typeof item.title === "function" ? item.title(selected()) : item.title,
            key: label,
            disabled: isDisabled(item),
            onTrigger: () => trigger(item),
          } satisfies FooterAction,
        },
      ]
    })
    const hints = (props.footerHints ?? []).map((hint) => ({
      side: hint.side,
      action: { title: hint.title, key: hint.label } satisfies FooterAction,
    }))
    return [...actions, ...hints]
  })

  const searchInput = () => (
    <input
      flexGrow={1}
      onInput={(value: string) => {
        batch(() => {
          setStore("filter", value)
          props.onFilter?.(value)
        })
      }}
      focusedBackgroundColor={theme().background.formfield.focused}
      cursorColor={theme().text.formfield.focused}
      cursorStyle={cursorStyle(props.config)}
      focusedTextColor={theme().text.formfield.focused}
      ref={(value: InputRenderable) => {
        input = value
        input.traits = { status: "FILTER" }
        if (props.initialFilter) input.value = props.initialFilter
        setTimeout(() => {
          if (!input || value.isDestroyed) return
          value.focus()
        }, 1)
      }}
      placeholder={props.placeholder ?? "Search"}
      placeholderColor={theme().text.muted}
    />
  )

  return (
    <DialogLayout
      header={
        // Rows reserve a gutter, so the header and footer line up with the list's inset rather than the layout's.
        <box paddingLeft={DIALOG_LIST_INSET - DIALOG_INSET} paddingRight={DIALOG_LIST_INSET - DIALOG_INSET}>
          <DialogHeader title={props.title} titleView={props.titleView} onClose={props.onCancel} />
          <Show when={props.headerExtra}>
            <box paddingTop={1}>{props.headerExtra}</box>
          </Show>
          <Show when={props.renderFilter !== false}>
            <box paddingTop={1}>{searchInput()}</box>
          </Show>
        </box>
      }
      footer={
        <Show when={footerActions().length} fallback={<box flexShrink={0} />}>
          <DialogFooter
            inset={DIALOG_LIST_INSET - DIALOG_INSET}
            secondary={footerActions()
              .filter((item) => item.side !== "right")
              .map((item) => item.action)}
            primary={footerActions()
              .filter((item) => item.side === "right")
              .map((item) => item.action)}
          />
        </Show>
      }
    >
      <DialogBleed>
        <Show
          when={grouped().length > 0}
          fallback={
            <Show
              when={props.renderFilter !== false && store.filter.length > 0}
              fallback={
                props.emptyView ?? (
                  <box paddingLeft={DIALOG_LIST_INSET} paddingRight={DIALOG_LIST_INSET}>
                    <text fg={theme().text.muted}>No items available</text>
                  </box>
                )
              }
            >
              {props.noMatchView ?? (
                <box paddingLeft={DIALOG_LIST_INSET} paddingRight={DIALOG_LIST_INSET}>
                  <text fg={theme().text.muted}>No results found</text>
                </box>
              )}
            </Show>
          }
        >
          {/* The 1-cell inset keeps the row highlight off the panel edge; rows add the rest of DIALOG_LIST_INSET. */}
          <scrollbox
            paddingLeft={1}
            paddingRight={1}
            scrollbarOptions={{ visible: false }}
            scrollAcceleration={acceleration()}
            ref={(value: ScrollBoxRenderable) => {
              scroll = value
            }}
            maxHeight={height()}
          >
            <For each={grouped()}>
              {([category, options], index) => (
                <>
                  <Show when={category}>
                    <Category title={category} first={index() === 0} dim={jumpLabels() !== undefined} />
                  </Show>
                  <For each={options}>
                    {(option) => {
                      const active = createMemo(() => same(option.value, selected()?.value))
                      const current = createMemo(() => same(option.value, props.current))
                      return (
                        <box
                          flexDirection="column"
                          position="relative"
                          onMouseMove={() => {
                            const index = focusIndex(option.value)
                            if (index === -1 || index === store.selected) return
                            moveTo(index)
                          }}
                          onMouseUp={() => props.onSelect?.(option)}
                          onMouseDown={() => {
                            const index = focusIndex(option.value)
                            if (index === -1) return
                            moveTo(index)
                          }}
                        >
                          <Row
                            option={option}
                            active={active()}
                            current={current()}
                            jumping={jumpLabels() !== undefined}
                            label={labelOf(option.value)}
                          />
                        </box>
                      )
                    }}
                  </For>
                </>
              )}
            </For>
          </scrollbox>
        </Show>
      </DialogBleed>
    </DialogLayout>
  )
}

function Category(props: { title: string; first: boolean; dim: boolean }) {
  const theme = useDialogTheme()
  return (
    <box paddingTop={props.first ? 0 : 1} paddingLeft={DIALOG_LIST_INSET - 1}>
      <text fg={props.dim ? theme().text.muted : theme().hue.accent[200]} attributes={TextAttributes.BOLD}>
        {props.title}
      </text>
    </box>
  )
}

function Row<T>(props: {
  option: SelectOption<T>
  active: boolean
  current: boolean
  /** Jump labels are shown: unlabeled text steps back, like flash.nvim's backdrop. */
  jumping: boolean
  label?: string
}) {
  const theme = useDialogTheme()
  const text = createMemo(() => {
    if (props.active) return props.option.fg ?? theme().text.action.primary.focused
    if (props.jumping) return theme().text.muted
    if (props.current) return theme().text.formfield.selected
    return theme().text.base
  })
  const secondary = () => (props.active ? text() : theme().text.muted)
  const marked = () => props.label !== undefined || props.current || props.option.gutter !== undefined
  return (
    // A marker or gutter takes its cell plus the row gap out of the left padding,
    // so titles line up with unmarked rows: scroll pad (1) + marker (1) + gap (1).
    <box
      flexDirection="row"
      paddingLeft={marked() ? DIALOG_LIST_INSET - 3 : DIALOG_LIST_INSET - 1}
      paddingRight={DIALOG_LIST_INSET - 1}
      gap={1}
      backgroundColor={props.active ? (props.option.bg ?? theme().background.action.primary.focused) : transparent}
    >
      <Show
        when={props.label}
        fallback={
          <>
            <Show when={props.current && !props.option.gutter}>
              <text flexShrink={0} fg={text()}>
                ●
              </text>
            </Show>
            <Show when={props.option.gutter}>
              <box flexShrink={0}>{props.option.gutter?.(text())}</box>
            </Show>
          </>
        }
      >
        {(label) => (
          // flash.nvim overlays the label on the line start (`label.after = { 0, 0 }`, `style = "overlay"`). The colors
          // follow flash's usual pink-red FlashLabel and stay distinct from the selection highlight.
          <text
            flexShrink={0}
            fg={theme().background.base}
            bg={theme().text.feedback.error.base}
            attributes={TextAttributes.BOLD}
          >
            {label()}
          </text>
        )}
      </Show>
      <text
        flexGrow={1}
        fg={text()}
        attributes={props.active ? TextAttributes.BOLD : undefined}
        overflow="hidden"
        wrapMode="none"
        paddingLeft={3}
      >
        {truncate(props.option.title, 61)}
        <Show when={props.option.description}>
          <span style={{ fg: secondary() }}>{" " + props.option.description}</span>
        </Show>
      </text>
      <Show when={props.option.footer}>
        <box flexShrink={0}>
          <text
            fg={props.active || props.jumping || !props.option.footerColor ? secondary() : props.option.footerColor}
          >
            {props.option.footer}
          </text>
        </box>
      </Show>
    </box>
  )
}
