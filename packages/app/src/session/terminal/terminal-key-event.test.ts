import { describe, expect, test } from "bun:test"
import { terminalKeyInput } from "./terminal-key-event"

describe("terminalKeyInput", () => {
  test("maps Command+Delete to the terminal line-clear control code", () => {
    const event = new KeyboardEvent("keydown", { key: "Backspace", metaKey: true })

    expect(terminalKeyInput(event)).toBe("\x15")
  })

  test("maps Control+u to the terminal line-clear control code", () => {
    const event = new KeyboardEvent("keydown", { key: "u", ctrlKey: true })

    expect(terminalKeyInput(event)).toBe("\x15")
  })

  test("leaves other Backspace shortcuts to the terminal", () => {
    expect(terminalKeyInput(new KeyboardEvent("keydown", { key: "Backspace" }))).toBeUndefined()
    expect(
      terminalKeyInput(new KeyboardEvent("keydown", { key: "Backspace", metaKey: true, shiftKey: true })),
    ).toBeUndefined()
  })

  test("leaves other Control combinations to the terminal", () => {
    expect(terminalKeyInput(new KeyboardEvent("keydown", { key: "u" }))).toBeUndefined()
    expect(
      terminalKeyInput(new KeyboardEvent("keydown", { key: "u", ctrlKey: true, shiftKey: true })),
    ).toBeUndefined()
    expect(
      terminalKeyInput(new KeyboardEvent("keydown", { key: "u", ctrlKey: true, altKey: true })),
    ).toBeUndefined()
    expect(
      terminalKeyInput(new KeyboardEvent("keydown", { key: "a", ctrlKey: true })),
    ).toBeUndefined()
  })
})
