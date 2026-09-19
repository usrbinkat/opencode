import { expect, test, type Locator } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

const draftID = "draft_large_paste"
const directory = "/repo/large-paste"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`

test.use({ permissions: ["clipboard-read", "clipboard-write"] })

test.beforeEach(async ({ page }) => {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: "proj_large_paste",
      worktree: directory,
      vcs: "git",
      name: "large-paste",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: { all: [], connected: [], default: {} },
    sessions: [],
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript(
    ({ directory, draftID, server }) => {
      localStorage.setItem("opencode-theme-id", "oc-2")
      localStorage.setItem("opencode-color-scheme", "dark")
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify([{ type: "draft", draftID, server, directory }]),
      )
    },
    { directory, draftID, server },
  )
  await page.goto(`/new-session?draftId=${draftID}`)
  const input = page.locator('[data-component="composer-editor"]')
  await expectAppVisible(input)
  await expect(input).toBeEditable()
  await expect
    .poll(() => input.evaluate((element) => getComputedStyle(element, "::before").content))
    .toBe(`"${String.fromCodePoint(0x200b)}"`)
  await input.click()
})

for (const lines of [6000, 25000]) {
  test(`keeps a ${lines}-line crash report editable in a new session`, async ({ page }) => {
    const input = page.getByRole("textbox", { name: "Prompt", exact: true })
    const text = "Thread 0 Crashed:\n" + "0   Example  0x0000000100000000 frame + 32\n".repeat(lines) + "End of report"
    await page.evaluate((text) => navigator.clipboard.writeText(text), text)
    const events = await input.evaluateHandle((element) => {
      const events = { count: 0 }
      element.addEventListener("input", () => events.count++)
      return events
    })
    await page.keyboard.press("ControlOrMeta+V")
    await expect.poll(async () => (await input.innerText()) === text).toBe(true)
    expect(await events.evaluate((events) => events.count)).toBe(1)
    await expect(input).toBeFocused()
    await expectCaretVisible(input)
    const scroll = page.locator('[data-component="composer-scroll"]')
    await expect(scroll.locator(".scroll-view__viewport")).toHaveCSS("scrollbar-width", "none")
    await expect(scroll.locator(".scroll-view__thumb")).toBeVisible()
    await page.keyboard.type("!")
    await expect.poll(async () => (await input.innerText()) === text + "!").toBe(true)
    await expectCaretVisible(input)
    const thumb = await scroll.locator(".scroll-view__thumb").boundingBox()
    const bounds = await scroll.boundingBox()
    if (!thumb || !bounds) throw new Error("Missing composer scrollbar bounds")
    await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2)
    await page.mouse.down()
    await page.mouse.move(thumb.x + thumb.width / 2, bounds.y + 8 + thumb.height / 2)
    await page.mouse.up()
    await expect(scroll.locator(".scroll-view__viewport")).toHaveJSProperty("scrollTop", 0)
    await expect(input).toBeFocused()
    await page.keyboard.press("ControlOrMeta+Home")
    await page.keyboard.press("ControlOrMeta+End")
    await expectCaretVisible(input)
  })
}

async function expectCaretVisible(input: Locator) {
  // Instrument: set up a continuous sampler inside the page that logs every
  // poll iteration's state so we can diagnose which condition fails over time
  await input.evaluate((element) => {
    const log: Array<{
      ms: number
      isCollapsed: boolean
      rangeCount: number
      containsAnchor: boolean
      caretHeight: number
      caretTop: number
      caretBottom: number
      viewportTop: number
      viewportBottom: number
      scrollTop: number
      scrollHeight: number
      result: boolean
      failReason: string
    }> = []
    const start = performance.now()
    ;(window as any).__caretVisLog = log
    ;(window as any).__caretVisSample = () => {
      const selection = window.getSelection()
      const scrollable = element.closest("[data-scrollable]") ?? element
      const viewport = scrollable.getBoundingClientRect()
      const isCollapsed = selection?.isCollapsed ?? false
      const rangeCount = selection?.rangeCount ?? 0
      const containsAnchor = selection?.anchorNode ? element.contains(selection.anchorNode) : false
      const caret = rangeCount ? selection!.getRangeAt(0).getBoundingClientRect() : null
      const caretHeight = caret?.height ?? 0
      const caretTop = caret?.top ?? 0
      const caretBottom = caret?.bottom ?? 0
      const viewportTop = viewport.top
      const viewportBottom = viewport.bottom
      const scrollTop = scrollable instanceof HTMLElement ? scrollable.scrollTop : 0
      const scrollHeight = scrollable instanceof HTMLElement ? scrollable.scrollHeight : 0

      let failReason = "pass"
      if (!isCollapsed) failReason = "not-collapsed"
      else if (!rangeCount) failReason = "no-range"
      else if (!containsAnchor) failReason = "anchor-outside"
      else if (caretHeight <= 0) failReason = "zero-height"
      else if (caretTop < viewportTop - 1) failReason = "above-viewport"
      else if (caretBottom > viewportBottom + 1) failReason = "below-viewport"

      const result = failReason === "pass"
      log.push({
        ms: Math.round(performance.now() - start),
        isCollapsed, rangeCount, containsAnchor,
        caretHeight, caretTop, caretBottom,
        viewportTop, viewportBottom,
        scrollTop, scrollHeight,
        result, failReason,
      })
      return result
    }
  })

  await expect
    .poll(() =>
      input.evaluate(() => (window as any).__caretVisSample?.() ?? false),
    )
    .toBe(true)

  // Read and log the full sample history on both pass and fail
  const caretLog = await input.evaluate(() => {
    const log = (window as any).__caretVisLog ?? []
    delete (window as any).__caretVisLog
    delete (window as any).__caretVisSample
    return log
  })
  // Log first 5, last 5, and any transitions between pass/fail
  const summary = [
    ...caretLog.slice(0, 5),
    ...(caretLog.length > 10 ? [{ _gap: caretLog.length - 10 }] : []),
    ...caretLog.slice(-5),
  ]
  console.log("expectCaretVisible samples:", JSON.stringify(summary, null, 2))
}

for (const width of [390, 1280]) {
  for (const direction of ["ltr", "rtl"]) {
    test(`reveals a multiline paste in the middle at ${width}px in ${direction}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 })
      await page.evaluate((direction) => (document.documentElement.dir = direction), direction)
      const input = page.getByRole("textbox", { name: "Prompt", exact: true })
      const suffix = "\nExisting trailing content".repeat(100)
      await input.fill("Before " + suffix)
      await input.press("ControlOrMeta+Home")

      // Instrument: capture caret position and dir resolution before and after arrow
      const beforeArrow = await input.evaluate((el) => {
        const sel = window.getSelection()
        const computed = getComputedStyle(el)
        return {
          dir: el.getAttribute("dir"),
          computedDirection: computed.direction,
          docDir: document.documentElement.dir,
          anchorOffset: sel?.anchorOffset ?? -1,
          focusOffset: sel?.focusOffset ?? -1,
          anchorNodeText: sel?.anchorNode?.textContent?.slice(0, 20) ?? "null",
          isCollapsed: sel?.isCollapsed ?? false,
        }
      })
      console.log(`[${direction}] before arrow:`, JSON.stringify(beforeArrow))

      // The editor uses dir="auto" which resolves to LTR for Latin text
      // ("Before "). ArrowRight moves forward in LTR content regardless
      // of the document's direction attribute.
      await input.press("ArrowRight")

      const afterArrow = await input.evaluate(() => {
        const sel = window.getSelection()
        return {
          anchorOffset: sel?.anchorOffset ?? -1,
          focusOffset: sel?.focusOffset ?? -1,
          anchorNodeText: sel?.anchorNode?.textContent?.slice(0, 20) ?? "null",
          isCollapsed: sel?.isCollapsed ?? false,
        }
      })
      console.log(`[${direction}] after arrow:`, JSON.stringify(afterArrow))
      const text = "Pasted line /tmp/example.ts 123 \u0645\u0631\u062d\u0628\u0627\n".repeat(100) + "End of paste"
      await page.evaluate((text) => navigator.clipboard.writeText(text), text)
      await page.keyboard.press("ControlOrMeta+V")

      // Instrument: capture selection state and content immediately after paste
      const afterPaste = await input.evaluate((el) => {
        const sel = window.getSelection()
        const content = (el as HTMLElement).innerText
        return {
          anchorOffset: sel?.anchorOffset ?? -1,
          focusOffset: sel?.focusOffset ?? -1,
          isCollapsed: sel?.isCollapsed ?? false,
          contentFirst20: content.slice(0, 20),
          contentLast20: content.slice(-20),
          contentLength: content.length,
        }
      })
      console.log(`[${direction}] after paste:`, JSON.stringify(afterPaste))

      await expect.poll(() => input.innerText()).toBe("B" + text + "efore " + suffix)
      await expectCaretVisible(input)
      await page.keyboard.type("!")
      await expect.poll(() => input.innerText()).toBe("B" + text + "!efore " + suffix)
      await expectCaretVisible(input)
    })
  }
}

