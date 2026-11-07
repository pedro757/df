import { readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { MacOSScrollAccel, type ScrollAcceleration } from "@opentui/core"
import { parseSnoozePresets, type SnoozePresetSetting } from "./snooze"

const home = os.homedir()

/** OpenCode's global directories (XDG, like @opencode/util/global-roots). */
export const paths = {
  config: path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "opencode"),
  state: path.join(process.env.XDG_STATE_HOME || path.join(home, ".local", "state"), "opencode"),
}

/** The subset of cli.json this plugin mirrors so it renders like the built-in session list. */
export interface CliConfig {
  readonly animations?: boolean
  readonly cursor?: { readonly style?: "block" | "underline" | "line" | "default"; readonly blinking?: boolean }
  readonly scroll?: { readonly speed?: number; readonly acceleration?: boolean }
}

/** Strips JSONC comments and trailing commas without touching string contents. */
function stripJsonc(text: string) {
  let output = ""
  let inString = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    const next = text[index + 1]
    if (inString) {
      output += char
      if (char === "\\") {
        output += next ?? ""
        index++
      } else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      output += char
      continue
    }
    if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index++
      output += "\n"
      continue
    }
    if (char === "/" && next === "*") {
      index += 2
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index++
      index++
      continue
    }
    output += char
  }
  return output.replace(/,(\s*[}\]])/g, "$1")
}

function parseRecord(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined
  try {
    const value: unknown = JSON.parse(stripJsonc(text))
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function merge(base: Record<string, unknown>, override: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!override) return base
  const result: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    const current = result[key]
    result[key] =
      value && typeof value === "object" && !Array.isArray(value) && current && typeof current === "object" && !Array.isArray(current)
        ? merge(current as Record<string, unknown>, value as Record<string, unknown>)
        : value
  }
  return result
}

/** Reads cli.json the way the CLI does: the global file, then OPENCODE_CLI_CONFIG_CONTENT merged over it. */
export function readCliConfig(): CliConfig {
  let file: Record<string, unknown> | undefined
  try {
    file = parseRecord(readFileSync(path.join(paths.config, "cli.json"), "utf8"))
  } catch {}
  return merge(file ?? {}, parseRecord(process.env.OPENCODE_CLI_CONFIG_CONTENT)) as CliConfig
}

class CustomSpeedScroll implements ScrollAcceleration {
  constructor(private speed: number) {}
  tick(): number {
    return this.speed
  }
  reset(): void {}
}

/** Mirrors the TUI's `getScrollAcceleration`. */
export function scrollAcceleration(config: CliConfig): ScrollAcceleration {
  if (config.scroll?.acceleration) return new MacOSScrollAccel()
  if (config.scroll?.speed !== undefined) return new CustomSpeedScroll(config.scroll.speed)
  return new CustomSpeedScroll(3)
}

export function cursorStyle(config: CliConfig) {
  return { style: config.cursor?.style ?? "block", blinking: config.cursor?.blinking ?? true }
}

export interface Keybinds {
  readonly settle: string
  readonly snooze: string
  readonly restore: string
  readonly delete: string
  readonly halfPageDown: string
  readonly halfPageUp: string
  readonly nextTab: string
  readonly previousTab: string
}

export interface Options {
  /** Take over `session.list` (its keybind, palette entry and /sessions). Default true. */
  readonly replaceSessionList: boolean
  /** Days without activity before a session settles by itself, like t3code. `null` or 0 disables it. Default 7. */
  readonly autoSettleAfterDays: number | null
  readonly snoozePresets: ReadonlyArray<SnoozePresetSetting>
  /** Show a toast when a snooze timer ends. Default true. */
  readonly notifyOnWake: boolean
  readonly keybinds: Keybinds
}

export const DEFAULT_KEYBINDS: Keybinds = {
  settle: "ctrl+e",
  snooze: "ctrl+t",
  // "back to Active". ctrl+u is half page up.
  restore: "ctrl+a",
  delete: "ctrl+x",
  halfPageDown: "ctrl+d",
  halfPageUp: "ctrl+u",
  nextTab: "tab",
  previousTab: "shift+tab",
}

export function parseOptions(input: Readonly<Record<string, unknown>>): Options {
  const keybinds = (input.keybinds && typeof input.keybinds === "object" ? input.keybinds : {}) as Record<string, unknown>
  const key = (name: keyof Keybinds) => {
    const value = keybinds[name]
    return typeof value === "string" && value.trim() ? value.trim() : DEFAULT_KEYBINDS[name]
  }
  const days = input.autoSettleAfterDays
  return {
    replaceSessionList: input.replaceSessionList !== false,
    autoSettleAfterDays:
      days === null || days === 0 || days === false
        ? null
        : typeof days === "number" && Number.isFinite(days) && days > 0
          ? days
          : 7,
    snoozePresets: parseSnoozePresets(input.snoozePresets),
    notifyOnWake: input.notifyOnWake !== false,
    keybinds: {
      settle: key("settle"),
      snooze: key("snooze"),
      restore: key("restore"),
      delete: key("delete"),
      halfPageDown: key("halfPageDown"),
      halfPageUp: key("halfPageUp"),
      nextTab: key("nextTab"),
      previousTab: key("previousTab"),
    },
  }
}

/** One-time seeds from the built-in session list so switching to this plugin keeps the user's setup. */
export function readHostPins(): string[] {
  try {
    const value: unknown = JSON.parse(readFileSync(path.join(paths.state, "session.json"), "utf8"))
    const pinned = value && typeof value === "object" ? (value as Record<string, unknown>).pinned : undefined
    return Array.isArray(pinned) ? pinned.filter((item): item is string => typeof item === "string") : []
  } catch {
    return []
  }
}
