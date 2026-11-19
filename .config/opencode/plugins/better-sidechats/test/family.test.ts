import { describe, expect, test } from "bun:test"
import { modelOf, modelText, rowLabel, sessionFamily, type FamilySession } from "../src/family"

const session = (id: string, parentID?: string, extra: Partial<FamilySession> = {}): FamilySession => ({
  id,
  parentID,
  time: { created: 0 },
  ...extra,
})

describe("sessionFamily", () => {
  const sessions = [
    session("root"),
    session("a", "root"),
    session("a1", "a"),
    session("a2", "a"),
    session("b", "root"),
    session("b1", "b"),
    session("other"),
  ]

  test("lists the root's descendants with OpenCode's tree prefixes", () => {
    expect(sessionFamily(sessions, "root").map(({ session, prefix }) => `${prefix}${session.id}`)).toEqual([
      "a",
      "├─ a1",
      "└─ a2",
      "b",
      "└─ b1",
    ])
  })

  test("from any member of the family", () => {
    expect(sessionFamily(sessions, "a2").map(({ session }) => session.id)).toEqual(["a", "a1", "a2", "b", "b1"])
  })

  test("nothing for an unknown session, and no loop on a parent cycle", () => {
    expect(sessionFamily(sessions, "missing")).toEqual([])
    expect(sessionFamily([session("x", "y"), session("y", "x")], "x").map(({ session }) => session.id)).toEqual(["y"])
  })
})

describe("rowLabel", () => {
  test("agent and title", () => {
    expect(rowLabel(session("s", "p", { agent: "explore", title: "Find the auth code" }))).toEqual({
      agent: "Explore",
      title: "Find the auth code",
    })
  })

  test("agent from an old-style title", () => {
    expect(rowLabel(session("s", "p", { title: "Review the diff (@reviewer subagent)" }))).toEqual({
      agent: "Reviewer",
      title: "Review the diff ()",
    })
  })

  test("a session without a title", () => {
    expect(rowLabel(session("s", "p")).title).toBe("Child session - 1970-01-01T00:00:00.000Z")
  })
})

describe("modelOf", () => {
  const replies = [
    { type: "user" },
    { type: "assistant", model: { id: "old", providerID: "acme" } },
    { type: "assistant", model: { id: "new", providerID: "acme", variant: "high" } },
  ]
  const agents = [{ id: "explore", model: { id: "agent-model", providerID: "acme" } }]

  test("the session's selection, without reading its messages", () => {
    let read = false
    const result = modelOf(
      session("s", "p", { agent: "explore", model: { id: "picked", providerID: "acme", variant: "low" } }),
      () => {
        read = true
        return replies
      },
      () => agents,
    )
    expect(result).toEqual({ id: "picked", providerID: "acme", variant: "low" })
    expect(read).toBe(false)
  })

  test("else the newest reply's model, else the agent's", () => {
    expect(
      modelOf(
        session("s", "p", { agent: "explore" }),
        () => replies,
        () => agents,
      ),
    ).toEqual({
      id: "new",
      providerID: "acme",
      variant: "high",
    })
    expect(
      modelOf(
        session("s", "p", { agent: "explore" }),
        () => [],
        () => agents,
      )?.id,
    ).toBe("agent-model")
    expect(
      modelOf(
        session("s", "p"),
        () => undefined,
        () => undefined,
      ),
    ).toBeUndefined()
  })
})

describe("modelText", () => {
  const models = [{ id: "claude-opus-5-5", providerID: "anthropic", name: "Claude Opus 5.5" }]

  test("the model's name and the variant", () => {
    expect(modelText({ id: "claude-opus-5-5", providerID: "anthropic", variant: "high" }, models)).toEqual({
      model: "Claude Opus 5.5",
      variant: "high",
    })
  })

  test("no variant for the model default; the ID when the model isn't listed", () => {
    expect(modelText({ id: "claude-opus-5-5", providerID: "anthropic" }, models)).toEqual({ model: "Claude Opus 5.5" })
    expect(modelText({ id: "claude-opus-5-5", providerID: "anthropic", variant: "default" }, models)).toEqual({
      model: "Claude Opus 5.5",
    })
    expect(modelText({ id: "mystery", providerID: "acme" }, undefined)).toEqual({ model: "mystery" })
  })
})
