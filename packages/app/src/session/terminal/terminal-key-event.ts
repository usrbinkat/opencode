export function terminalKeyInput(event: KeyboardEvent) {
  // Command/Meta+Delete clears the terminal input line on every platform.
  if (event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
    if (event.key.toLowerCase() === "backspace") return "\x15"
  }
  // Control+U is a browser shortcut; in headed browsers the keydown reaches the terminal's custom key
  // handler first, and mapping it here sends line-kill to the PTY on every platform.
  if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
    if (event.key.toLowerCase() === "u") return "\x15"
  }
}
