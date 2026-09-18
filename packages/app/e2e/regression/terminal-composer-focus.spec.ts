import { base64Encode, checksum } from "@opencode/util/encode"
import { expect, test, type Page } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/OpenCode/TerminalComposerFocus"
const projectID = "proj_terminal_composer_focus"
const sessionID = "ses_terminal_composer_focus"
const ptyID = "pty_terminal_composer_focus"
const newPtyID = "pty_terminal_composer_focus_new"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
const ptyInput: string[] = []
let sendPtyOutput: ((data: string) => void) | undefined

test.use({ viewport: { width: 1440, height: 900 } })

test.beforeEach(async ({ page }) => {
  ptyInput.length = 0
  sendPtyOutput = undefined
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "terminal-composer-focus",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: { test: { id: "test", name: "Test", limit: { context: 200_000 } } },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "test" },
    },
    sessions: [
      {
        id: sessionID,
        slug: "terminal-composer-focus",
        projectID,
        directory,
        title: "Terminal composer focus",
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await page.route("**/api/pty*", (route) => {
    expect(new URL(route.request().url()).searchParams.get("location[directory]")).toBe(directory)
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ location: ptyLocation(), data: ptyInfo(ptyID, "Terminal 1") }),
    })
  })
  await page.route(`**/api/pty/${ptyID}*`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ location: ptyLocation(), data: ptyInfo(ptyID, "Terminal 1") }),
    }),
  )
  await page.route(`**/api/pty/${ptyID}/connect-token*`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ location: ptyLocation(), data: { ticket: "e2e-ticket", expires_in: 60 } }),
    }),
  )
  await page.routeWebSocket(new RegExp(`/api/pty/${ptyID}/connect`), (ws) => {
    ws.onMessage((message) => ptyInput.push(message.toString()))
    sendPtyOutput = (data) => ws.send(data)
  })
})

test("clears the terminal line with Command+Delete", async ({ page }) => {
  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, "Terminal composer focus")

  const terminal = page.locator('[data-component="terminal"]')
  await page.keyboard.press("Control+Backquote")
  await expect(terminal.locator("textarea")).toHaveCount(1)
  await expect.poll(() => sendPtyOutput).toBeDefined()
  await expect.poll(() => terminal.evaluate((el) => el.contains(document.activeElement)), { timeout: 10_000 }).toBe(true)

  // Instrument: capture keydown visibility on both the container and textarea
  await terminal.evaluate((el) => {
    const textarea = el.querySelector("textarea")
    const log: Array<{
      target: string
      currentTarget: string
      key: string
      code: string
      ctrlKey: boolean
      metaKey: boolean
      defaultPrevented: boolean
      phase: number
      activeElement: string
    }> = []
    for (const [name, node] of [["container", el], ["textarea", textarea]] as const) {
      if (!node) continue
      node.addEventListener(
        "keydown",
        (event) => {
          const e = event as KeyboardEvent
          log.push({
            target: e.target === textarea ? "textarea" : e.target === el ? "container" : String(e.target),
            currentTarget: name,
            key: e.key,
            code: e.code,
            ctrlKey: e.ctrlKey,
            metaKey: e.metaKey,
            defaultPrevented: e.defaultPrevented,
            phase: e.eventPhase,
            activeElement: document.activeElement === textarea ? "textarea" : document.activeElement === el ? "container" : document.activeElement?.tagName ?? "null",
          })
        },
        true,
      )
    }
    ;(window as any).__keydownLog = log
    // Save references for identity verification in the dispatch evaluate
    ;(window as any).__instrumentedTextarea = textarea
    ;(window as any).__instrumentedContainer = el
  })

  // On macOS, Meta+Backspace maps to \x15 via terminalKeyInput. On Linux/Windows,
  // Control+u maps to \x15 via the same handler. Headless Chromium intercepts
  // Control+u at the browser process level before any DOM event fires, so
  // page.keyboard.press and CDP Input.dispatchKeyEvent both fail to deliver the
  // keystroke. Dispatch a synthetic KeyboardEvent directly to the focused
  // textarea via page.evaluate — this exercises the same attachCustomKeyEventHandler
  // → terminalKeyInput → t.input("\x15", true) code path that fires in
  // production headed browsers.
  if (process.platform === "darwin") {
    await page.keyboard.press("Meta+Backspace")
  } else {
    const dispatchResult = await terminal.evaluate((el) => {
      const textarea = el.querySelector("textarea")
      // Intercept WebSocket.send to detect if data reaches the socket
      const wsSendCalls: Array<{ data: string; readyState: number }> = []
      const origSend = WebSocket.prototype.send
      WebSocket.prototype.send = function (this: WebSocket, data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        wsSendCalls.push({ data: String(data), readyState: this.readyState })
        return origSend.call(this, data)
      }
      const instrumentedTextarea = (window as any).__instrumentedTextarea as HTMLTextAreaElement | undefined
      const instrumentedContainer = (window as any).__instrumentedContainer as HTMLElement | undefined
      const diag: Record<string, unknown> = {
        textareaExists: !!textarea,
        textareaParentIsContainer: textarea?.parentElement === el,
        containerDataComponent: el.getAttribute("data-component"),
        activeElementBeforeDispatch: document.activeElement === textarea ? "textarea" : document.activeElement === el ? "container" : document.activeElement?.tagName ?? "null",
        keydownLogRef: Array.isArray((window as any).__keydownLog),
        keydownLogLengthBefore: ((window as any).__keydownLog as unknown[])?.length ?? -1,
        terminalElementCount: document.querySelectorAll('[data-component="terminal"]').length,
        // Identity verification: detect if textarea/container re-mounted between evaluates
        textareaSameAsInstrumented: textarea === instrumentedTextarea,
        containerSameAsInstrumented: el === instrumentedContainer,
        instrumentedTextareaConnected: instrumentedTextarea?.isConnected ?? null,
        instrumentedContainerConnected: instrumentedContainer?.isConnected ?? null,
        currentTextareaConnected: textarea?.isConnected ?? null,
      }
      if (!textarea) {
        WebSocket.prototype.send = origSend
        return { ...diag, error: "textarea not found", dispatched: false, wsSendCalls }
      }
      try {
        const event = new KeyboardEvent("keydown", {
          key: "u",
          code: "KeyU",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        })
        const result = textarea.dispatchEvent(event)
        WebSocket.prototype.send = origSend
        return {
          ...diag,
          dispatched: true,
          dispatchReturnValue: result,
          defaultPrevented: event.defaultPrevented,
          keydownLogLengthAfter: ((window as any).__keydownLog as unknown[])?.length ?? -1,
          wsSendCalls,
        }
      } catch (err) {
        WebSocket.prototype.send = origSend
        return { ...diag, dispatched: false, error: String(err), wsSendCalls }
      }
    })
    console.log("dispatchEvent diagnostics:", JSON.stringify(dispatchResult, null, 2))
  }

  // Read instrumentation before the assertion so we get diagnostics on failure
  const keydownLog = await page.evaluate(() => (window as any).__keydownLog ?? [])
  console.log("keydown instrumentation:", JSON.stringify(keydownLog, null, 2))

  await expect.poll(() => ptyInput.join("")).toBe("\x15")
})

