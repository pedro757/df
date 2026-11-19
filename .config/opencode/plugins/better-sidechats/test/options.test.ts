import { expect, test } from "bun:test"
import { bindOf, parseOptions } from "../src/options"

test("defaults", () => {
  const options = parseOptions(undefined)
  expect(options.label).toBe("Sidechats")
  expect(options.replaceBtw).toBe(true)
  expect(options.ask).toEqual(["edit"])
  expect(options.keybinds.parent).toBe("<leader>p")
  expect(options.keybinds.tabDelete).toBe("ctrl+d")
  expect(options.keybinds.composerLeft).toBe("shift+tab")
  expect(options.keybinds.composerRight).toBe("tab")
  expect(options.keybinds.composerSelect).toBe("ctrl+l")
})

test("overrides, ignoring values of the wrong type", () => {
  const options = parseOptions({
    label: "Side",
    replaceBtw: false,
    openOnCreate: "no",
    ask: ["edit", "shell", 3],
    keybinds: { parent: "ctrl+up", tabBringBack: "none" },
  })
  expect(options.label).toBe("Side")
  expect(options.replaceBtw).toBe(false)
  expect(options.openOnCreate).toBe(true)
  expect(options.ask).toEqual(["edit", "shell"])
  expect(options.keybinds.parent).toBe("ctrl+up")
  expect(options.keybinds.tabBringBack).toBe("none")
  expect(options.keybinds.tabDelete).toBe("ctrl+d")
})

test("bindOf turns none into no binding", () => {
  expect(bindOf("none")).toBe(false)
  expect(bindOf("<leader>p")).toBe("<leader>p")
})
