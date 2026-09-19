import { expect, test } from "@playwright/test"
import { fixture } from "../performance/timeline/session-timeline-stress.fixture"
import { mockStressTimeline, stressSessionHref } from "../performance/timeline/timeline-test-helpers"

test("summary drawer dismisses and reopens after button, backdrop, Escape, and drag", async ({ page }) => {
  // Instrument: capture ALL console output to find corvu-drawer logs
  page.on("console", (msg) => {
    const text = msg.text()
    if (text.includes("corvu") || text.includes("MobileDrawer") || text.includes("createEffect")) {
      console.log(`[page ${msg.type()}]`, text.slice(0, 500))
    }
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await mockStressTimeline(page)
  await page.goto(stressSessionHref(fixture.targetID))
  const more = page
    .locator('[data-slot="session-mobile-view-navigation"]')
    .getByRole("button", { name: "More options", exact: true })
  const drawer = page.getByRole("dialog", { name: "Session details", exact: true })
  const overlay = page.locator('[data-slot="mobile-drawer-overlay"]')

  for (const dismissal of ["button", "backdrop", "escape", "drag", "button"] as const) {
    await more.click()
    await expect(page.getByRole("menuitem", { name: "Status", exact: true })).toHaveCount(0)
    await page.getByRole("menuitem", { name: "Session details", exact: true }).click()
    await expect(drawer.getByRole("button", { name: "MCP", exact: true })).toBeVisible()
    // Corvu starts opening after paint; the transition flag is also absent
    // before that callback. Wait for the open position before dismissing.
    await expect
      .poll(() => drawer.evaluate((element) => new DOMMatrixReadOnly(getComputedStyle(element).transform).m42))
      .toBe(0)

    // Instrument: capture transitionend events and attribute state on the
    // drawer content to diagnose data-transitioning stalling permanently.
    const transitionLog = await drawer.evaluate((el) => {
      const log: Array<{ ms: number; event: string; detail: string }> = []
      const start = performance.now()
      const handler = (e: TransitionEvent) => {
        if (e.target === el) {
          log.push({ ms: Math.round(performance.now() - start), event: "transitionend", detail: e.propertyName })
        }
      }
      el.addEventListener("transitionend", handler)
      // Also check the current computed transition property
      const style = getComputedStyle(el)
      log.push({
        ms: 0,
        event: "initial-state",
        detail: JSON.stringify({
          transitionProperty: style.transitionProperty,
          transitionDuration: style.transitionDuration,
          transform: style.transform,
          dataTransitioning: el.hasAttribute("data-transitioning"),
          dataOpening: el.hasAttribute("data-opening"),
        }),
      })
      ;(window as any).__panelTransitionLog = log
      ;(window as any).__panelTransitionCleanup = () => el.removeEventListener("transitionend", handler)
      return log[0]
    })
    console.log(`[${dismissal}] drawer initial state:`, JSON.stringify(transitionLog))

    await expect(drawer).not.toHaveAttribute("data-transitioning")

    // Read and log transition events that fired
    const events = await page.evaluate(() => {
      ;(window as any).__panelTransitionCleanup?.()
      return (window as any).__panelTransitionLog ?? []
    })
    console.log(`[${dismissal}] drawer transition log:`, JSON.stringify(events))
    if (dismissal === "button") await drawer.getByRole("button", { name: "Close", exact: true }).click()
    if (dismissal === "backdrop") await overlay.click({ position: { x: 10, y: 10 } })
    if (dismissal === "escape") await page.keyboard.press("Escape")
    if (dismissal === "drag") {
      const handle = drawer.locator('[data-slot="mobile-drawer-handle"]')
      const bounds = await handle.boundingBox()
      expect(bounds).not.toBeNull()
      await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2)
      await page.mouse.down()
      await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2 + 1)
      await page.mouse.move(bounds!.x + bounds!.width / 2, 843)
      await page.mouse.up()
    }
    await expect(drawer, `dismissal: ${dismissal}`).toBeHidden()
    await expect(overlay).toHaveCount(0)
    await expect(more).toBeFocused()
  }
})
