// Snooze presets, wake labels and custom input, ported from pingdotgg/t3code nightly
// (packages/client-runtime/src/state/threadSettled.ts and packages/contracts/src/settings.ts).

export type SnoozePresetDay = "today" | "tomorrow" | "sunday" | "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday"

export type SnoozePresetSetting =
  | { readonly kind: "after"; readonly minutes: number }
  | { readonly kind: "at"; readonly day: SnoozePresetDay; readonly time: string }

export const DEFAULT_SNOOZE_PRESETS: ReadonlyArray<SnoozePresetSetting> = [
  { kind: "after", minutes: 60 },
  { kind: "after", minutes: 180 },
  { kind: "at", day: "today", time: "18:00" },
  { kind: "at", day: "tomorrow", time: "09:00" },
  { kind: "at", day: "monday", time: "09:00" },
]

const MAX_SNOOZE_PRESET_MINUTES = 60 * 24 * 365
const MAX_SNOOZE_PRESETS = 10
const HOUR_MS = 60 * 60 * 1_000
const DAY_MS = 24 * HOUR_MS

const WEEKDAY_INDEX = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
} as const

export interface SnoozePreset {
  readonly id: string
  readonly label: string
  readonly whenLabel: string
  /** Epoch milliseconds. */
  readonly until: number
}