for (const text of [
  "single line <b> &amp;",
  "first\nsecond",
  "\n\n  indented\ttext  \n\nlast\n\n",
  'literal <b>bold</b> &amp; & < > "quotes"\n<script>not code</script>\n<img src="example">',
  "first\r\nsecond\rthird",
]) {
  test(`preserves text and native undo: ${JSON.stringify(text)}`, async ({ page }) => {
    const input = page.getByRole("textbox", { name: "Prompt", exact: true })
    await page.evaluate((text) => navigator.clipboard.writeText(text), text)
    await page.keyboard.press("ControlOrMeta+V")
    const expected = text.replace(/\r\n?/g, "\n")
    await expect.poll(() => input.innerText()).toBe(expected)
    await expect(input.locator("b, script, img")).toHaveCount(0)
    await page.keyboard.press("ControlOrMeta+Z")
    await expect(input).toBeEmpty()
    await page.keyboard.press("ControlOrMeta+Shift+Z")
    await expect.poll(() => input.innerText()).toBe(expected)
  })
}

test("replaces only the selected text and leaves the caret after the paste", async ({ page }) => {
  const input = page.getByRole("textbox", { name: "Prompt", exact: true })
  await page.evaluate(() => navigator.clipboard.writeText("one\ntwo"))
  await page.keyboard.type("before replace after")
  await expect(input).toHaveText("before replace after")
  await page.evaluate(() => document.fonts.ready)
  const word = await input.evaluate((element) => {
    const range = document.createRange()
    range.setStart(element.firstChild!, 7)
    range.setEnd(element.firstChild!, 14)
    const rect = range.getBoundingClientRect()
    return { x: rect.x, y: rect.y + rect.height / 2, width: rect.width }
  })
  await page.mouse.move(word.x, word.y)
  await page.mouse.down()
  await page.mouse.move(word.x + word.width, word.y, { steps: 5 })
  await page.mouse.up()
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe("replace")
  await page.keyboard.press("ControlOrMeta+V")
  await expect.poll(() => input.innerText()).toBe("before one\ntwo after")
  await page.keyboard.press("ControlOrMeta+Z")
  await expect(input).toHaveText("before replace after")
  await page.keyboard.press("ControlOrMeta+Shift+Z")
  await expect.poll(() => input.innerText()).toBe("before one\ntwo after")
  await page.keyboard.type("!")
  await expect.poll(() => input.innerText()).toBe("before one\ntwo! after")
})
