import { describe, expect, test } from "bun:test"
import { Effect } from "effect"

const forbidden = /["']@opencode\/(?:core|sdk|server)(?:\/[^"']*)?["']/
const oldSession = /(?:SessionV1|session-v1|legacy-message|legacy-message-values)/

describe("Session UI package boundaries", () => {
  test(
    "does not import server runtime packages",
    async () => {
      expect(await findViolations(forbidden)).toEqual([])
    },
    15_000,
  )

  test("does not declare server runtime dependencies", async () => {
    const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json()
    const dependencies = pkg.dependencies as Record<string, string>

    expect(dependencies["@opencode/core"]).toBeUndefined()
    expect(dependencies["@opencode/sdk"]).toBeUndefined()
    expect(dependencies["@opencode/server"]).toBeUndefined()
  })

  test("does not contain old Session message boundaries", async () => {
    expect(await findViolations(oldSession)).toEqual([])
  })

  test("exports the current Session document surface", async () => {
    const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json()
    const exports = pkg.exports as Record<string, string>

    expect(exports["./actions"]).toBe("./src/actions.ts")
    expect(exports["./document"]).toBe("./src/document.ts")
    expect(exports["./message"]).toBe("./src/message/current-message.tsx")
    expect(exports["./message-part"]).toBe("./src/components/message-part.tsx")
    expect(exports["./timeline"]).toBe("./src/timeline/session-timeline.tsx")
    expect(exports["./timeline/projection"]).toBe("./src/timeline/projection.ts")
  })
})

// Every boundary check scans the same sources; read them once so only the first check pays the I/O.
let sources: Promise<Array<{ path: string; text: string }>> | undefined

function readSources() {
  sources ??= Array.fromAsync(new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: import.meta.dir, absolute: true })).then(
    (files) =>
      Effect.runPromise(
        Effect.forEach(
          files.filter((path) => path !== import.meta.path),
          (path) =>
            Effect.promise(async () => ({
              path: path.slice(import.meta.dir.length + 1),
              text: await Bun.file(path).text(),
            })),
          { concurrency: 8 },
        ),
      ),
  )
  return sources
}

async function findViolations(pattern: RegExp) {
  return (await readSources()).filter((source) => pattern.test(source.text)).map((source) => source.path)
}
