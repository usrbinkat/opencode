import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ShellParse } from "../../src/shell/parse.js"
import { ShellScan } from "../../src/shell/scan.js"
import { Wildcard } from "../../src/util/wildcard.js"
import { testEffect } from "../lib/effect"

const it = testEffect(ShellParse.layer)

function parity(source: string) {
  return Effect.gen(function* () {
    const legacy = yield* ShellParse.scan(source, "/bin/bash", "/workspace")
    const native = yield* ShellParse.scanPortable(source, "/bin/bash", "/workspace")
    expect(native, source).toEqual(legacy)
  })
}

describe("Bash redirect resource oracle", () => {
  for (const [source, resources] of [
    ["printf hello | cat > marker", ["printf hello", "cat"]],
    ["printf ok && git status > output", ["printf ok", "git status"]],
    ["cat > output", ["cat > output"]],
    ["cat > output | cat", ["cat > output", "cat"]],
    ["pwd | > output cat > tail", ["pwd", "> output cat"]],
    ["pwd && cat > output file", ["pwd", "cat"]],
    ["pwd; cat > output", ["pwd", "cat > output"]],
    ["pwd\ncat > output", ["pwd", "cat > output"]],
  ] as const) {
    it.effect(`matches exact permission resources: ${source}`, () =>
      Effect.gen(function* () {
        const legacy = yield* ShellParse.scan(source, "/bin/bash", "/workspace")
        expect(legacy.commands.map((command) => command.resource)).toEqual([...resources])
        yield* parity(source)
      }),
    )
  }

  it.effect("matches redirect positions across generated list and pipeline boundaries", () =>
    Effect.gen(function* () {
      const redirects = [">output", ">>output", "<input", "2>err", "2>&1", "<&0", ">|output", "&>output", "&>>output"]
      const separators = [" | ", " |& ", " && ", " || ", "; ", " & ", "\n"]
      for (const redirect of redirects) {
        for (const command of [
          `${redirect} git status`,
          `git ${redirect} status`,
          `git status ${redirect}`,
          `${redirect} git status 3>tail`,
          `${redirect} FOO=bar git status 3>tail`,
          `npm run ${redirect} test`,
        ]) {
          yield* parity(command)
          for (const separator of separators) {
            yield* parity(`printf ok${separator}${command}`)
            yield* parity(`${command}${separator}pwd >last`)
          }
        }
      }
    }),
  )

  for (const source of [
    "pwd | cat >out | tail >log",
    "pwd && cat >out || tail >log",
    "pwd && cat >out | tail >log",
    "pwd | cat >out && tail >log",
    "pwd |\n\n# comment\ncat >out",
    "pwd &&\n# comment\ncat >out",
    "pwd | cat >out # comment\ncat >log",
    "pwd | cat # comment\n>out cat",
    "pwd | cat \\\n 2>out",
    "pwd | cat a\\\n>out",
    "pwd | cat 2\\\n>out",
    "pwd && FOO=bar >output git status 3>tail",
    "(cat >out) | tail >log",
    "{ cat >out; } && tail >log",
    "(pwd | cat >out) >group",
    "(cat >out) >$(printf log) && cat >tail",
    "(cat >out); cat >tail",
    "echo $(pwd | cat >out) >outer",
    'echo "$(pwd && cat >out)" | cat >outer',
    "echo `pwd | cat >out` >outer",
    "pwd | cat >$(printf out)",
    'pwd | cat >"$(printf out)"',
    "pwd | cat >$(printf out | cat >inner)",
    "pwd | cat >out $(printf arg) >tail",
    "pwd | cat <(printf input) > >(cat >log)",
    "cat <(pwd | cat >out) | cat >tail",
    "pwd | cat >out <(printf arg) >tail",
    "pwd | cat '>' \"2>out\" escaped\\>word >out",
    "pwd | cat '2'>out",
    "pwd | cat 2\\>out",
    "if true; then printf ok && cat >$(printf path); fi",
    "if true; then printf ok && git >out status; else cat >log; fi",
    "pwd && cd >out /outside",
    "time git status",
    "time -p git status",
    "coproc git status",
  ]) {
    it.effect(`preserves nested commands, prefixes, and context: ${source}`, () => parity(source))
  }

  test("keeps lexical words and nested redirect-target commands after narrowing the resource", () => {
    const result = ShellScan.scan('pwd | git >"$(printf output)" status')
    expect(result.kind).toBe("scanned")
    if (result.kind !== "scanned") throw new Error(`Unexpected opacity: ${result.reason}`)
    expect(result.commands[1]).toMatchObject({
      resource: "git",
      words: ["git", "status"],
      rawWords: ["git", "status"],
      redirectWordCount: 1,
    })
    expect(result.commands[2]).toMatchObject({ resource: "printf output", rawWords: ["printf", "output"] })
  })

  it.effect("excludes ignored trailing continuations from narrowed command prefixes", () =>
    Effect.gen(function* () {
      const source = "pwd | cat\\\n >out"
      const legacy = yield* ShellParse.scan(source, "/bin/bash", "/workspace")
      const result = ShellScan.scan(source)
      expect(result.kind).toBe("scanned")
      if (result.kind !== "scanned") throw new Error(`Unexpected opacity: ${result.reason}`)
      expect(result.commands.map((command) => command.resource)).toEqual(
        legacy.commands.map((command) => command.resource),
      )
      expect(result.commands[1]?.rawWords).toEqual(["cat"])
      expect(legacy.commands[1]).toEqual({ resource: "cat", save: "cat *" })
      const native = yield* ShellParse.scanPortable(source, "/bin/bash", "/workspace")
      expect(native).toEqual(legacy)
      expect(native.commands.every((command) => Wildcard.match(command.resource, command.save))).toBe(true)
    }),
  )

  for (const source of ["cat\\\n", "cat \\\n", "cat\\\n\\\n", "cat\\\n;", "cat >out\\\n", "cat >out \\\n"]) {
    it.effect(`saved prefixes cover their standalone continuation command: ${JSON.stringify(source)}`, () =>
      Effect.gen(function* () {
        yield* parity(source)
        const result = ShellScan.scan(source)
        expect(result.kind).toBe("scanned")
        if (result.kind !== "scanned") throw new Error(result.reason)
        expect(result.commands[0]?.rawWords).toEqual(["cat"])
        const native = yield* ShellParse.scanPortable(source, "/bin/bash", "/workspace")
        expect(native.commands[0]).toEqual({ resource: source.includes(">out") ? "cat >out" : "cat", save: "cat *" })
        expect(native.commands.every((command) => Wildcard.match(command.resource, command.save))).toBe(true)
      }),
    )
  }

  for (const source of [
    "printf 'literal\\\n'\\\n",
    'printf "literal\\\n"\\\n',
    "printf a\\\nb\\\n",
    'printf a\\\n""\\\n',
  ]) {
    it.effect(
      `preserves meaningful raw syntax before an ignored trailing continuation: ${JSON.stringify(source)}`,
      () =>
        Effect.gen(function* () {
          yield* parity(source)
          const result = ShellScan.scan(source)
          expect(result.kind).toBe("scanned")
          if (result.kind !== "scanned") throw new Error(result.reason)
          expect(result.commands[0]?.resource).toBe(source.slice(0, -2))
          expect(result.commands[0]?.rawWords).toEqual(["printf", source.slice("printf ".length, -2)])
        }),
    )
  }

  it.effect("known gap: assignment then redirect on a pipeline RHS retains the native command", () =>
    Effect.gen(function* () {
      const source = "printf ok | FOO=bar >output git status 3>tail"
      const legacy = yield* ShellParse.scan(source, "/bin/bash", "/workspace")
      const native = yield* ShellParse.scanPortable(source, "/bin/bash", "/workspace")
      expect(legacy.commands).toEqual([{ resource: "printf ok", save: "printf *" }])
      expect(native.commands).toEqual([
        { resource: "printf ok", save: "printf *" },
        { resource: "FOO=bar >output git status", save: "git status *" },
      ])
    }),
  )
})
