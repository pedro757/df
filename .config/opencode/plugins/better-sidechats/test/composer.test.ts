import { describe, expect, test } from "bun:test"
import { composerTabs, findComposer, isLastTab, placeInComposer } from "../src/composer"

// Stand-ins for Solid owners: `owned` children, and `context` inherited by every descendant of a provider.
interface FakeOwner {
  owner: FakeOwner | null
  owned: FakeOwner[]
  context: Record<PropertyKey, unknown> | null
}

function owner(parent: FakeOwner | null, provide?: [symbol, unknown]): FakeOwner {
  const context = provide ? { ...(parent?.context ?? {}), [provide[0]]: provide[1] } : (parent?.context ?? null)
  const node: FakeOwner = { owner: parent, owned: [], context }
  parent?.owned.push(node)
  return node
}

const api = () => ({ register: () => () => {}, active: () => false, close: () => {} })

describe("findComposer", () => {
  test("finds the composer provided next to the slot", () => {
    const root = owner(null, [Symbol("theme"), { dark: true }])
    const route = owner(root)
    const slot = owner(route)
    const component = owner(owner(slot))
    const composer = api()
    const provider = owner(route, [Symbol("composer"), composer])
    owner(provider)
    expect(findComposer(component)).toBe(composer)
  })

  test("ignores look-alikes provided above the slot", () => {
    const above = api()
    const root = owner(null, [Symbol("above"), above])
    const slot = owner(root)
    expect(findComposer(owner(slot))).toBeUndefined()
  })

  test("the nearest composer wins", () => {
    const root = owner(null)
    const near = api()
    const far = api()
    owner(root, [Symbol("far"), far])
    const pane = owner(root)
    const slot = owner(pane)
    owner(pane, [Symbol("near"), near])
    expect(findComposer(owner(slot))).toBe(near)
  })

  test("nothing without an owner", () => {
    expect(findComposer(undefined)).toBeUndefined()
  })
})

// Stand-ins for renderables: a parent, children, and plain text on text nodes.
class Node {
  parent: Node | null = null
  children: Node[] = []
  isDestroyed = false
  attributes = 0
  _mouseListeners: Record<string, (event: unknown) => void> = {}
  constructor(readonly plainText?: string) {}
  getChildren() {
    return [...this.children]
  }
  add(child: Node) {
    child.parent = this
    this.children.push(child)
    return this
  }
  insertBefore(child: Node, anchor: Node) {
    child.parent = this
    this.children.splice(this.children.indexOf(anchor), 0, child)
  }
}

function composerTree() {
  const host = new Node()
  const anchor = new Node()
  host.add(anchor)
  const body = new Node()
  const header = new Node()
  const labels = new Node()
  labels.add(new Node("Subagents")).add(new Node("Shell")).add(new Node("Sidechats"))
  header.add(labels).add(new Node("esc"))
  const footer = new Node()
  body.add(header).add(footer)
  host.add(new Node().add(new Node().add(body)))
  return { anchor, body, header, footer, labels }
}

describe("isLastTab", () => {
  test("true while the tab's label comes last", () => {
    const { anchor } = composerTree()
    expect(isLastTab(anchor as never, new Node() as never, "Sidechats")).toBe(true)
  })

  test("false once a later tab registers", () => {
    const { anchor, labels } = composerTree()
    labels.add(new Node("Terminals"))
    expect(isLastTab(anchor as never, new Node() as never, "Sidechats")).toBe(false)
  })

  test("undefined when the label isn't rendered", () => {
    const { anchor } = composerTree()
    expect(isLastTab(anchor as never, new Node() as never, "Elsewhere")).toBeUndefined()
  })
})

describe("placeInComposer", () => {
  test("puts the panel between the header and the footer", () => {
    const { anchor, body, header, footer } = composerTree()
    const panel = new Node()
    expect(placeInComposer(anchor as never, panel as never, "Sidechats")).toBe(true)
    expect(body.children).toEqual([header, panel, footer])
    expect(placeInComposer(anchor as never, panel as never, "Sidechats")).toBe(true)
    expect(body.children).toEqual([header, panel, footer])
  })

  test("fails until the tab label is rendered", () => {
    const { anchor } = composerTree()
    expect(placeInComposer(anchor as never, new Node() as never, "Elsewhere")).toBe(false)
  })
})

describe("composerTabs", () => {
  test("lists the tabs in order and which one shows", () => {
    const { anchor, labels } = composerTree()
    labels.children[1]!.attributes = 1
    expect(composerTabs(anchor as never)?.map((tab) => [tab.label, tab.active])).toEqual([
      ["Subagents", false],
      ["Shell", true],
      ["Sidechats", false],
    ])
  })

  test("select runs the label's click handler", () => {
    const { anchor, labels } = composerTree()
    const clicked: string[] = []
    labels.children[2]!._mouseListeners.up = () => clicked.push("Sidechats")
    expect(composerTabs(anchor as never)![2]!.select()).toBe(true)
    expect(clicked).toEqual(["Sidechats"])
    expect(composerTabs(anchor as never)![0]!.select()).toBe(false)
  })

  test("one tab: a single label", () => {
    const host = new Node()
    const anchor = new Node()
    const header = new Node().add(new Node("Subagents")).add(new Node("esc"))
    host.add(anchor).add(new Node().add(header))
    expect(composerTabs(anchor as never)?.map((tab) => tab.label)).toEqual(["Subagents"])
  })

  test("other rows that end in esc are not the header", () => {
    const host = new Node()
    const anchor = new Node()
    host.add(anchor).add(new Node().add(new Node().add(new Node("x"))).add(new Node("esc")))
    expect(composerTabs(anchor as never)).toBeUndefined()
  })
})
