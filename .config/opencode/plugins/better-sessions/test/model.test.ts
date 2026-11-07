import { describe, expect, test } from "bun:test"
import {
  activityAt,
  compareActive,
  compareSnoozed,
  place,
  raisedHandWhileSnoozed,
  settleBlocker,
  snoozeBlocker,
  wakeCategory,
  type Entry,
  type SessionLike,
  type Signals,
} from "../src/model"

const DAY = 24 * 60 * 60 * 1000
const NOW = new Date("2026-11-07T12:00:00").getTime()

const idle: Signals = { attention: false, working: false, permissionIDs: [], formIDs: [] }
const working: Signals = { ...idle, working: true }
const question: Signals = { ...idle, attention: "question", formIDs: ["frm_1"], working: true }
const permission: Signals = { ...idle, attention: "permission", permissionIDs: ["per_1"], working: true }

function session(input: Partial<SessionLike> & { updated?: number } = {}): SessionLike {
  const updated = input.updated ?? NOW - 60_000
  return { id: input.id ?? "ses_1", outcome: input.outcome, time: { created: updated - 1000, updated, ...input.time } }
}

const placeOf = (s: SessionLike, entry: Entry | undefined, signals = idle, days: number | null = 7) =>
  place({ session: s, entry, signals, now: NOW, autoSettleAfterDays: days })

describe("place", () => {
  test("new sessions are active", () => {
    expect(placeOf(session(), undefined)).toEqual({ tab: "active", woke: false })
  })

  test("explicit settle wins even while working", () => {
    expect(placeOf(session(), { state: "settled", at: NOW }, working).tab).toBe("settled")
  })

  test("inactive sessions settle by themselves after the configured days", () => {
    const old = session({ updated: NOW - 8 * DAY })
    expect(placeOf(old, undefined)).toEqual({ tab: "settled", auto: true })
    expect(placeOf(old, undefined, idle, null).tab).toBe("active")
    expect(placeOf(session({ updated: NOW - 6 * DAY }), undefined).tab).toBe("active")
  })

  test("working or waiting sessions never auto-settle", () => {
    const old = session({ updated: NOW - 30 * DAY })
    expect(placeOf(old, undefined, working).tab).toBe("active")
    expect(placeOf(old, undefined, question).tab).toBe("active")
  })

  test("restoring counts as activity", () => {
    const old = session({ updated: NOW - 30 * DAY })
    expect(placeOf(old, { state: "active", at: NOW - DAY }).tab).toBe("active")
    expect(placeOf(old, { state: "active", at: NOW - 8 * DAY }).tab).toBe("settled")
  })

  test("snoozed until the timer, then active and flagged", () => {
    const entry: Entry = { state: "snoozed", at: NOW - 1000, until: NOW + 60_000 }
    expect(placeOf(session(), entry)).toEqual({ tab: "snoozed", until: NOW + 60_000 })
    expect(placeOf(session(), { ...entry, until: NOW - 1 })).toEqual({ tab: "active", woke: true })
  })

  test("a woken snooze does not settle right away", () => {
    const old = session({ updated: NOW - 30 * DAY })
    expect(placeOf(old, { state: "snoozed", at: NOW - 20 * DAY, until: NOW - DAY }).tab).toBe("active")
    expect(placeOf(old, { state: "active", at: NOW - DAY, woke: NOW - DAY })).toEqual({ tab: "active", woke: true })
  })

  test("snoozed long-running sessions stay snoozed while they work", () => {
    expect(placeOf(session(), { state: "snoozed", at: NOW - 1000, until: NOW + DAY }, working).tab).toBe("snoozed")
  })
})

describe("raisedHandWhileSnoozed (t3code semantics)", () => {
  const entry = { state: "snoozed", at: NOW - 60_000, until: NOW + DAY } as const

  test("permission requests wake it", () => {
    expect(raisedHandWhileSnoozed(entry, session(), permission)).toBe(true)
  })

  test("a question pending when snoozed means ask me later", () => {
    expect(raisedHandWhileSnoozed({ ...entry, forms: ["frm_1"] }, session(), question)).toBe(false)
  })

  test("a new question wakes it", () => {
    expect(raisedHandWhileSnoozed({ ...entry, forms: ["frm_0"] }, session(), question)).toBe(true)
  })

  test("only a failure after the snooze wakes it", () => {
    expect(raisedHandWhileSnoozed(entry, session({ outcome: "failed", time: { created: 0, updated: NOW, idle: NOW } }), idle)).toBe(true)
    expect(
      raisedHandWhileSnoozed(
        entry,
        session({ outcome: "failed", time: { created: 0, updated: NOW - DAY, idle: NOW - DAY } }),
        idle,
      ),
    ).toBe(false)
    expect(raisedHandWhileSnoozed(entry, session({ outcome: "succeeded" }), idle)).toBe(false)
  })

  test("an early wake shows in Active", () => {
    expect(placeOf(session(), entry, permission)).toEqual({ tab: "active", woke: true })
  })
})

test("running sessions cannot be settled; finished and waiting ones can", () => {
  expect(settleBlocker(working)).toBeString()
  expect(settleBlocker(idle)).toBeUndefined()
  expect(settleBlocker(question)).toBeUndefined()
  expect(settleBlocker(permission)).toBeUndefined()
})

test("snoozing is blocked by pending permissions only", () => {
  expect(snoozeBlocker(permission)).toBeString()
  expect(snoozeBlocker(question)).toBeUndefined()
  expect(snoozeBlocker(working)).toBeUndefined()
})

test("active order: waiting first, then done, then working; recent first in each", () => {
  const rows = [
    { session: session({ id: "working-new", updated: NOW }), signals: working },
    { session: session({ id: "done-old", updated: NOW - 5000 }), signals: idle },
    { session: session({ id: "question", updated: NOW - 9000 }), signals: question },
    { session: session({ id: "done-new", updated: NOW - 1000 }), signals: idle },
    { session: session({ id: "working-old", updated: NOW - 8000 }), signals: working },
    { session: session({ id: "permission", updated: NOW - 2000 }), signals: permission },
  ]
  expect(rows.sort(compareActive).map((row) => row.session.id)).toEqual([
    "permission",
    "question",
    "done-new",
    "done-old",
    "working-new",
    "working-old",
  ])
})

test("snoozed order: soonest wake first", () => {
  const rows = [
    { session: session({ id: "b" }), until: NOW + 2 * DAY },
    { session: session({ id: "a" }), until: NOW + 60_000 },
  ]
  expect(rows.sort(compareSnoozed).map((row) => row.session.id)).toEqual(["a", "b"])
})

test("wake categories", () => {
  expect(wakeCategory(NOW + 60_000, NOW)).toBe("Wakes today")
  expect(wakeCategory(NOW + DAY, NOW)).toBe("Wakes tomorrow")
  expect(wakeCategory(NOW + 3 * DAY, NOW)).toBe(`Wakes ${new Date(NOW + 3 * DAY).toDateString()}`)
})

test("activityAt uses the latest timestamp", () => {
  const s = session({ time: { created: 1, updated: 5, busy: 9, idle: 7 } })
  expect(activityAt(s, undefined, NOW)).toBe(9)
  expect(activityAt(s, { state: "active", at: 20 }, NOW)).toBe(20)
})
