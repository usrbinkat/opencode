import { test, type TestOptions } from "bun:test"
import { Cause, Effect, Exit, Layer, type Scope } from "effect"
import { TestClock, TestConsole } from "effect/testing"
import { FetchHttpClient } from "effect/unstable/http"

type Body<A, E, R> = Effect.Effect<A, E, R> | (() => Effect.Effect<A, E, R>)

const body = <A, E, R>(value: Body<A, E, R>) => Effect.suspend(() => (typeof value === "function" ? value() : value))

const loopback = new Set(["127.0.0.1", "localhost", "[::1]"])

// Core is env-free, so nothing tells the default node graph to stay offline;
// a test that boots it would phone home through FetchHttpClient. Every
// FetchHttpClient reads this reference at request time, so refusing here covers
// each node that shares the default client, while an explicit HttpClient
// replacement never reaches it. Callers such as ModelsDev swallow request
// failures, so the harness also records the attempt and fails the test itself.
export const refuseNetwork = (violations: string[]): typeof fetch =>
  Object.assign(
    (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (loopback.has(new URL(url).hostname)) return fetch(input, init)
      const method = init?.method ?? (input instanceof Request ? input.method : "GET")
      const message = `test attempted network request: ${method} ${url} — provide an explicit HttpClient or disable the fetch`
      violations.push(message)
      return Promise.reject(new Error(message))
    },
    { preconnect: fetch.preconnect },
  )

const run = <A, E, R, E2>(value: Body<A, E, R | Scope.Scope>, layer: Layer.Layer<R, E2>) =>
  Effect.gen(function* () {
    const violations: string[] = []
    const exit = yield* body(value).pipe(
      Effect.scoped,
      Effect.provide(layer),
      Effect.provideService(FetchHttpClient.Fetch, refuseNetwork(violations)),
      Effect.exit,
    )
    if (Exit.isFailure(exit)) {
      for (const err of Cause.prettyErrors(exit.cause)) {
        yield* Effect.logError(err)
      }
    }
    if (violations.length > 0) return yield* Effect.fail(new Error(violations.join("\n")))
    return yield* exit
  }).pipe(Effect.runPromise)

type EffectTest<R> = {
  <A, E>(name: string, value: Body<A, E, R | Scope.Scope>, opts?: number | TestOptions): void
  only: <A, E>(name: string, value: Body<A, E, R | Scope.Scope>, opts?: number | TestOptions) => void
  skip: <A, E>(name: string, value: Body<A, E, R | Scope.Scope>, opts?: number | TestOptions) => void
  skipIf: (condition: boolean) => EffectTest<R>
  each: <T extends readonly unknown[]>(
    table: readonly T[],
  ) => (name: string, fn: (...args: T) => Body<unknown, unknown, R | Scope.Scope>, opts?: number | TestOptions) => void
}

function wrapTest<R>(register: typeof test, layer: Layer.Layer<R, unknown>): EffectTest<R> {
  const fn = <A, E>(name: string, value: Body<A, E, R | Scope.Scope>, opts?: number | TestOptions) =>
    register(name, () => run(value, layer), opts)

  fn.only = <A, E>(name: string, value: Body<A, E, R | Scope.Scope>, opts?: number | TestOptions) =>
    register.only(name, () => run(value, layer), opts)

  fn.skip = <A, E>(name: string, value: Body<A, E, R | Scope.Scope>, opts?: number | TestOptions) =>
    register.skip(name, () => run(value, layer), opts)

  fn.skipIf = (condition: boolean): EffectTest<R> => wrapTest(test.skipIf(condition) as typeof test, layer)

  fn.each = <T extends readonly unknown[]>(table: readonly T[]) =>
    (name: string, factory: (...args: T) => Body<unknown, unknown, R | Scope.Scope>, opts?: number | TestOptions) => {
      for (const row of table) {
        const args = (Array.isArray(row) ? row : [row]) as unknown as T
        const interpolated = args.reduce<string>(
          (acc, arg, index) => acc.replace(/%[sdjiop%#]/, () => (index < args.length ? String(arg) : "")),
          name,
        )
        register(interpolated, () => run(factory(...args), layer), opts)
      }
    }

  return fn
}

const make = <R, E>(testLayer: Layer.Layer<R, E>, liveLayer: Layer.Layer<R, E>) => {
  const effect = wrapTest(test, testLayer)
  const live = wrapTest(test, liveLayer)
  return { effect, live }
}

// Test environment with TestClock and TestConsole
const testEnv = Layer.mergeAll(TestConsole.layer, TestClock.layer())

// Live environment - uses real clock, but keeps TestConsole for output capture
const liveEnv = TestConsole.layer

export const it = make(testEnv, liveEnv)

export const testEffect = <R, E>(layer: Layer.Layer<R, E>) =>
  make(Layer.provideMerge(layer, testEnv), Layer.provideMerge(layer, liveEnv))
