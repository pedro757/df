import {
  parseColor,
  Renderable,
  RGBA,
  TextAttributes,
  type ColorInput,
  type OptimizedBuffer,
  type RenderableOptions,
  type RenderContext,
  type TextareaRenderable,
} from "@opentui/core"
import { extend, getComponentCatalogue, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createSignal, For, onMount, Show, type JSX, type ParentProps } from "solid-js"
import { usePlugin } from "@opencode/plugin/tui"
import type { Attention } from "./model"
import { cursorStyle, type CliConfig } from "./config"

// Layout constants from the TUI's ui/dialog.tsx.
export const DIALOG_INSET = 3
export const DIALOG_LIST_INSET = DIALOG_INSET + 1

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

export function useDialogTheme() {
  const context = usePlugin()
  return () => context.theme.surface("dialog")
}

export type DialogTheme = ReturnType<ReturnType<typeof useDialogTheme>>

type SpinnerOptions = RenderableOptions<SpinnerRenderable> & {
  frames?: string[]
  interval?: number
  color?: ColorInput
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/**
 * A copy of the TUI's SpinnerRenderable. Not live: the renderer's shared animation clock ticks it
 * while it is drawn, so an idle renderer can still settle.
 */
class SpinnerRenderable extends Renderable {
  private glyphs: { char: string; width: number }[][] = []
  private frameTexts: string[] = []
  private frameWidth = 0
  private _interval: number
  private _color: RGBA
  private index = 0

  constructor(ctx: RenderContext, options: SpinnerOptions = {}) {
    super(ctx, options)
    this._interval = options.interval ?? 80
    this._color = parseColor(options.color ?? RGBA.defaultForeground())
    this.setMeasureProvider(() => ({ width: this.frameWidth, height: 1 }))
    this.frames = options.frames ?? SPINNER_FRAMES
  }

  set frames(value: string[]) {
    if (value.length === this.frameTexts.length && value.every((frame, index) => frame === this.frameTexts[index]))
      return
    this.frameTexts = value
    this.glyphs = value.map((frame) =>
      Array.from(graphemes.segment(frame), (part) => ({ char: part.segment, width: Bun.stringWidth(part.segment) })),
    )
    this.index = 0
    const width = Math.max(0, ...this.glyphs.map((glyphs) => glyphs.reduce((sum, glyph) => sum + glyph.width, 0)))
    if (width !== this.frameWidth) {
      this.frameWidth = width
      this.invalidateIntrinsicSize()
    }
    this.restart()
  }

  set interval(value: number) {
    if (value === this._interval) return
    this._interval = value
    this.restart()
  }

  set color(value: ColorInput) {
    this._color = parseColor(value)
    this.requestRender()
  }

  private restart() {
    this.animationFps = this.glyphs.length > 1 ? 1000 / this._interval : undefined
    this.requestRender()
  }

  protected override onAnimationTick(_deltaTime: number, ticks: number) {
    this.index = (this.index + ticks) % this.glyphs.length
    this.requestRender()
  }

  protected override renderSelf(buffer: OptimizedBuffer) {
    const glyphs = this.glyphs[this.index]
    if (!glyphs) return
    let x = this.screenX
    for (const glyph of glyphs) {
      buffer.drawText(glyph.char, x, this.screenY, this._color, RGBA.fromInts(0, 0, 0, 0))
      x += glyph.width
    }
  }
}

declare module "@opentui/solid" {
  interface OpenTUIComponents {
    better_sessions_spinner: typeof SpinnerRenderable
  }
}

// Prefer the host's own spinner so the animation is identical; fall back to the copy above.
extend({
  better_sessions_spinner: (getComponentCatalogue().spinner as typeof SpinnerRenderable | undefined) ?? SpinnerRenderable,
})

/** The TUI's `<Spinner>` without a label: an animated braille glyph, or "⋯" with animations off. */
export function Spinner(props: { color: RGBA; animations: boolean }) {
  return (
    <Show when={props.animations} fallback={<text fg={props.color}>⋯</text>}>
      <box flexDirection="row" gap={1} flexShrink={0}>
        <box flexShrink={0}>
          <better_sessions_spinner frames={SPINNER_FRAMES} interval={80} color={props.color} />
        </box>
      </box>
    </Show>
  )
}

/** Marks a session whose snooze ended and that the user has not opened since. */
export const WOKE_MARKER = "⏰"

/**
 * The TUI's `sessionStatusGutter`, plus the snooze marker: "⏰" for a snooze that ended and has not been opened yet,
 * which wins over the rest, then "!" for permissions, "?" for questions, then a spinner while working. The alarm clock
 * is a wide glyph, so it reports a width of 2 cells for the row to make room.
 */
export function statusGutter(
  theme: DialogTheme,
  status: { attention: Attention; woke: boolean; working: boolean },
  animations: boolean,
  fallback?: () => JSX.Element,
): { gutter?: (color: RGBA) => JSX.Element; gutterWidth?: number } {
  const { attention } = status
  if (status.woke) return { gutter: () => <text>{WOKE_MARKER}</text>, gutterWidth: 2 }
  if (attention) {
    return {
      gutter: (color: RGBA) => (
        <text
          fg={color === theme.text.action.primary.focused ? color : theme.text.feedback.warning.base}
          attributes={TextAttributes.BOLD}
        >
          {attention === "permission" ? "!" : "?"}
        </text>
      ),
    }
  }
  if (status.working) return { gutter: (color: RGBA) => <Spinner color={color} animations={animations} /> }
  return { gutter: fallback }
}

export function DialogHeader(
  props: ParentProps<{
    title?: JSX.Element
    titleView?: JSX.Element
    onClose?: () => void
    gap?: number
  }>,
) {
  const context = usePlugin()
  const theme = useDialogTheme()
  return (
    <box flexDirection="row" justifyContent="space-between" gap={props.gap}>
      {props.titleView ?? (
        <text attributes={TextAttributes.BOLD} fg={theme().text.base}>
          {props.title}
        </text>
      )}
      {props.children}
      <text fg={theme().text.muted} flexShrink={0} onMouseUp={() => (props.onClose ?? context.ui.dialog.clear)()}>
        esc
      </text>
    </box>
  )
}

export function DialogLayout(props: ParentProps<{ header: JSX.Element; footer?: JSX.Element }>) {
  return (
    <box paddingLeft={DIALOG_INSET} paddingRight={DIALOG_INSET} paddingBottom={1} gap={1}>
      {props.header}
      <box>{props.children}</box>
      {props.footer}
    </box>
  )
}

/** Stretches the list across the layout's side padding, like the TUI's DialogBleed. */
export function DialogBleed(props: ParentProps) {
  return (
    <box marginLeft={-DIALOG_INSET} marginRight={-DIALOG_INSET}>
      {props.children}
    </box>
  )
}

export type FooterAction = {
  title: string
  key?: string
  onTrigger?: () => void
  disabled?: boolean
  color?: RGBA
}

/** The TUI's legacy DialogFooter. The left group wraps when a tab has more actions than fit. */
export function DialogFooter(
  props: ParentProps<{ secondary?: FooterAction[]; primary?: FooterAction[]; inset?: number }>,
) {
  const dimensions = useTerminalDimensions()
  const narrow = () => dimensions().width < 60
  return (
    <box
      paddingLeft={props.inset}
      paddingRight={props.inset}
      flexDirection="row"
      justifyContent="space-between"
      gap={2}
      flexShrink={0}
    >
      <box
        flexDirection={narrow() ? "column" : "row"}
        columnGap={narrow() ? 0 : 2}
        flexWrap={narrow() ? undefined : "wrap"}
        flexShrink={1}
        minWidth={0}
      >
        {props.children}
        <For each={props.secondary ?? []}>{(action) => <FooterItem action={action} />}</For>
      </box>
      <box flexDirection="row" gap={2} flexShrink={0}>
        <For each={props.primary ?? []}>{(action) => <FooterItem action={action} />}</For>
      </box>
    </box>
  )
}

function FooterItem(props: { action: FooterAction }) {
  const theme = useDialogTheme()
  const trigger = () => {
    if (props.action.disabled) return
    props.action.onTrigger?.()
  }
  return (
    <text onMouseUp={trigger} flexShrink={0}>
      <span
        style={{
          fg: props.action.disabled ? theme().text.action.primary.disabled : (props.action.color ?? theme().text.base),
        }}
      >
        {props.action.title}
      </span>
      <Show when={props.action.key}>
        <span
          style={{
            fg: props.action.disabled ? theme().text.action.primary.disabled : (props.action.color ?? theme().text.muted),
          }}
        >
          {" " + props.action.key}
        </span>
      </Show>
    </text>
  )
}

/** The TUI's DialogPrompt (legacy design), rendered inside this plugin's dialog. */
export function Prompt(props: {
  title: string
  description?: () => JSX.Element
  placeholder?: string
  value?: string
  busy?: boolean
  error?: string
  config: CliConfig
  onConfirm: (value: string) => void
  onCancel: () => void
}) {
  const context = usePlugin()
  const renderer = useRenderer()
  const theme = useDialogTheme()
  const [target, setTarget] = createSignal<TextareaRenderable>()
  let textarea: TextareaRenderable | undefined

  const confirm = () => {
    if (props.busy || !textarea) return
    props.onConfirm(textarea.plainText)
  }

  context.keymap.layer(() => ({
    mode: "modal",
    target,
    enabled: target() !== undefined && !props.busy,
    // Dialog form semantics must win over the global managed textarea input layer.
    priority: 1,
    commands: [{ id: "dialog.prompt.submit", title: "Submit dialog prompt", group: "Dialog", run: confirm }],
  }))

  context.keymap.layer(() => ({
    mode: "modal",
    priority: 1,
    commands: [
      {
        bind: "escape",
        title: "Back",
        group: "Dialog",
        run: () => {
          if (renderer.getSelection()) {
            renderer.clearSelection()
            return
          }
          if (!props.busy) props.onCancel()
        },
      },
    ],
  }))

  onMount(() => {
    setTimeout(() => {
      if (!textarea || textarea.isDestroyed || props.busy) return
      textarea.focus()
    }, 1)
    textarea?.gotoLineEnd()
  })

  const submitKey = () => context.keymap.shortcuts("dialog.prompt.submit")[0]

  return (
    <DialogLayout
      header={<DialogHeader title={props.title} onClose={() => !props.busy && props.onCancel()} />}
      footer={
        <Show when={!props.busy} fallback={<text fg={theme().text.muted}>processing…</text>}>
          <DialogFooter secondary={[{ title: "submit", key: submitKey(), onTrigger: confirm }]} />
        </Show>
      }
    >
      <box gap={1}>
        {props.description?.()}
        <textarea
          height={1}
          wrapMode="none"
          ref={(value: TextareaRenderable) => {
            textarea = value
            setTarget(value)
          }}
          initialValue={props.value}
          placeholder={props.placeholder ?? "Enter text"}
          placeholderColor={theme().text.muted}
          textColor={props.busy ? theme().text.formfield.disabled : theme().text.formfield.base}
          focusedTextColor={props.busy ? theme().text.formfield.disabled : theme().text.formfield.base}
          cursorColor={props.busy ? theme().background.formfield.disabled : theme().text.base}
          cursorStyle={cursorStyle(props.config)}
        />
        <Show when={props.error}>
          <text fg={theme().text.feedback.error.base} wrapMode="word">
            {props.error}
          </text>
        </Show>
      </box>
    </DialogLayout>
  )
}

export const transparent = RGBA.fromInts(0, 0, 0, 0)
