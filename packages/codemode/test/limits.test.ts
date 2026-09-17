import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { CodeMode } from "../src/index.js"
import { MAX_ARRAY_LENGTH, MAX_PENDING_PROMISES, MAX_STRING_LENGTH } from "../src/interpreter/limits.js"

const runtime = CodeMode.make({ tools: {} })

const value = async (code: string) => {
  const result = await Effect.runPromise(runtime.execute(code))
  if (!result.ok) throw new Error(`expected success, got ${result.error.kind}: ${result.error.message}`)
  return result.value
}

const failure = async (code: string) => {
  const result = await Effect.runPromise(runtime.execute(code))
  if (result.ok) throw new Error(`expected failure, got value ${JSON.stringify(result.value)}`)
  return result.error.message
}

const S = MAX_STRING_LENGTH
const A = MAX_ARRAY_LENGTH

describe("one built-in cannot build an unbounded value", () => {
  test("strings: repeat, pad, concat, join, +, template, JSON.stringify", async () => {
    expect(await value(`return "x".repeat(${S}).length`)).toBe(S)
    for (const code of [
      `"x".repeat(${S + 1})`,
      `"x".padStart(${S + 1})`,
      `"x".padEnd(${S + 1}, "y")`,
      `"x".repeat(${S}).concat("y")`,
      `["x".repeat(${S}), "y"].join("")`,
      `"x".repeat(${S}) + "y"`,
      `\`\${"x".repeat(${S})}y\``,
      `JSON.stringify("x".repeat(${S}))`,
    ]) {
      expect(await failure(`try { ${code} } catch (e) { throw Error(e.name + ": " + e.message) }`)).toContain(
        "RangeError: Invalid string length",
      )
    }
  })

  // split and matchAll share the same result check but must build ten million items first to reach it,
  // which is too slow for CI.
  test("arrays: constructor, length, Array.from, concat, flat", async () => {
    expect(await value(`return Array(${A}).length`)).toBe(A)
    for (const code of [
      `Array(${A + 1})`,
      `const a = []; a.length = ${A + 1}`,
      `Array.from({ length: ${A + 1} })`,
      `Array(${A}).concat([1])`,
      `[Array(${A}).fill(0), [1]].flat()`,
    ]) {
      expect(await failure(`try { ${code} } catch (e) { throw Error(e.name + ": " + e.message) }`)).toContain(
        "RangeError: Invalid array length",
      )
    }
  })

  // TODO: Promise.all path takes 8.4s on ubuntu-24.04 GHA runners (973ms Windows).
  // Investigate Effect fiber-per-promise overhead in src/interpreter/promises.ts create().
  test(
    "promises: too many pending at once, while settled ones do not count",
    async () => {
    const n = MAX_PENDING_PROMISES
    const t0 = performance.now()
    expect(await value(`for (let i = 0; i < ${n * 2}; i++) Promise.resolve(i); return 1`)).toBe(1)
    const t1 = performance.now()
    console.log(`resolved ${n * 2} promises in ${(t1 - t0).toFixed(0)}ms`)
    const t2 = performance.now()
    expect(
      await failure(
        `try { for (let i = 0; i <= ${n}; i++) new Promise(() => {}) } catch (e) { throw Error(e.name + ": " + e.message) }`,
      ),
    ).toContain("RangeError: Too many pending promises")
    const t3 = performance.now()
    console.log(`pending promise limit (loop) in ${(t3 - t2).toFixed(0)}ms`)
    const t4 = performance.now()
    expect(await failure(`await Promise.all(Array(${n + 1}).fill(0).map(() => new Promise(() => {})))`)).toContain(
      "Too many pending promises",
    )
    const t5 = performance.now()
    console.log(`pending promise limit (Promise.all) in ${(t5 - t4).toFixed(0)}ms`)
    },
    20_000,
  )
})
