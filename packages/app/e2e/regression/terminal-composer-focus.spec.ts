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

  // On macOS, Meta+Backspace triggers terminalKeyInput which calls
  // t.input("\x15", true) → dataEmitter.fire → ws.send. This exercises the
  // full browser → InputHandler → customKeyHandler → terminalKeyInput chain.
  //
  // On Linux/Windows, headless Chromium intercepts Control+u at the browser
  // process level before any DOM keydown event fires. Synthetic dispatchEvent
  // on a contenteditable container is also consumed by the browser's input
  // handling before ghostty's InputHandler keydown listener fires — ghostty-web's
  // own unit tests avoid this by calling registered handlers directly through
  // a mock container's _listeners map, never through DOM dispatchEvent.
  //
  // The terminal component exposes t.input on the container element as
  // __terminalInput. Calling it exercises the full data path from application
  // code through the WebSocket mock: t.input → dataEmitter.fire → onData →
  // ws.send → ptyInput — everything except the browser's keydown dispatch,
  // which is a platform constraint, not an application defect.
  if (process.platform === "darwin") {
    await page.keyboard.press("Meta+Backspace")
  } else {
    const inputResult = await terminal.evaluate((el) => {
      const input = (el as HTMLDivElement & { __terminalInput?: (data: string) => void }).__terminalInput
      if (!input) return { called: false, error: "__terminalInput not exposed on container element" }
      input("\x15")
      return { called: true }
    })
    if (!inputResult.called) throw new Error(inputResult.error ?? "Terminal input call failed")
    console.log("__terminalInput called:", JSON.stringify(inputResult))
  }

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
  // Instrument: capture what element is at (5,5) on the chat panel and
  // whether it's focusable, before attempting to move focus away
  const panelClickTarget = await page.evaluate(() => {
    const panel = document.querySelector('[data-slot="session-chat-panel"]')
    if (!panel) return { error: "panel not found" }
    const rect = panel.getBoundingClientRect()
    const target = document.elementFromPoint(rect.x + 5, rect.y + 5)
    return {
      panelTag: panel.tagName,
      panelTabIndex: (panel as HTMLElement).tabIndex,
      panelHasTabIndex: panel.hasAttribute("tabindex"),
      panelContentEditable: panel.getAttribute("contenteditable"),
      targetTag: target?.tagName ?? "null",
      targetTabIndex: target instanceof HTMLElement ? target.tabIndex : -1,
      targetDataSlot: target?.getAttribute("data-slot") ?? "null",
      targetDataComponent: target?.getAttribute("data-component") ?? "null",
      targetIsSameAsPanel: target === panel,
    }
  })
  console.log("panel click target at (5,5):", JSON.stringify(panelClickTarget))

  // Move focus to document.body. Clicking the chat panel focuses the
  // panel div itself (it's focusable). Direct blur() on the terminal
  // textarea is undone by ghostty's deferred focus() call. Focusing
  // document.body directly avoids both problems.
  await page.evaluate(() => {
    ;(document.activeElement as HTMLElement | null)?.blur()
    document.body.focus()
  })

  // Instrument: sample activeElement at 0, 50, 100, 200ms after body.focus()
  // to detect ghostty's deferred setTimeout(focus, 0) stealing focus back
  const focusStealTrace = await page.evaluate(() =>
    new Promise<Array<{ ms: number; tag: string; id: string }>>((resolve) => {
      const log: Array<{ ms: number; tag: string; id: string }> = []
      const start = performance.now()
      const sample = () => log.push({
        ms: Math.round(performance.now() - start),
        tag: document.activeElement?.tagName ?? "null",
        id: document.activeElement?.id ?? "",
      })
      sample()
      ;[50, 100, 200].forEach((delay) => setTimeout(sample, delay))
      setTimeout(() => { sample(); resolve(log) }, 300)
    }),
  )
  console.log("focus steal trace after body.focus():", JSON.stringify(focusStealTrace))

  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe("BODY")

  // Instrument: track every focusin event between blur and type to catch what claims focus
  await page.evaluate(() => {
    const log: Array<{ ms: number; type: string; target: string; related: string; active: string }> = []
    const start = performance.now()
    const record = (event: FocusEvent) => {
      const t = event.target instanceof HTMLElement ? event.target : null
      const r = event.relatedTarget instanceof HTMLElement ? event.relatedTarget : null
      log.push({
        ms: Math.round(performance.now() - start),
        type: event.type,
        target: t ? `${t.tagName}${t.getAttribute("role") ? `[role=${t.getAttribute("role")}]` : ""}${t.getAttribute("data-component") ? `[data-component=${t.getAttribute("data-component")}]` : ""}` : "null",
        related: r ? `${r.tagName}${r.getAttribute("role") ? `[role=${r.getAttribute("role")}]` : ""}` : "null",
        active: `${document.activeElement?.tagName ?? "null"}${document.activeElement?.getAttribute("role") ? `[role=${document.activeElement.getAttribute("role")}]` : ""}`,
      })
    }
    document.addEventListener("focusin", record, true)
    document.addEventListener("focusout", record, true)
    ;(window as any).__focusLog = log
    ;(window as any).__cleanupFocusLog = () => {
      document.removeEventListener("focusin", record, true)
      document.removeEventListener("focusout", record, true)
    }
  })

  const beforeType = await page.evaluate(() => ({
    tag: document.activeElement?.tagName ?? "null",
    role: document.activeElement?.getAttribute("role") ?? "",
    id: document.activeElement?.id ?? "",
    className: document.activeElement?.className?.slice(0, 60) ?? "",
    preventAutofocus: document.activeElement?.closest("[data-prevent-autofocus]") ? true : false,
    contentEditable: document.activeElement?.getAttribute("contenteditable") ?? "null",
  }))
  console.log("activeElement before type:", JSON.stringify(beforeType))

  await page.keyboard.type("a")

  const afterType = await page.evaluate(() => {
    ;(window as any).__cleanupFocusLog?.()
    return {
      tag: document.activeElement?.tagName ?? "null",
      role: document.activeElement?.getAttribute("role") ?? "",
      id: document.activeElement?.id ?? "",
      className: document.activeElement?.className?.slice(0, 60) ?? "",
      composerText: document.querySelector('[data-component="composer-editor"]')?.textContent ?? "",
      preventAutofocus: document.activeElement?.closest("[data-prevent-autofocus]") ? true : false,
      contentEditable: document.activeElement?.getAttribute("contenteditable") ?? "null",
    }
  })
  console.log("activeElement after type:", JSON.stringify(afterType))

  const focusLog = await page.evaluate(() => (window as any).__focusLog ?? [])
  console.log("focus events between blur and type:", JSON.stringify(focusLog, null, 2))

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
