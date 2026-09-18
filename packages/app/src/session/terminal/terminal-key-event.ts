export function terminalKeyInput(event: KeyboardEvent) {
  // macOS: Command+Delete clears the terminal input line.
  if (event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
    if (event.key.toLowerCase() === "backspace") return "\x15"
  }
  // Linux/Windows: Control+u clears the terminal input line. Handled explicitly
  // because headless Chromium intercepts Control+u as a browser shortcut before
  // DOM dispatch. The explicit handler fires via attachCustomKeyEventHandler
  // which runs before the browser's default action in headed browsers, and
  // prevents the keystroke from being swallowed.
  if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
    if (event.key.toLowerCase() === "u") return "\x15"
  }
}