test("hides the native contenteditable caret", async ({ page }) => {
  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, "Terminal composer focus")

  await page.keyboard.press("Control+Backquote")
  const terminal = page.locator('[data-component="terminal"]')
  await expect(terminal).toHaveAttribute("contenteditable", "true")
  await expect(terminal).toHaveCSS("caret-color", "rgba(0, 0, 0, 0)")
})

test("reveals the terminal after its first server output renders", async ({ page }) => {
  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, "Terminal composer focus")

  await page.keyboard.press("Control+Backquote")
  const terminal = page.locator('[data-component="terminal"]')
  await expect(terminal).toHaveAttribute("contenteditable", "true")
  await expect(terminal).toHaveCSS("opacity", "0")
  await expect.poll(() => sendPtyOutput).toBeDefined()

  sendPtyOutput?.("\x1b[?25h")
  await expect(terminal).toHaveCSS("opacity", "0")

  sendPtyOutput?.("ready")
  await expect(terminal).toHaveCSS("opacity", "1")
})

test("routes typing to the composer unless the open terminal is focused", async ({ page }) => {
  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, "Terminal composer focus")

  const composer = page.locator('[data-component="composer-editor"]')
  const terminal = page.locator('[data-component="terminal"]')
  await composer.click()
  await expect(composer).toBeFocused()
  await page.keyboard.press("Control+Backquote")
  await expect(terminal).toBeVisible()
  await expect.poll(() => terminal.evaluate((element) => element.contains(document.activeElement))).toBe(true)

  await page.keyboard.type("x")
  await expect(composer).toHaveText("")

  await page.waitForTimeout(300)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())

  // Instrument: capture activeElement before and after typing to diagnose focus routing
  const beforeType = await page.evaluate(() => ({
    tag: document.activeElement?.tagName ?? "null",
    role: document.activeElement?.getAttribute("role") ?? "",
    id: document.activeElement?.id ?? "",
    className: document.activeElement?.className?.slice(0, 60) ?? "",
  }))
  console.log("activeElement before type:", JSON.stringify(beforeType))

  await page.keyboard.type("a")

  const afterType = await page.evaluate(() => ({
    tag: document.activeElement?.tagName ?? "null",
    role: document.activeElement?.getAttribute("role") ?? "",
    id: document.activeElement?.id ?? "",
    className: document.activeElement?.className?.slice(0, 60) ?? "",
    composerText: document.querySelector('[data-component="composer-editor"]')?.textContent ?? "",
  }))
  console.log("activeElement after type:", JSON.stringify(afterType))

  await expect.poll(() => composer.evaluate((el) => document.activeElement === el), { timeout: 10_000 }).toBe(true)
  await expect(composer).toHaveText("a")
})

