# Embedded-terminal navigation

Add `sdks/neovim` to Neovim's runtime path, then call `require("opencode.navigation").setup()` after
configuring your other mappings. Setup installs mappings only inside a terminal exposing OpenCode's
child control environment. It does not launch OpenCode or change standalone Neovim mappings.

Enable **Vim pane navigation** and **Terminal on the left** in OpenCode's Experiments dialog. The
corresponding `cli.json` settings are:

```json
{
  "experimental": {
    "vim-pane-navigation": true,
    "terminal-left": true
  }
}
```

Ctrl+H/J/K/L first run Neovim's left/down/up/right window navigation. Only an unchanged window sends
a boundary request. These directional mappings apply in normal, insert, and terminal modes. In
normal mode, Ctrl+\ first tries the previous Neovim window, then requests the previous OpenCode pane
if no window changes. Insert and terminal modes preserve the native Ctrl+\ Ctrl+N escape. Other keys
and native Ctrl+W commands retain Neovim's behavior.

In chat, the experiment enables Ctrl+H/L and Ctrl+\ for navigation while a terminal or panel is
visible. Ctrl+J inserts a newline and Ctrl+K deletes to the end of the line. Dialogs retain their
own bindings. A direction without a neighbor leaves focus in place and allows ordinary input
handling; navigation never wraps. Chat Ctrl+H navigation requires kitty keyboard input; legacy
Ctrl+H remains Backspace in chat. Ctrl+L and Ctrl+\ work with either encoding. Embedded terminals
forward legacy Ctrl+H/J bytes unchanged so the child application interprets them.

The daemon exports `OPENCODE_PTY_ID`, `OPENCODE_PTY_CONTROL_SOCKET`, and a per-terminal
`OPENCODE_PTY_CONTROL_TOKEN`. The integration sends a length-prefixed JSON `notify_controller`
request to that socket. The token authorizes only messages to that terminal's current controller.
Messages are ephemeral and excluded from terminal output and replay. The TUI accepts only the five
pane navigation commands, on a focused, restored controller attachment with a matching controller
generation. Requests expire after 250 ms; the server discards expired messages even after queue
admission. A successful daemon response acknowledges queue admission, not a focus change.

Shells and other applications receive their ordinary keys. They do not opt into boundary navigation
merely by running inside the built-in terminal.
