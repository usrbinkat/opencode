import { expect, spyOn, test } from "bun:test";
import { BoxRenderable, EmbeddedTerminalRenderable, type Renderable, ScrollBoxRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { Effect, FileSystem } from "effect";
import { Global } from "@opencode/util/global";
import { createEventStream, createFetch, directory, json } from "./fixture/tui-client";
import { tmpdir } from "./fixture/fixture";
import type { Config } from "../src/config";

test
  .skipIf(process.platform === "win32")
  .each(
    [80, 120, 180].flatMap((width) =>
      [false, true].flatMap((left) =>
        [false, true].flatMap((kitty) => [false, true].map((vim) => ({ width, left, kitty, vim })))
      )
    )
  )(
  "session wheel scrolling preserves pane focus at $width, terminal left: $left, kitty: $kitty, vim: $vim",
  async ({ width, left, kitty, vim }) => {
    await using state = await tmpdir();
    const setup = await createTestRenderer({ width, height: 36, kittyKeyboard: kitty });
    await setup.renderer.setupTerminal();
    setup.renderer.start();
    const session = {
      id: "ses_wheel",
      title: "Wheel focus fixture",
      projectID: "project",
      location: { directory },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 0, updated: 0 },
    };
    const pty = {
      id: "pty_fixture",
      sessionID: session.id,
      title: "Terminal",
      command: "/bin/sh",
      args: [],
      cwd: directory,
      status: "running",
      pid: 1,
      foregroundProcess: null,
      size: { cols: 48, rows: 30 },
      output: { head: 0, tail: 0 },
    };
    const text = Array.from({ length: 100 }, (_, index) => `Terminal line ${index}`).join("\r\n");
    const messages = Array.from({ length: 20 }, (_, index) => ({
      id: `message-${index}`,
      type: "user",
      text: `History message ${String(index).padStart(4, "0")}`,
      time: { created: index },
    }));
    const creations: { childControl?: boolean }[] = [];
    const calls = createFetch(async (url, request) => {
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} });
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session });
      if (url.pathname === `/api/session/${session.id}/message`)
        return json({ data: messages.toReversed(), cursor: {} });
      if (url.pathname === `/api/session/${session.id}/inbox`) return json({ data: [] });
      if (url.pathname === `/api/session/${session.id}/permission`) return json({ data: [] });
      if (url.pathname === `/api/experimental/session/${session.id}/terminal`) {
        if (request.method === "POST") creations.push(await request.json());
        return json({ data: request.method === "POST" ? pty : [pty] });
      }
      if (url.pathname === "/api/experimental/persistent-pty/pty_fixture/snapshot")
        return json({
          data: { info: pty, text, checkpoint: Buffer.from(text).toString("base64"), cursor: { x: 16, y: 29 } },
        });
      if (url.pathname === "/api/experimental/persistent-pty/pty_fixture/connect-token")
        return json({ data: { ticket: "fixture" } });
      return undefined;
    }, createEventStream());
    let notify: ((message: string, generation?: number, expires_at?: number) => void) | undefined;
    const input: Uint8Array[] = [];
    const server = Bun.serve({
      port: 0,
      idleTimeout: 0,
      fetch(request, server) {
        if (new URL(request.url).pathname.endsWith("/connect") && server.upgrade(request)) return undefined;
        return calls.fetch(request);
      },
      websocket: {
        open(socket) {
          notify = (message, generation = 1, expires_at = Date.now() + 250) => {
            socket.send(JSON.stringify({ type: "controller_message", message, generation, expires_at }));
          };
          socket.send(
            JSON.stringify({ type: "attached", inputProtocol: 1, role: "controller", generation: 1, info: pty })
          );
          socket.send(JSON.stringify({ type: "replay_complete" }));
        },
        message(_socket, data) {
          if (typeof data !== "string") input.push(new Uint8Array(data));
        },
      },
    });
    const { run } = await import("../src/app");
    let configReads = 0;
    let info: Config.Info = {
      animations: false,
      tabs: { mode: "off" },
      experimental: { "terminal-left": left, "vim-pane-navigation": vim },
      keybinds: { "pane.navigate.previous": "<leader>o" },
    };
    const configPath = `${state.path}/cli.json`;
    await Bun.write(configPath, JSON.stringify(info));
    const task = Effect.runPromise(
      run({
        app: { name: "test", version: "test", channel: "test" },
        server: { endpoint: { url: server.url.toString() } },
        config: {
          path: configPath,
          get: async () => {
            configReads++;
            return structuredClone(info);
          },
          update: async (mutate) => {
            mutate(info);
            return structuredClone(info);
          },
        },
        packages: { prepare: async () => ({ directory: "" }) },
        args: { sessionID: session.id },
        terminalHandoff: async () => ({ renderer: setup.renderer, mode: "dark", complete: () => {} }),
        log: () => {},
      }).pipe(Effect.provide(Global.layerWith({ state: state.path })), Effect.provide(FileSystem.layerNoop({})))
    );
    try {
      await setup.waitForFrame((frame) => frame.includes("History message 0019"));
      await setup.mockInput.typeText("remove");
      setup.mockInput.pressKey("a", { ctrl: true });
      setup.mockInput.pressKey("k", { ctrl: true });
      await setup.waitForVisualIdle();
      expect(setup.renderer.currentFocusedEditor?.plainText).toBe("");
      setup.mockInput.pressKey("j", { ctrl: true });
      await setup.waitForVisualIdle();
      expect(setup.renderer.currentFocusedEditor?.plainText).toBe("\n");
      setup.renderer.stdin.emit("data", Buffer.from([0x08]));
      await setup.waitForVisualIdle();
      expect(setup.renderer.currentFocusedEditor?.plainText).toBe("");
      await setup.mockInput.typeText("/terminal");
      await setup.waitForFrame((frame) => frame.includes("New terminal"));
      setup.mockInput.pressEnter();
      await setup.waitForFrame((frame) => frame.includes("Terminal line 99"));
      expect(creations).toHaveLength(1);
      expect(creations[0]?.childControl).toBe(vim ? true : undefined);
      setup.mockInput.pressKey("x", { ctrl: true });
      setup.mockInput.pressArrow(left ? "right" : "left");
      await setup.waitForVisualIdle();
      expect(setup.renderer.currentFocusedRenderable instanceof EmbeddedTerminalRenderable).toBe(false);
      const find = (root: Renderable): ScrollBoxRenderable | undefined =>
        root instanceof ScrollBoxRenderable && root.getRenderable("message-19")
          ? root
          : root.getChildren().map(find).find(Boolean);
      const scroll = find(setup.renderer.root);
      if (!scroll) throw new Error("Session scrollbox not found");
      expect(scroll.scrollTop).toBeGreaterThan(0);
      const before = scroll.scrollTop;
      await setup.mockMouse.scroll(scroll.viewport.x + 2, scroll.viewport.y + 2, "up");
      await setup.waitForVisualIdle();
      expect(scroll.scrollTop).toBeLessThan(before);
      scroll.scrollTo(Infinity);
      await setup.waitForVisualIdle();
      setup.mockInput.pressKey("x", { ctrl: true });
      setup.mockInput.pressArrow(left ? "left" : "right");
      const terminal = setup.renderer.currentFocusedRenderable;
      if (!(terminal instanceof EmbeddedTerminalRenderable)) throw new Error("Terminal was not focused");
      expect(terminal.x < scroll.x).toBe(left);
      await setup.waitForVisualIdle();
      if (!vim) {
        terminal.blur();
        setup.mockInput.pressKey("x", { ctrl: true });
        setup.mockInput.pressArrow(left ? "left" : "right");
        await setup.waitForVisualIdle();
        expect(setup.renderer.currentFocusedRenderable).toBe(terminal);
        const encode = spyOn(terminal, "handleKeyPress");
        try {
          setup.renderer.stdin.emit("data", Buffer.from([0x08]));
          setup.renderer.stdin.emit("data", Buffer.from([0x0a]));
          await setup.waitForVisualIdle();
          expect(encode).toHaveBeenCalledTimes(2);
          if (!notify) throw new Error("Terminal socket was not attached");
          notify(left ? "pane.focus.right" : "pane.focus.left");
          notify(left ? "pane.navigate.right" : "pane.navigate.left");
          await setup.waitForVisualIdle();
          expect(setup.renderer.currentFocusedRenderable).toBe(terminal);
          setup.mockInput.pressKey("x", { ctrl: true });
          setup.mockInput.pressArrow(left ? "right" : "left");
          await setup.waitForVisualIdle();
          const prompt = setup.renderer.currentFocusedRenderable;
          if (!prompt) throw new Error("Prompt was not focused");
          prompt.blur();
          setup.mockInput.pressKey("x", { ctrl: true });
          setup.mockInput.pressArrow(left ? "right" : "left");
          await setup.waitForVisualIdle();
          expect(setup.renderer.currentFocusedRenderable).toBe(prompt);
        } finally {
          encode.mockRestore();
        }
        return;
      }
      setup.mockInput.pressKey("x", { ctrl: true });
      setup.mockInput.pressKey("o");
      await setup.waitForVisualIdle();
      expect(setup.renderer.currentFocusedRenderable).not.toBe(terminal);
      setup.mockInput.pressKey("x", { ctrl: true });
      setup.mockInput.pressKey("o");
      await setup.waitForVisualIdle();
      expect(setup.renderer.currentFocusedRenderable).toBe(terminal);
      for (const key of ["h", "j", "k", "l", "\\"]) {
        setup.mockInput.pressKey(key, { ctrl: true });
      }
      await setup.waitForVisualIdle();
      expect(setup.renderer.currentFocusedRenderable).toBe(terminal);
      expect(input.some((frame) => frame.length > 5)).toBe(true);
      const startInput = input.length;
      setup.renderer.stdin.emit("data", Buffer.from([0x08]));
      setup.renderer.stdin.emit("data", Buffer.from([0x0a]));
      await setup.waitForVisualIdle();
      expect(
        input
          .slice(startInput)
          .filter((frame) => frame[0] === 1)
          .map((frame) => Buffer.from(frame.subarray(5)).toString("hex"))
      ).toEqual(["08", "0a"]);
      if (!notify) throw new Error("Terminal socket was not attached");
      notify("session.new");
      notify(left ? "pane.focus.right" : "pane.focus.left");
      notify(left ? "pane.navigate.right" : "pane.navigate.left", 0);
      notify("pane.navigate.up");
      notify("pane.navigate.down");
      notify(left ? "pane.navigate.left" : "pane.navigate.right");
      await setup.waitForVisualIdle();
      expect(setup.renderer.currentFocusedRenderable).toBe(terminal);
      notify(left ? "pane.navigate.right" : "pane.navigate.left", 1, 1);
      await setup.waitForFrame(() => setup.renderer.currentFocusedRenderable !== terminal);
      const chat = setup.renderer.currentFocusedRenderable;
      notify(left ? "pane.navigate.left" : "pane.navigate.right");
      await setup.waitForVisualIdle();
      expect(setup.renderer.currentFocusedRenderable === chat).toBe(true);
      await setup.mockInput.typeText("keepREMOVE");
      for (let i = 0; i < 6; i++) setup.mockInput.pressArrow("left");
      setup.mockInput.pressKey("k", { ctrl: true });
      await setup.waitForVisualIdle();
      expect(setup.renderer.currentFocusedEditor?.plainText).toBe("keep");
      setup.mockInput.pressKey("j", { ctrl: true });
      await setup.mockInput.typeText("next");
      await setup.waitForVisualIdle();
      expect(setup.renderer.currentFocusedEditor?.plainText).toBe("keep\nnext");
      setup.mockInput.pressKey("a", { ctrl: true });
      setup.mockInput.pressKey("k", { ctrl: true });
      setup.renderer.stdin.emit("data", Buffer.from([0x08]));
      setup.mockInput.pressKey("a", { ctrl: true });
      setup.mockInput.pressKey("k", { ctrl: true });
      await setup.waitForVisualIdle();
      expect(setup.renderer.currentFocusedEditor?.plainText).toBe("");
      expect(setup.renderer.currentFocusedRenderable).toBe(chat);
      setup.mockInput.pressKey(kitty ? (left ? "h" : "l") : "\\", { ctrl: true });
      await setup.waitForFrame(() => setup.renderer.currentFocusedRenderable === terminal);
      notify("pane.navigate.previous");
      await setup.waitForFrame(() => setup.renderer.currentFocusedRenderable !== terminal);
      setup.mockInput.pressKey("\\", { ctrl: true });
      await setup.waitForFrame(() => setup.renderer.currentFocusedRenderable === terminal);
      const focused = scroll.scrollTop;
      await setup.mockMouse.scroll(scroll.viewport.x + 2, scroll.viewport.y + 2, "up");
      await setup.waitForVisualIdle();
      expect(scroll.scrollTop).toBeLessThan(focused);
      expect(setup.renderer.currentFocusedRenderable).toBe(terminal);
      expect(setup.captureCharFrame()).toContain("Jump to latest");
      await setup.mockMouse.scroll(scroll.viewport.x + 2, scroll.viewport.y + 2, "down");
      await setup.waitForVisualIdle();
      expect(scroll.scrollTop).toBe(focused);
      expect(setup.renderer.currentFocusedRenderable).toBe(terminal);
      await setup.mockMouse.scroll(scroll.viewport.x + 2, scroll.viewport.y + scroll.viewport.height + 2, "up");
      await setup.waitForVisualIdle();
      expect(scroll.scrollTop).toBe(focused);
      expect(setup.renderer.currentFocusedRenderable).toBe(terminal);
      const clicks: number[] = [];
      scroll.onMouseUp = () => clicks.push(1);
      await setup.mockMouse.click(scroll.viewport.x + 2, scroll.viewport.y + 2);
      await setup.waitForVisualIdle();
      expect(setup.renderer.currentFocusedRenderable).not.toBe(terminal);
      expect(clicks).toHaveLength(0);
      await setup.mockMouse.click(scroll.viewport.x + 2, scroll.viewport.y + 2);
      await setup.waitForVisualIdle();
      expect(clicks).toHaveLength(1);
      setup.mockInput.pressEscape();
      await setup.waitForVisualIdle();
      const sessionFocus = setup.renderer.currentFocusedRenderable;
      const terminalFrame = () =>
        setup
          .captureCharFrame()
          .split("\n")
          .map((line) => line.slice(terminal.x, terminal.x + terminal.width))
          .join("\n");
      const terminalBefore = terminalFrame();
      await setup.mockMouse.scroll(terminal.x + 2, terminal.y + 2, "up");
      await setup.waitForVisualIdle();
      expect(terminalFrame()).not.toBe(terminalBefore);
      expect(setup.renderer.currentFocusedRenderable).toBe(sessionFocus);

      setup.mockInput.pressKey("x", { ctrl: true });
      setup.mockInput.pressArrow(left ? "left" : "right");
      await setup.waitForVisualIdle();
      const findHandle = (root: Renderable): BoxRenderable | undefined =>
        root instanceof BoxRenderable && root.zIndex === 10 && root.width === 2
          ? root
          : root.getChildren().map(findHandle).find(Boolean);
      const handle = findHandle(setup.renderer.root);
      if (!handle) throw new Error("Separator handle not found");
      const start = handle.x;
      const end = start + (left ? -4 : 4);
      await setup.mockMouse.drag(start, 10, end, 10);
      await setup.waitForVisualIdle();
      expect(handle.x).toBe(end);
      expect(setup.renderer.currentFocusedRenderable).toBe(terminal);
      info = { ...info, experimental: { ...info.experimental, "vim-pane-navigation": false } };
      const reads = configReads;
      await Bun.write(configPath, JSON.stringify(info));
      await setup.waitForFrame(() => configReads > reads);
      await setup.waitForVisualIdle();
      const encode = spyOn(terminal, "handleKeyPress");
      try {
        notify(left ? "pane.navigate.right" : "pane.navigate.left");
        setup.renderer.stdin.emit("data", Buffer.from([0x08]));
        setup.renderer.stdin.emit("data", Buffer.from([0x0a]));
        await setup.waitForVisualIdle();
        expect(encode).toHaveBeenCalledTimes(2);
        expect(setup.renderer.currentFocusedRenderable).toBe(terminal);
      } finally {
        encode.mockRestore();
      }
    } finally {
      setup.renderer.destroy();
      await task;
      await server.stop();
    }
  }
);
