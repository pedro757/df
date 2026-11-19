import { describe, expect, test } from "bun:test"
import { KEY, matchesAction, sidechatInstructions, sidechatOf, titleFrom, withSidechat } from "../src/meta"

const marker = { parentID: "ses_main", sessionID: "ses_side", from: "ses_main", created: 1, base: "msg_1" }

describe("sidechatOf", () => {
  test("reads the marker of the session it names", () => {
    expect(sidechatOf({ id: "ses_side", metadata: { [KEY]: marker } })).toEqual({
      parentID: "ses_main",
      sessionID: "ses_side",
      from: "ses_main",
      base: "msg_1",
      created: 1,
      untitled: undefined,
      broughtBack: undefined,
    })
  })

  test("a fork or subagent that copied the marker is not a sidechat", () => {
    expect(sidechatOf({ id: "ses_fork_of_side", metadata: { [KEY]: marker } })).toBeUndefined()
  })

  test("ignores sessions without a usable marker", () => {
    expect(sidechatOf(undefined)).toBeUndefined()
    expect(sidechatOf({ id: "ses_side" })).toBeUndefined()
    expect(sidechatOf({ id: "ses_side", metadata: { [KEY]: "yes" } })).toBeUndefined()
    expect(sidechatOf({ id: "ses_side", metadata: { [KEY]: { sessionID: "ses_side" } } })).toBeUndefined()
  })

  test("from defaults to the main session", () => {
    const { from: _, ...rest } = marker
    expect(sidechatOf({ id: "ses_side", metadata: { [KEY]: rest } })?.from).toBe("ses_main")
  })
})

describe("withSidechat", () => {
  test("keeps other metadata", () => {
    const next = withSidechat({ goal: { text: "ship" } }, { ...marker, untitled: true })
    expect(next.goal).toEqual({ text: "ship" })
    expect(next[KEY]).toEqual({ ...marker, untitled: true })
  })

  test("leaves out unset fields so the record stays JSON", () => {
    const next = withSidechat(undefined, { parentID: "a", sessionID: "b", from: "a", created: 2 })
    expect(next[KEY]).toEqual({ parentID: "a", sessionID: "b", from: "a", created: 2 })
  })

  test("removes the marker", () => {
    expect(withSidechat({ [KEY]: marker, other: 1 }, undefined)).toEqual({ other: 1 })
  })
})

describe("titleFrom", () => {
  test("collapses whitespace", () => expect(titleFrom("  what\n does   this do? ")).toBe("what does this do?"))
  test("cuts long text", () => {
    const title = titleFrom("x".repeat(100), 20)
    expect(title.length).toBe(20)
    expect(title.endsWith("…")).toBe(true)
  })
})

describe("matchesAction", () => {
  test("matches whole values with wildcards", () => {
    expect(matchesAction("edit", ["edit"])).toBe(true)
    expect(matchesAction("edits", ["edit"])).toBe(false)
    expect(matchesAction("github_create_issue", ["github_*"])).toBe(true)
    expect(matchesAction("shell", ["*"])).toBe(true)
    expect(matchesAction("read", ["edit", "shell"])).toBe(false)
  })
})

test("sidechatInstructions names the main session", () => {
  expect(sidechatInstructions("Fix login")).toContain('sidechat of "Fix login"')
  expect(sidechatInstructions(undefined)).toContain("sidechat of the main session")
})
