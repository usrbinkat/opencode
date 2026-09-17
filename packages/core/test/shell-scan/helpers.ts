import { Effect } from "effect"
import { ShellParse } from "../../src/shell/parse.js"

/**
 * Run a ShellParse effect against a process-scoped layer. Use this in test
 * files that mix ShellParse calls with synchronous ShellScan assertions and
 * bun-specific test APIs (test.each, test.skipIf, Bun.spawnSync) where
 * testEffect cannot wrap the entire test body.
 */
export const provide = <A, E>(effect: Effect.Effect<A, E, ShellParse.Service>) =>
  Effect.runPromise(effect.pipe(Effect.provide(ShellParse.layer)))
