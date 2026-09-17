import { expect, test } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

const draftID = "draft_new_session_workspace_branch"
const directory = "C:/OpenCode/WorkspaceBranch"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`

test("selects a base branch for a new workspace", async ({ page }) => {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: "proj_new_session_workspace_branch",
      worktree: directory,
      vcs: "git",
      name: "workspace-branch",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: { all: [], connected: [], default: {} },
    sessions: [],
    pageMessages: () => ({ items: [] }),
    vcsBranches: ["feature/api", "main", "origin/release"],
  })
  await page.route("**/api/vcs/branches?*", (route) => {
    if (new URL(route.request().url()).searchParams.get("search") !== "feature") return route.fallback()
    return route.fulfill({ json: { location: { directory }, data: ["feature/api"] } })
  })
  await page.addInitScript(
    ({ directory, draftID, server }) => {
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
  await expectAppVisible(page.locator('[data-component="composer-editor"]'))
  await page.getByRole("button", { name: "Local", exact: true }).click()
  await page.getByRole("menuitem", { name: "New worktree", exact: true }).click()
  await page.getByRole("button", { name: "from main", exact: true }).click()
  const search = page.getByRole("textbox", { name: "Search branches", exact: true })
  await expect(search).toBeFocused()
  await page.keyboard.type("feature")
  await expect(search).toHaveValue("feature")
  await expect(page.getByRole("menuitemradio")).toHaveText(["feature/api"])
  await expect(search).toBeFocused()
  await page.getByRole("menuitemradio", { name: "feature/api", exact: true }).click()

  const selected = page.getByRole("button", { name: "from feature/api", exact: true })
  await expect(selected).toBeVisible()
  await selected.click()
  await expect(search).toBeFocused()
  await expect(search).toHaveValue("")
  await expect(page.getByRole("menuitemradio", { name: "feature/api", exact: true })).toBeChecked()
  await page.keyboard.press("Escape")

  // Instrument: track activeElement over time after Escape to detect focus theft
  const focusTrace = await page.evaluate(
    (buttonName) =>
      new Promise<
        Array<{
          ms: number
          tag: string
          id: string
          className: string
          dataSlot: string
          role: string
          text: string
          matches: boolean
        }>
      >((resolve) => {
        const btn = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes(buttonName))
        const log: Array<{
          ms: number
          tag: string
          id: string
          className: string
          dataSlot: string
          role: string
          text: string
          matches: boolean
        }> = []
        const start = performance.now()
        const sample = () => {
          const el = document.activeElement
          log.push({
            ms: Math.round(performance.now() - start),
            tag: el?.tagName ?? "null",
            id: el?.id ?? "",
            className: el?.className?.slice(0, 80) ?? "",
            dataSlot: el?.getAttribute("data-slot") ?? "",
            role: el?.getAttribute("role") ?? "",
            text: el?.textContent?.slice(0, 40) ?? "",
            matches: el === btn,
          })
        }
        sample()
        ;[10, 20, 50, 100, 150, 200, 300, 500].forEach((delay) => setTimeout(sample, delay))
        setTimeout(() => {
          sample()
          resolve(log)
        }, 600)
      }),
    "from feature/api",
  )
  console.log("focus trace after Escape:", JSON.stringify(focusTrace, null, 2))

  await expect.poll(() => selected.evaluate((el) => document.activeElement === el), { timeout: 10_000 }).toBe(true)
  await page.keyboard.press("Enter")
  await expect(search).toBeFocused()
  await page.keyboard.type("feature")
  await expect(search).toHaveValue("feature")
  await expect(page.getByRole("menuitemradio")).toHaveText(["feature/api"])
  await page.getByRole("button", { name: "Clear", exact: true }).click()
  await expect(search).toHaveValue("")
  await expect(page.getByRole("menuitemradio")).toHaveText(["feature/api", "main", "origin/release"])
})