/** Accepts presets from plugin options, dropping invalid entries like t3code's settings schema does. */
export function parseSnoozePresets(value: unknown): ReadonlyArray<SnoozePresetSetting> {
  if (!Array.isArray(value)) return DEFAULT_SNOOZE_PRESETS
  const presets = value.flatMap((item): SnoozePresetSetting[] => {
    if (!item || typeof item !== "object") return []
    const entry = item as Record<string, unknown>
    if (entry.kind === "after") {
      const minutes = entry.minutes
      if (typeof minutes !== "number" || !Number.isInteger(minutes)) return []
      if (minutes < 1 || minutes > MAX_SNOOZE_PRESET_MINUTES) return []
      return [{ kind: "after", minutes }]
    }
    if (entry.kind === "at") {
      const day = entry.day
      const time = entry.time
      if (typeof day !== "string" || !(day === "today" || day === "tomorrow" || day in WEEKDAY_INDEX)) return []
      if (typeof time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return []
      return [{ kind: "at", day: day as SnoozePresetDay, time }]
    }
    return []
  })
  return presets.length > 0 ? presets.slice(0, MAX_SNOOZE_PRESETS) : DEFAULT_SNOOZE_PRESETS
}

function timeOfDayLabel(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
}

// Calendar-day advance instead of adding DAY_MS: fixed millisecond offsets
// land on the wrong local day across DST transitions.
function addDays(base: Date, days: number): Date {
  const next = new Date(base.getTime())
  next.setDate(next.getDate() + days)
  return next
}

function pluralize(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`
}

/** "3 hours", "90 minutes", "2 days": the largest unit that divides evenly. */
function formatDuration(minutes: number): string {
  if (minutes % (24 * 60) === 0) return pluralize(minutes / (24 * 60), "day")
  if (minutes % 60 === 0) return pluralize(minutes / 60, "hour")
  return pluralize(minutes, "minute")
}

function capitalize(word: string): string {
  return word[0]!.toUpperCase() + word.slice(1)
}

function daysAhead(setting: Extract<SnoozePresetSetting, { kind: "at" }>, now: Date): number {
  if (setting.day === "today") return 0
  if (setting.day === "tomorrow") return 1
  return (WEEKDAY_INDEX[setting.day] - now.getDay() + 7) % 7 || 7
}

/** Labels follow the actual day gap, so a Monday option on a Sunday reads "Tomorrow". */
function presetLabel(setting: SnoozePresetSetting, ahead: number): string {
  if (setting.kind === "after") return `In ${formatDuration(setting.minutes)}`
  if (ahead === 0) {
    const hour = Number(setting.time.slice(0, 2))
    return hour < 12 ? "This morning" : hour < 17 ? "This afternoon" : "This evening"
  }
  if (ahead === 1) return "Tomorrow"
  if (setting.day === "monday") return "Next week"
  return ahead === 7 ? `Next ${capitalize(setting.day)}` : capitalize(setting.day)
}

export function snoozePresetId(setting: SnoozePresetSetting): string {
  return setting.kind === "after" ? `after:${setting.minutes}` : `at:${setting.day}:${setting.time}`
}

export function resolveSnoozePreset(
  setting: SnoozePresetSetting,
  now: Date,
  formatTime: (date: Date) => string = timeOfDayLabel,
): SnoozePreset | null {
  let wake: Date
  let ahead = 0
  if (setting.kind === "after") {
    wake = new Date(now.getTime() + setting.minutes * 60_000)
  } else {
    ahead = daysAhead(setting, now)
    wake = addDays(now, ahead)
    wake.setHours(Number(setting.time.slice(0, 2)), Number(setting.time.slice(3)), 0, 0)
    // A today option whose time has passed is left out until tomorrow.
    if (wake.getTime() <= now.getTime()) return null
  }
  const label = presetLabel(setting, ahead)
  // Durations and "Next week" don't name the wake day, so a wake on another day shows it.
  const labelNamesDay = setting.kind === "at" && label !== "Next week"
  const time = formatTime(wake)
  return {
    id: snoozePresetId(setting),
    label,
    whenLabel:
      labelNamesDay || wake.toDateString() === now.toDateString()
        ? time
        : `${wake.toLocaleDateString(undefined, { weekday: "short" })} ${time}`,
    until: wake.getTime(),
  }
}

/** The snooze menu: soonest first, one row per wake minute. */
export function resolveSnoozePresets(
  now: Date,
  presets: ReadonlyArray<SnoozePresetSetting> = DEFAULT_SNOOZE_PRESETS,
): ReadonlyArray<SnoozePreset> {
  const wakeMinute = (preset: SnoozePreset) => Math.floor(preset.until / 60_000)
  const seen = new Set<number>()
  return presets
    .flatMap((setting) => resolveSnoozePreset(setting, now) ?? [])
    .sort((a, b) => wakeMinute(a) - wakeMinute(b))
    .filter((preset) => {
      if (seen.has(wakeMinute(preset))) return false
      seen.add(wakeMinute(preset))
      return true
    })
}

/**
 * A menu choice as picked. A duration re-resolves from its setting (not the deduped menu) so it
 * starts at selection. A set time keeps the shown wake, which a day change would otherwise shift.
 */
export function pickSnoozePreset(input: {
  readonly shown: ReadonlyArray<SnoozePreset>
  readonly id: string
  readonly now: Date
  readonly presets?: ReadonlyArray<SnoozePresetSetting>
}): SnoozePreset | undefined {
  const original = input.shown.find((preset) => preset.id === input.id)
  const ahead = original && original.until > input.now.getTime() ? original : undefined
  const setting = (input.presets ?? DEFAULT_SNOOZE_PRESETS).find(
    (candidate) => candidate.kind === "after" && snoozePresetId(candidate) === input.id,
  )
  return (setting && resolveSnoozePreset(setting, input.now)) ?? ahead
}

/** Time left until a snooze ends: "45m", "3h", "2d" (t3code's `snoozeWakeLabel`). */
export function snoozeWakeLabel(until: number, now: number): string {
  if (Number.isNaN(until) || Number.isNaN(now)) return "now"
  const remaining = until - now
  if (remaining <= 0) return "now"
  if (remaining < HOUR_MS) return `${Math.max(1, Math.ceil(remaining / 60_000))}m`
  if (remaining < DAY_MS) return `${Math.ceil(remaining / HOUR_MS)}h`
  return `${Math.ceil(remaining / DAY_MS)}d`
}

/** The time left on a snooze for list rows: "45m left", or "waking up" once it is due but not yet swept. */
export function snoozeTimeLeft(until: number, now: number): string {
  const label = snoozeWakeLabel(until, now)
  return label === "now" ? "waking up" : `${label} left`
}

export function localSnoozeDate(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

export function localSnoozeTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}

const UNIT_MS: Record<string, number> = {
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: HOUR_MS,
  hr: HOUR_MS,
  hrs: HOUR_MS,
  hour: HOUR_MS,
  hours: HOUR_MS,
  d: DAY_MS,
  day: DAY_MS,
  days: DAY_MS,
  w: 7 * DAY_MS,
  week: 7 * DAY_MS,
  weeks: 7 * DAY_MS,
}

/**
 * Custom snooze input, the text form of t3code's custom snooze dialog. Accepts a duration
 * ("45m", "2h", "3 days", "1h30m") or a local date and time ("2026-11-10 14:00", "14:00",
 * "tomorrow 09:00"). Returns the wake time in epoch milliseconds, or an error message.
 */
export function resolveCustomSnooze(input: string, now: Date): { until: number } | { error: string } {
  const text = input.trim().toLowerCase().replace(/^in\s+/, "")
  if (!text) return { error: "Enter a duration like 45m, 2h or 3d, or a time like 14:00 or 2026-11-10 14:00" }

  const duration = /^(\d+(?:\.\d+)?)\s*([a-z]+)(?:\s*(\d+(?:\.\d+)?)\s*([a-z]+))?$/.exec(text)
  if (duration) {
    const parts = [
      [duration[1], duration[2]],
      [duration[3], duration[4]],
    ].filter((part): part is [string, string] => part[0] !== undefined && part[1] !== undefined)
    let total = 0
    for (const [amount, unit] of parts) {
      const ms = UNIT_MS[unit]
      const value = Number(amount)
      if (ms === undefined) return { error: `Unknown unit "${unit}". Use m, h, d or w` }
      if (!Number.isFinite(value) || value <= 0) return { error: "The duration must be greater than zero" }
      total += value * ms
    }
    if (total > MAX_SNOOZE_PRESET_MINUTES * 60_000) return { error: "Snoozes are limited to one year" }
    return { until: now.getTime() + total }
  }

  const dated = /^(?:(today|tomorrow|\d{4}-\d{2}-\d{2})\s+)?(\d{1,2}):(\d{2})$/.exec(text)
  const dateOnly = /^(today|tomorrow|\d{4}-\d{2}-\d{2})$/.exec(text)
  if (dated || dateOnly) {
    const day = (dated ? dated[1] : dateOnly![1]) ?? "today"
    const hours = dated ? Number(dated[2]) : 9
    const minutes = dated ? Number(dated[3]) : 0
    if (hours > 23 || minutes > 59) return { error: "Use a 24-hour time like 14:00" }
    const base = day === "today" ? now : day === "tomorrow" ? addDays(now, 1) : undefined
    const date = base ? localSnoozeDate(base) : day
    const time = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`
    const wake = new Date(`${date}T${time}:00`)
    // Reject rolled-over dates and nonexistent local times during DST changes.
    if (!Number.isFinite(wake.getTime()) || localSnoozeDate(wake) !== date || localSnoozeTime(wake) !== time)
      return { error: `${date} ${time} is not a valid local date and time` }
    // A bare time that already passed today means tomorrow, like an alarm clock.
    if (!dated?.[1] && dated && wake.getTime() <= now.getTime()) {
      const next = addDays(wake, 1)
      return { until: next.getTime() }
    }
    if (wake.getTime() <= now.getTime()) return { error: "Pick a time in the future" }
    return { until: wake.getTime() }
  }

  return { error: "Enter a duration like 45m, 2h or 3d, or a time like 14:00 or 2026-11-10 14:00" }
}

/** "Fri Nov 7, 6:00 PM" style absolute label for a wake time. */
export function formatWake(until: number, now: number) {
  const wake = new Date(until)
  const time = timeOfDayLabel(wake)
  if (wake.toDateString() === new Date(now).toDateString()) return `today ${time}`
  if (wake.toDateString() === addDays(new Date(now), 1).toDateString()) return `tomorrow ${time}`
  return `${wake.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} ${time}`
}
