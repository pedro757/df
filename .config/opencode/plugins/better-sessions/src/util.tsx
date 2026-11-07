import path from "node:path"
import { createSignal, onCleanup, type Accessor } from "solid-js"
import type { SessionInfo } from "@opencode/client"

/** Mirrors `withTimestampedFallback` from @opencode/util/session-title-fallback. */
export function sessionTitle(info: Pick<SessionInfo, "title" | "parentID" | "time">) {
  return info.title ?? `${info.parentID ? "Child" : "New"} session - ${new Date(info.time.created).toISOString()}`
}

/** Mirrors `Locale.truncate` from the TUI. */
export function truncate(value: string, length: number) {
  if (value.length <= length) return value
  return value.slice(0, length - 1) + "…"
}

/** Mirrors `projectName` from the TUI. */
export function projectName(project?: { canonical: string; name?: string }, fallback = "") {
  const canonical = project?.canonical ?? fallback
  if (canonical === "/") return fallback ? path.basename(fallback) : undefined
  return project?.name || path.basename(canonical)
}

/** Mirrors `createDebouncedSignal` from the TUI. */
export function createDebouncedSignal<T>(value: T, ms: number): [Accessor<T>, (value: T) => void] {
  const [get, set] = createSignal(value)
  let timer: ReturnType<typeof setTimeout> | undefined
  const debounced = (next: T) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      set(() => next)
    }, ms)
  }
  onCleanup(() => {
    if (timer) clearTimeout(timer)
  })
  return [get, debounced]
}

export function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

export function reconcileSelection(selected: number, count: number) {
  return Math.max(0, Math.min(count - 1, selected))
}

export function moveSelection(selected: number, input: { count: number; delta: number; policy: "clamp" | "wrap" }) {
  if (input.count <= 0) return 0
  const next = selected + input.delta
  if (input.policy === "clamp") return reconcileSelection(next, input.count)
  if (next < 0) return input.count - 1
  if (next >= input.count) return 0
  return next
}

/** Structural equality for option values (strings here, but kept generic like the host's isDeepEqual). */
export function same(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false
  const a = left as Record<string, unknown>
  const b = right as Record<string, unknown>
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => same(a[key], b[key]))
}

/** Formats a list of shortcuts the way the host's `formatCommandBindings` does. */
export function joinShortcuts(shortcuts: readonly string[]) {
  return [...new Set(shortcuts)].join(", ")
}
