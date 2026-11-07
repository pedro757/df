import { describe, expect, test } from "bun:test"
import {
  DEFAULT_SNOOZE_PRESETS,
  parseSnoozePresets,
  pickSnoozePreset,
  resolveCustomSnooze,
  resolveSnoozePresets,
  snoozeWakeLabel,
} from "../src/snooze"

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

describe("snoozeWakeLabel (t3code)", () => {
  const now = Date.parse("2026-11-07T12:00:00Z")
  test.each([
    [now - 1, "now"],
    [now + 1, "1m"],
    [now + 45 * MIN, "45m"],
    [now + 59 * MIN + 1, "60m"],
    [now + HOUR, "1h"],
    [now + HOUR + 1, "2h"],
    [now + 23 * HOUR, "23h"],
    [now + DAY, "1d"],
    [now + DAY + 1, "2d"],
  ])("%p", (until, label) => {
    expect(snoozeWakeLabel(until, now)).toBe(label)
  })
})

describe("resolveSnoozePresets (t3code defaults)", () => {
  test("Saturday noon", () => {
    const now = new Date(2026, 10, 7, 12, 0, 0) // Saturday
    const presets = resolveSnoozePresets(now)
    expect(presets.map((preset) => preset.label)).toEqual([
      "In 1 hour",
      "In 3 hours",
      "This evening",
      "Tomorrow",
      // Monday is two days away, so it reads "Next week".
      "Next week",
    ])
    expect(new Date(presets[2]!.until).getHours()).toBe(18)
    expect(new Date(presets[4]!.until).getDay()).toBe(1)
  })

  test("this evening is left out after 18:00 and a Monday preset on Sunday reads Tomorrow", () => {
    const now = new Date(2026, 10, 8, 19, 0, 0) // Sunday evening
    const labels = resolveSnoozePresets(now).map((preset) => preset.label)
    expect(labels).not.toContain("This evening")
    // Tomorrow 09:00 and Monday 09:00 are the same minute: deduped to the first.
    expect(labels).toEqual(["In 1 hour", "In 3 hours", "Tomorrow"])
  })

  test("durations re-resolve when picked", () => {
    const shownAt = new Date(2026, 10, 7, 12, 0, 0)
    const shown = resolveSnoozePresets(shownAt)
    const later = new Date(shownAt.getTime() + 5 * MIN)
    expect(pickSnoozePreset({ shown, id: "after:60", now: later })?.until).toBe(later.getTime() + HOUR)
    expect(pickSnoozePreset({ shown, id: "at:today:18:00", now: later })?.until).toBe(shown[2]!.until)
  })

  test("invalid option presets fall back to the defaults", () => {
    expect(parseSnoozePresets("nope")).toBe(DEFAULT_SNOOZE_PRESETS)
    expect(parseSnoozePresets([{ kind: "after", minutes: 30 }, { kind: "at", day: "friday", time: "25:00" }])).toEqual([
      { kind: "after", minutes: 30 },
    ])
  })
})

describe("resolveCustomSnooze", () => {
  const now = new Date(2026, 10, 7, 12, 0, 0)
  const until = (input: string) => {
    const result = resolveCustomSnooze(input, now)
    if ("error" in result) throw new Error(result.error)
    return result.until
  }

  test("durations", () => {
    expect(until("45m")).toBe(now.getTime() + 45 * MIN)
    expect(until("in 2 hours")).toBe(now.getTime() + 2 * HOUR)
    expect(until("1h30m")).toBe(now.getTime() + 90 * MIN)
    expect(until("3d")).toBe(now.getTime() + 3 * DAY)
  })

  test("times", () => {
    expect(new Date(until("14:30")).getHours()).toBe(14)
    // A bare time that already passed means tomorrow.
    expect(new Date(until("09:00")).getDate()).toBe(8)
    expect(new Date(until("tomorrow 08:15")).getDate()).toBe(8)
    expect(until("2026-11-10 14:00")).toBe(new Date(2026, 10, 10, 14, 0, 0).getTime())
  })

  test("errors", () => {
    expect(resolveCustomSnooze("", now)).toHaveProperty("error")
    expect(resolveCustomSnooze("5 parsecs", now)).toHaveProperty("error")
    expect(resolveCustomSnooze("2026-11-01 10:00", now)).toHaveProperty("error")
    expect(resolveCustomSnooze("2026-02-30 10:00", now)).toHaveProperty("error")
    expect(resolveCustomSnooze("today 10:00", now)).toHaveProperty("error")
  })
})
