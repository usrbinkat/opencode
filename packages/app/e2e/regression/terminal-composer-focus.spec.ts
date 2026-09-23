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

  // terminalKeyInput maps both line-kill bindings to \x15 on every platform: Command/Meta+Delete, then Ctrl+U.
  await page.keyboard.press("Meta+Backspace")
  await expect.poll(() => ptyInput.join("")).toBe("\x15")

  // Headless Chromium consumes a pressed Ctrl+U before any DOM keydown, so dispatch it to the textarea. The keydown
  // takes the production path: attachCustomKeyEventHandler -> terminalKeyInput -> t.input("\x15", true).
  const dispatch = await terminal.evaluate((el) => {
    const textarea = el.querySelector("textarea")
    if (!textarea) throw new Error("Terminal textarea not found")
    const seen: string[] = []
    const record = (event: Event) => seen.push(event.currentTarget === textarea ? "textarea" : "container")
    el.addEventListener("keydown", record, true)
    textarea.addEventListener("keydown", record, true)
    const event = new KeyboardEvent("keydown", { key: "u", code: "KeyU", ctrlKey: true, bubbles: true, cancelable: true })
    textarea.dispatchEvent(event)
    el.removeEventListener("keydown", record, true)
    textarea.removeEventListener("keydown", record, true)
    return { seen, defaultPrevented: event.defaultPrevented, connected: textarea.isConnected }
  })
  // The dispatch record is reported only on failure: which listeners saw the keydown and whether the textarea was live.
  await expect.poll(() => ptyInput.join(""), { message: JSON.stringify(dispatch) }).toBe("\x15\x15")
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
  // Record focus moves from the blur onward so a failure names what claimed focus, not only where it ended.
  await page.evaluate(() => {
    const moves: string[] = []
    document.addEventListener(
      "focusin",
      (event) => {
        const target = event.target instanceof HTMLElement ? event.target : undefined
        const component = target?.getAttribute("data-component")
        moves.push(target ? `${target.tagName.toLowerCase()}${component ? `[data-component=${component}]` : ""}` : "null")
      },
      true,
    )
    ;(window as Window & { __focusMoves?: string[] }).__focusMoves = moves
  })
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  // Focus must stay released before typing; a failure names the element that took it back.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const tag = document.activeElement?.tagName ?? "none"
        if (tag === "BODY") return tag
        const moves = (window as Window & { __focusMoves?: string[] }).__focusMoves ?? []
        return `${tag} after focusin ${moves.join(" > ") || "(none)"}`
      }),
    )
    .toBe("BODY")
  await page.keyboard.type("a")

  // toHaveText checks keystroke routing and toBeFocused the focus state; either failure reports the focused element,
  // composer identity checks and the focusin sequence since the blur.
  const focusState = () =>
    page.evaluate(() => {
      const active = document.activeElement
      const composer = document.querySelector('[data-component="composer-editor"]')
      return {
        activeTag: active?.tagName ?? "null",
        activeRole: active?.getAttribute("role") ?? "null",
        activeId: active?.id ?? "",
        activeClass: typeof active?.className === "string" ? active.className.slice(0, 60) : "",
        activeDataComponent: active?.getAttribute("data-component") ?? "null",
        activeContentEditable: active?.getAttribute("contenteditable") ?? "null",
        preventAutofocus: !!active?.closest("[data-prevent-autofocus]"),
        composerExists: !!composer,
        composerCount: document.querySelectorAll('[data-component="composer-editor"]').length,
        identityMatch: active === composer,
        containsMatch: composer?.contains(active) ?? false,
        dataComponentMatch: active?.getAttribute("data-component") === "composer-editor",
        composerText: composer?.textContent ?? "",
        focusMoves: (window as Window & { __focusMoves?: string[] }).__focusMoves ?? [],
      }
    })
  const report = async (error: Error) => {
    throw new Error(`${error.message}\n${JSON.stringify(await focusState())}`)
  }
  await expect(composer).toHaveText("a").catch(report)
  await expect(composer).toBeFocused().catch(report)
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
