// List navigation: flash.nvim-style jump labels and vim's half-page scrolling. Pure, so it is unit tested.

/** flash.nvim's default `labels`, followed by their uppercase forms (`label.uppercase = true`, no `label.exclude`). */
export const JUMP_LABELS: readonly string[] = [
  ..."asdfghjklqwertyuiopzxcvbnm",
  ..."asdfghjklqwertyuiopzxcvbnm".toUpperCase(),
]

export interface JumpTarget<K> {
  readonly key: K
  /** Screen line of the row. */
  readonly line: number
}

/**
 * flash.nvim's labeler (`lua/flash/labeler.lua`) for
 * `jump({ search = { mode = "search", max_length = 0 }, label = { after = { 0, 0 } }, pattern = "^" })`.
 *
 * Every visible line start is a match, the cursor's own line included (`label.current = true`). `M:filter` sorts
 * matches by distance from the cursor (`label.distance = true`), computed as `|from - pos|` with
 * `pos = line * columns + col`. Line starts sit at column 0 and the cursor sits past it, so a line below the cursor is
 * one cell closer than the line the same distance above it: the order is the cursor's line, then alternately below and
 * above. `M:update` then hands out labels in that order until they run out (`max_length = 0` skips `M:skip`, which only
 * removes labels that could continue a search pattern). Matches left over stay unlabeled.
 */
export function assignJumpLabels<K>(
  targets: readonly JumpTarget<K>[],
  cursor: number,
  labels: readonly string[] = JUMP_LABELS,
): { key: K; label: string }[] {
  const distance = (line: number) => Math.abs(line - cursor) * 2 - (line > cursor ? 1 : 0)
  return [...targets]
    .sort((left, right) => distance(left.line) - distance(right.line))
    .slice(0, labels.length)
    .map((target, index) => ({ key: target.key, label: labels[index]! }))
}

/**
 * vim's CTRL-D / CTRL-U: scroll the window by half its height and move the cursor by the same number of lines. When the
 * window cannot scroll further the cursor still moves, stopping at the first or last row. Rows sit on `lines`
 * (ascending content lines; category headers leave gaps), so a target line on a header moves on to the next row in the
 * same direction.
 */
export function halfPage(input: {
  /** Content line of each row, in order. */
  readonly lines: readonly number[]
  readonly selected: number
  /** First visible content line. */
  readonly top: number
  /** Visible lines. */
  readonly height: number
  /** Total content lines. */
  readonly contentHeight: number
  readonly direction: 1 | -1
}): { index: number; top: number } {
  const { lines, selected, height, direction } = input
  if (lines.length === 0) return { index: 0, top: 0 }
  const amount = Math.max(1, Math.floor(height / 2))
  const maxTop = Math.max(0, input.contentHeight - height)
  let top = Math.min(maxTop, Math.max(0, input.top + direction * amount))
  const current = lines[Math.min(Math.max(selected, 0), lines.length - 1)]!
  const target = current + direction * amount
  let index: number
  if (direction > 0) {
    index = lines.findIndex((line) => line >= target)
    if (index < 0) index = lines.length - 1
  } else {
    index = lines.findLastIndex((line) => line <= target)
    if (index < 0) index = 0
  }
  const line = lines[index]!
  if (line < top) top = line
  if (line >= top + height) top = line - height + 1
  // The first row brings its category header back into view.
  if (index === 0) top = 0
  return { index, top: Math.min(maxTop, Math.max(0, top)) }
}
