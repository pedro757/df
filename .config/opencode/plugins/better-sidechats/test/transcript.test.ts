import { describe, expect, test } from "bun:test"
import { bringBackText, ownMessages, type MessageLike } from "../src/transcript"

const user = (id: string, text: string): MessageLike => ({ id, type: "user", text })
const assistant = (id: string, text: string, files?: string[]): MessageLike => ({
  id,
  type: "assistant",
  content: [
    { type: "reasoning", text: "thinking" },
    { type: "text", text },
  ],
  ...(files ? { snapshot: { files } } : {}),
})

describe("ownMessages", () => {
  const newestFirst = [{ id: "m5" }, { id: "m4" }, { id: "m3" }, { id: "m2" }, { id: "m1" }]

  test("keeps the messages after the fork, oldest first", () => {
    expect(ownMessages(newestFirst, "m3")).toEqual({ messages: [{ id: "m4" }, { id: "m5" }], reachedBase: true })
  })

  test("everything when the sidechat started empty", () => {
    expect(ownMessages(newestFirst, undefined).messages.map((message) => message.id)).toEqual([
      "m1",
      "m2",
      "m3",
      "m4",
      "m5",
    ])
  })

  test("says when the page did not reach the fork", () => {
    expect(ownMessages(newestFirst, "m0").reachedBase).toBe(false)
  })
})

describe("bringBackText", () => {
  test("nothing to bring back without a reply", () => {
    expect(bringBackText({ title: "t", messages: [user("u1", "hi")] })).toBeUndefined()
  })

  test("user and assistant text, without reasoning, synthetic or system messages", () => {
    const result = bringBackText({
      title: 'Why "x"?',
      messages: [
        { id: "s1", type: "system", text: "instructions" },
        { id: "s2", type: "synthetic", text: "fork notice" },
        user("u1", "why does x fail?"),
        assistant("a1", "Because y."),
      ],
    })!
    expect(result.text).toContain('<sidechat title="Why &quot;x&quot;?">')
    expect(result.text).toContain("<user>\nwhy does x fail?\n</user>")
    expect(result.text).toContain("<assistant>\nBecause y.\n</assistant>")
    expect(result.text).not.toContain("thinking")
    expect(result.text).not.toContain("fork notice")
    expect(result.turns).toBe(2)
  })

  test("joins one reply split across tool calls and lists changed files", () => {
    const result = bringBackText({
      title: "t",
      messages: [
        user("u1", "fix it"),
        assistant("a1", "Looking.", ["src/a.ts"]),
        assistant("a2", "Fixed.", ["src/b.ts", "src/a.ts"]),
      ],
    })!
    expect(result.text).toContain("<assistant>\nLooking.\n\nFixed.\n</assistant>")
    expect(result.files).toEqual(["src/a.ts", "src/b.ts"])
    expect(result.text).toContain("Files the sidechat changed: src/a.ts, src/b.ts")
  })

  test("keeps the newest turns when too long", () => {
    const messages = Array.from({ length: 10 }, (_, index) => [
      user(`u${index}`, `question ${index} ${"x".repeat(200)}`),
      assistant(`a${index}`, `answer ${index}`),
    ]).flat()
    const result = bringBackText({ title: "t", messages, maxChars: 1_000 })!
    expect(result.omitted).toBeGreaterThan(0)
    expect(result.text).toContain("answer 9")
    expect(result.text).not.toContain("answer 0")
    expect(result.text).toContain(`(${result.omitted} earlier messages omitted)`)
  })

  test("shell commands typed in the sidechat", () => {
    const result = bringBackText({
      title: "t",
      messages: [{ id: "x1", type: "shell", command: "ls" }, assistant("a1", "ok")],
    })!
    expect(result.text).toContain("<shell>\n$ ls\n</shell>")
  })
})
