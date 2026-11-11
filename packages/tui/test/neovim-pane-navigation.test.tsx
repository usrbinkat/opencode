import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { EmbeddedTerminalRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect, FileSystem } from "effect"
import { Global } from "@opencode/util/global"
import { makeDaemonTransport, type DaemonAttachment } from "../../core/src/persistent-pty/daemon"
import { createEventStream, createFetch, directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"

test.skipIf(process.platform === "win32").each([false, true])(
  "Neovim boundary keys traverse the daemon and return focus from chat, kitty: %s",
  async (kitty) => {
    await using state = await tmpdir()
    const root = fileURLToPath(new URL("../../../", import.meta.url))
    const binary = fileURLToPath(new URL("../../process-daemon/target/debug/opencode-pty", import.meta.url))
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const daemon = yield* makeDaemonTransport(state.path, "navigation", () => Promise.resolve(binary))
          const created = yield* daemon.request(
            {
              op: "create_pty",
              child_control: true,
              program: "nvim",
              args: [
                "--clean",
                "-i",
                "NONE",
                "--cmd",
                `lua vim.opt.rtp:prepend(${JSON.stringify(root + "sdks/neovim")})`,
                "-c",
                "lua require('opencode.navigation').setup()",
                "-c",
                "call setline(1, 'navigation fixture')",
              ],
              cwd: root,
              env: { TERM: "xterm-256color" },
              group_id: "ses_navigation",
              title: "Neovim",
              cols: 48,
              rows: 30,
            },
            true,
          )
          if (created.type !== "created") throw new Error("Neovim PTY was not created")
          const id = created.process.id
          yield* Effect.addFinalizer(() => daemon.shutdown.pipe(Effect.ignore))
          yield* Effect.tryPromise(async () => {
            const setup = await createTestRenderer({ width: 140, height: 36, kittyKeyboard: kitty })
            await setup.renderer.setupTerminal()
            setup.renderer.start()
            const session = {
              id: "ses_navigation",
              title: "Navigation fixture",
              projectID: "project",
              location: { directory },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: 0, updated: 0 },
            }
            const pty = {
              id: `pty_persistent_${id}`,
              sessionID: session.id,
              title: "Neovim",
              command: "nvim",
              args: [],
              cwd: root,
              status: "running",
              pid: created.process.pid,
              foregroundProcess: "nvim",
              size: { cols: 48, rows: 30 },
              output: { head: 0, tail: 0 },
            }
            const calls = createFetch((url, request) => {
              if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
              if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
              if (url.pathname === `/api/session/${session.id}/message`) return json({ data: [], cursor: {} })
              if (
                url.pathname === `/api/session/${session.id}/inbox` ||
                url.pathname === `/api/session/${session.id}/permission`
              )
                return json({ data: [] })
              if (url.pathname === `/api/experimental/session/${session.id}/terminal`)
                return json({ data: request.method === "POST" ? pty : [pty] })
              if (url.pathname.endsWith("/connect-token")) return json({ data: { ticket: "fixture" } })
              return undefined
            }, createEventStream())
            const failures: unknown[] = []
            const attachments = new Set<DaemonAttachment>()
            const server = Bun.serve<{ attachmentID: string; attachment?: DaemonAttachment; input?: Promise<void> }>({
              port: 0,
              idleTimeout: 0,
              async fetch(request, server) {
                const url = new URL(request.url)
                if (url.pathname.endsWith("/snapshot")) {
                  const snapshot = await Effect.runPromise(daemon.request({ op: "snapshot", id }))
                  if (snapshot.type !== "snapshot" || !snapshot.process.pty) throw new Error("Snapshot unavailable")
                  const info = {
                    ...pty,
                    size: { cols: snapshot.process.pty.cols, rows: snapshot.process.pty.rows },
                    output: { head: snapshot.process.output_head, tail: snapshot.process.output_tail },
                  }
                  return json({
                    data: {
                      info,
                      text: snapshot.text,
                      checkpoint: snapshot.checkpoint_base64,
                      cursor: { x: snapshot.cursor_x, y: snapshot.cursor_y },
                    },
                  })
                }
                if (
                  url.pathname.endsWith("/connect") &&
                  server.upgrade(request, {
                    data: { attachmentID: url.searchParams.get("attachment_id")! },
                  })
                )
                  return undefined
                return calls.fetch(request)
              },
              websocket: {
                async open(socket) {
                  try {
                    const attachment = await Effect.runPromise(
                      daemon.subscribe(id, {
                        cursor: 0,
                        attachmentID: socket.data.attachmentID,
                        role: "controller",
                        takeover: true,
                        onEvent(event) {
                          if (event.type === "output") socket.send(event.data)
                          else if (event.type === "resized")
                            socket.send(
                              JSON.stringify({
                                ...event,
                                checkpoint: Buffer.from(event.checkpoint).toString("base64"),
                              }),
                            )
                          else socket.send(JSON.stringify(event))
                        },
                        onEnd: () => socket.close(),
                      }),
                    )
                    attachments.add(attachment)
                    socket.data.attachment = attachment
                    const size = attachment.terminal.pty!
                    socket.send(
                      JSON.stringify({
                        type: "attached",
                        inputProtocol: 1,
                        role: attachment.role,
                        generation: attachment.generation,
                        info: { ...pty, size: { cols: size.cols, rows: size.rows } },
                      }),
                    )
                    socket.send(attachment.replay.data)
                    socket.send(JSON.stringify({ type: "replay_complete" }))
                    attachment.activate()
                  } catch (error) {
                    failures.push(error)
                    socket.close()
                  }
                },
                message(socket, data) {
                  if (typeof data === "string") return
                  const frame = Buffer.from(data)
                  socket.data.input = (socket.data.input ?? Promise.resolve())
                    .then(async () => {
                      await Effect.runPromise(
                        daemon.request({
                          op: frame[0] === 1 ? "input" : "control",
                          id,
                          attachment_id: socket.data.attachmentID,
                          cols: frame.readUInt16BE(1),
                          rows: frame.readUInt16BE(3),
                          data_base64: frame.subarray(5).toString("base64"),
                        }),
                      )
                    })
                    .catch((error) => {
                      failures.push(error)
                    })
                },
                close(socket) {
                  socket.data.attachment?.detach()
                },
              },
            })
            const { run } = await import("../src/app")
            const task = Effect.runPromise(
              run({
                app: { name: "test", version: "test", channel: "test" },
                server: { endpoint: { url: server.url.toString() } },
                config: {
                  get: async () => ({
                    animations: false,
                    tabs: { mode: "off" },
                    experimental: { "terminal-left": true, "vim-pane-navigation": true },
                  }),
                  update: async () => ({}),
                },
                packages: { prepare: async () => ({ directory: "" }) },
                args: { sessionID: session.id },
                terminalHandoff: async () => ({ renderer: setup.renderer, mode: "dark", complete: () => {} }),
                log: () => {},
              }).pipe(
                Effect.provide(Global.layerWith({ state: state.path + "/tui" })),
                Effect.provide(FileSystem.layerNoop({})),
              ),
            )
            try {
              await setup.waitForVisualIdle()
              await setup.mockInput.typeText("/terminal")
              await setup.waitForFrame((frame) => frame.includes("New terminal"))
              setup.mockInput.pressEnter()
              await setup.waitForFrame((frame) => frame.includes("navigation fixture"), { maxPasses: 200 })
              const terminal = setup.renderer.currentFocusedRenderable
              expect(terminal instanceof EmbeddedTerminalRenderable).toBe(true)
              setup.mockInput.pressKey("l", { ctrl: true })
              await setup.waitForFrame(() => setup.renderer.currentFocusedRenderable !== terminal)
              setup.mockInput.pressKey(kitty ? "h" : "\\", { ctrl: true })
              await setup.waitForFrame(() => setup.renderer.currentFocusedRenderable === terminal)
              setup.mockInput.pressKey("i")
              setup.mockInput.pressKey("l", { ctrl: true })
              await setup.waitForFrame(() => setup.renderer.currentFocusedRenderable !== terminal)
              setup.mockInput.pressKey("\\", { ctrl: true })
              await setup.waitForFrame(() => setup.renderer.currentFocusedRenderable === terminal)
              setup.mockInput.pressKey("\\", { ctrl: true })
              setup.mockInput.pressKey("n", { ctrl: true })
              await setup.waitForFrame((frame) => !frame.includes("-- INSERT --"))
              await setup.mockInput.typeText(":vsplit | wincmd l")
              setup.mockInput.pressEnter()
              await setup.waitForVisualIdle()
              setup.renderer.stdin.emit("data", Buffer.from([0x08]))
              await setup.mockInput.typeText(":call setline(1, 'raw-window-' . winnr())")
              setup.mockInput.pressEnter()
              await setup.waitForFrame((frame) => frame.includes("raw-window-1"))
              const snapshot = await Effect.runPromise(daemon.request({ op: "snapshot", id }))
              if (snapshot.type !== "snapshot") throw new Error("Neovim snapshot unavailable")
              expect(snapshot.text).toContain("raw-window-1")
              expect(failures).toEqual([])
            } finally {
              setup.renderer.destroy()
              await task
              for (const attachment of attachments) attachment.detach()
              await server.stop(true)
            }
          })
        }),
      ),
    )
  },
  30_000,
)
