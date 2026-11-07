import { expect, test } from "bun:test"
import { assignJumpLabels, halfPage, JUMP_LABELS } from "../src/navigate"

const rows = (lines: number[]) => lines.map((line) => ({ key: `row${line}`, line }))
const labelsByLine = (result: { key: string; label: string }[]) =>
  Object.fromEntries(result.map(({ key, label }) => [Number(key.slice(3)), label]))

test("labels are flash.nvim's defaults, lowercase first, then uppercase", () => {
  expect(JUMP_LABELS.slice(0, 10).join("")).toBe("asdfghjklq")
  expect(JUMP_LABELS).toHaveLength(52)
  expect(JUMP_LABELS[26]).toBe("A")
  expect(new Set(JUMP_LABELS).size).toBe(52)
})

test("the cursor line gets the first label, then lines alternate below and above by distance", () => {
  const result = labelsByLine(assignJumpLabels(rows([0, 1, 2, 3, 4, 5, 6]), 3))
  expect(result).toEqual({ 3: "a", 4: "s", 2: "d", 5: "f", 1: "g", 6: "h", 0: "j" })
})

test("distance is in screen lines, so header gaps push rows further away", () => {
  // Rows on lines 0, 1 and 4, 5: lines 2 and 3 hold a blank line and a category header.
  const result = labelsByLine(assignJumpLabels(rows([0, 1, 4, 5]), 1))
  expect(result).toEqual({ 1: "a", 0: "s", 4: "d", 5: "f" })
})

test("a cursor at the top labels downwards in order", () => {
  expect(labelsByLine(assignJumpLabels(rows([0, 1, 2]), 0))).toEqual({ 0: "a", 1: "s", 2: "d" })
})

test("a cursor scrolled out of view still ranks rows by distance from it", () => {
  expect(labelsByLine(assignJumpLabels(rows([0, 1, 2]), 10))).toEqual({ 2: "a", 1: "s", 0: "d" })
})

test("rows past the last label stay unlabeled", () => {
  const many = rows(Array.from({ length: 60 }, (_, line) => line))
  const result = assignJumpLabels(many, 0)
  expect(result).toHaveLength(52)
  expect(result.at(-1)).toEqual({ key: "row51", label: "M" })
})

test("half page down moves the cursor and the window by half the window height", () => {
  const lines = Array.from({ length: 40 }, (_, line) => line)
  expect(halfPage({ lines, selected: 3, top: 0, height: 10, contentHeight: 40, direction: 1 })).toEqual({
    index: 8,
    top: 5,
  })
  expect(halfPage({ lines, selected: 8, top: 5, height: 10, contentHeight: 40, direction: -1 })).toEqual({
    index: 3,
    top: 0,
  })
})

test("at the end of the list the cursor keeps moving and stops on the last row", () => {
  const lines = Array.from({ length: 12 }, (_, line) => line)
  expect(halfPage({ lines, selected: 6, top: 2, height: 10, contentHeight: 12, direction: 1 })).toEqual({
    index: 11,
    top: 2,
  })
  expect(halfPage({ lines, selected: 11, top: 2, height: 10, contentHeight: 12, direction: 1 })).toEqual({
    index: 11,
    top: 2,
  })
})

test("a list that fits on screen only moves the cursor", () => {
  const lines = [0, 1, 2, 3, 4, 5]
  expect(halfPage({ lines, selected: 0, top: 0, height: 6, contentHeight: 6, direction: 1 })).toEqual({
    index: 3,
    top: 0,
  })
  expect(halfPage({ lines, selected: 1, top: 0, height: 6, contentHeight: 6, direction: -1 })).toEqual({
    index: 0,
    top: 0,
  })
})

test("a target line on a category header moves on to the next row in the same direction", () => {
  // Today: lines 1-3, blank 4, Yesterday header 5, rows 6-8.
  const lines = [1, 2, 3, 6, 7, 8]
  expect(halfPage({ lines, selected: 1, top: 0, height: 6, contentHeight: 9, direction: 1 })).toEqual({
    index: 3,
    top: 3,
  })
  expect(halfPage({ lines, selected: 3, top: 3, height: 6, contentHeight: 9, direction: -1 })).toEqual({
    index: 2,
    top: 0,
  })
})

test("reaching the first row scrolls back to the top so its header shows", () => {
  const lines = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  expect(halfPage({ lines, selected: 2, top: 2, height: 4, contentHeight: 11, direction: -1 })).toEqual({
    index: 0,
    top: 0,
  })
})