test("keeps composer focus when a cached terminal finishes mounting", async ({ page }) => {
  const ghostty = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const created = { count: 0 }
  await page.route("**/api/pty*", (route) => {
    created.count += 1
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ location: ptyLocation(), data: ptyInfo(ptyID, "Terminal 1") }),
    })
  })
  await page.route(/ghostty-web/, async (route) => {
    ghostty.resolve()
    await release.promise
    await route.continue()
  })
  await seedCachedTerminal(page)

  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`, { waitUntil: "commit" })
  await expectSessionTitle(page, "Terminal composer focus")

  const composer = page.locator('[data-component="composer-editor"]')
  const terminal = page.locator('[data-component="terminal"]')
  await expect(terminal).toBeVisible()
  expect(created.count).toBe(0)
  await ghostty.promise
  await composer.click()
  await expect(composer).toBeFocused()

  release.resolve()
  await expect(terminal.locator("textarea")).toHaveCount(1)
  await page.waitForTimeout(300)
  await expect(composer).toBeFocused()
})

test("keeps newer composer focus while an explicit terminal open finishes", async ({ page }) => {
  const ghostty = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  await page.route(/ghostty-web/, async (route) => {
    ghostty.resolve()
    await release.promise
    await route.continue()
  })

  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, "Terminal composer focus")

  const composer = page.locator('[data-component="composer-editor"]')
  const terminal = page.locator('[data-component="terminal"]')
  await page.keyboard.press("Control+Backquote")
  await expect(terminal).toBeVisible()
  await ghostty.promise
  await composer.click()
  await expect(composer).toBeFocused()

  release.resolve()
  await expect(terminal.locator("textarea")).toHaveCount(1)
  await page.waitForTimeout(50)
  await expect(composer).toBeFocused()
})

test("focuses a terminal created from the new-terminal button", async ({ page }) => {
  const created = { count: 0 }
  await page.route("**/api/pty*", (route) => {
    created.count += 1
    const next = created.count === 1 ? ptyInfo(ptyID, "Terminal 1") : ptyInfo(newPtyID, "Terminal 2")
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ location: ptyLocation(), data: next }),
    })
  })
  await page.route(`**/api/pty/${newPtyID}*`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ location: ptyLocation(), data: ptyInfo(newPtyID, "Terminal 2") }),
    }),
  )
  await page.route(`**/api/pty/${newPtyID}/connect-token*`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ location: ptyLocation(), data: { ticket: "e2e-ticket", expires_in: 60 } }),
    }),
  )
  await page.routeWebSocket(new RegExp(`/api/pty/${newPtyID}/connect`), () => undefined)

  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, "Terminal composer focus")

  const composer = page.locator('[data-component="composer-editor"]')
  const terminal = page.locator('[data-component="terminal"]')
  await page.keyboard.press("Control+Backquote")
  await expect(terminal.locator("textarea")).toHaveCount(1)
  await composer.click()
  await expect(composer).toBeFocused()

  await page.getByRole("button", { name: "New terminal" }).click()
  await expect(page.getByRole("tab", { name: "Terminal 2" })).toHaveAttribute("aria-selected", "true")
  const active = page.locator(`#terminal-wrapper-${newPtyID} [data-component="terminal"]`)
  await expect.poll(() => active.evaluate((element) => element.contains(document.activeElement))).toBe(true)
})

function seedCachedTerminal(page: Page) {
  return page.addInitScript(
    ({ terminalKey, ptyID, tabKey, server, sessionID }) => {
      localStorage.setItem(
        "opencode.window.browser.dat:tabs.panes",
        JSON.stringify({ [tabKey]: { terminal: true, terminalHeight: 320 } }),
      )
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify([{ type: "session", server, sessionId: sessionID }]),
      )
      localStorage.setItem(
        terminalKey,
        JSON.stringify({
          active: ptyID,
          all: [{ id: ptyID, title: "Terminal 1", titleNumber: 1 }],
        }),
      )
    },
    {
      terminalKey: terminalStorageKey(),
      ptyID,
      tabKey: `${server}\n/server/${base64Encode(server)}/session/${sessionID}`,
      server,
      sessionID,
    },
  )
}

function terminalStorageKey() {
  const dir = base64Encode(directory)
  const head = dir.slice(0, 12).replace(/[^a-zA-Z0-9._-]/g, "-")
  return `opencode.workspace.${head}.${checksum(dir) ?? "0"}.dat:workspace:terminal`
}

function ptyLocation() {
  return { directory, project: { id: projectID, directory, canonical: directory } }
}

function ptyInfo(id: string, title: string) {
  return { id, title, command: "cmd.exe", args: [], cwd: directory, status: "running", pid: 1 }
}
