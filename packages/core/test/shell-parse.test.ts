import { describe, expect } from "bun:test"
import { Effect } from "effect"
import os from "os"
import path from "path"
import { ShellParse } from "@opencode/core/shell/parse"
import { testEffect } from "./lib/effect"

const it = testEffect(ShellParse.layer)

describe("ShellParse", () => {
  it.effect("splits bash commands and derives reusable prefixes", () =>
    Effect.gen(function* () {
      const result = yield* ShellParse.scan("git status && npm run test -- --watch", "/bin/bash", "/workspace")
      expect(result).toEqual({
        commands: [
          { resource: "git status", save: "git status *" },
          { resource: "npm run test -- --watch", save: "npm run test *" },
        ],
        directories: [],
      })
    }),
  )

  it.effect("portable scanning preserves supported command resources and directories", () =>
    Effect.gen(function* () {
      const commands = [
        "git status && npm run test -- --watch",
        "echo $(curl evil | sed s/x/y/)",
        "cd /tmp/$USER && git status",
        "if true; then printf yes; else printf no; fi",
        "if true; then export X=$(printf value); unset X; fi",
        "if export X=$(printf value); then printf done; fi",
        "export X=value >$(printf output)",
        "echo $((1 + 1))",
        "cd ~; cd src&&cd ..; pwd",
      ]

      for (const command of commands) {
        const legacy = yield* ShellParse.scan(command, "/bin/bash", "/workspace")
        const portable = yield* ShellParse.scan(command, "/bin/bash", "/workspace", { portable: true })
        expect(portable, command).toEqual(legacy)
        expect(yield* ShellParse.scanPortable(command, "/bin/bash", "/workspace")).toEqual(portable)
      }
    }),
  )

  it.effect("portable scanning handles heredocs with the existing permission resource", () =>
    Effect.gen(function* () {
      const command = "cat <<'EOF'\nstatic body\nEOF"
      const legacy = yield* ShellParse.scan(command, "/bin/bash", "/workspace")
      expect(legacy.commands).toEqual([{ resource: command, save: "cat *" }])
      expect(yield* ShellParse.scan(command, "/bin/bash", "/workspace", { portable: true })).toEqual(legacy)
    }),
  )

  for (const command of ['c"\\d" relative', "'cd' /tmp", "c''d /tmp", "c\\\nd /tmp"]) {
    it.effect(
      `portable scanning keeps source-shaped command heads under shell authorization: ${command}`,
      () =>
        Effect.gen(function* () {
          const portable = yield* ShellParse.scan(command, "/bin/bash", "/workspace", { portable: true })
          expect(portable.commands.map((item) => item.resource)).toEqual([command])
          expect(portable.directories).toEqual([])
        }),
    )
  }

  for (const name of ["declare", "typeset", "export", "readonly", "local", "unset", "unsetenv"]) {
    it.effect(
      `preserves declaration permission behavior for ${name} without hiding nested commands`,
      () =>
        Effect.gen(function* () {
          for (const command of [`${name} X`, `${name} "$(printf X)"; git status`]) {
            const legacy = yield* ShellParse.scan(command, "/bin/bash", "/workspace")
            expect(legacy.commands).toEqual(
              command.includes("$(")
                ? [
                    { resource: "printf X", save: "printf *" },
                    { resource: "git status", save: "git status *" },
                  ]
                : [],
            )
            expect(yield* ShellParse.scan(command, "/bin/bash", "/workspace", { portable: true })).toEqual(legacy)
          }

          for (const command of [
            `"${name}" X`,
            `FOO=bar ${name} X`,
            `command ${name} X`,
            `>${name}.txt ${name} X`,
          ]) {
            const legacy = yield* ShellParse.scan(command, "/bin/bash", "/workspace")
            expect(legacy.commands).toHaveLength(1)
            expect(yield* ShellParse.scan(command, "/bin/bash", "/workspace", { portable: true })).toEqual(legacy)
          }
        }),
    )
  }

  it.effect("declaration filtering retains directory checks inside command substitutions", () =>
    Effect.gen(function* () {
      const command = "export X=$(cd /outside; printf value)"
      const expected = { commands: [{ resource: "printf value", save: "printf *" }], directories: ["/outside"] }
      expect(yield* ShellParse.scan(command, "/bin/bash", "/workspace")).toEqual(expected)
      expect(yield* ShellParse.scan(command, "/bin/bash", "/workspace", { portable: true })).toEqual(expected)
    }),
  )

  it.effect("does not treat PowerShell commands as Bash declarations", () =>
    Effect.gen(function* () {
      expect(yield* ShellParse.scanPortable("export X; unset X", "pwsh", "/workspace")).toEqual({
        commands: [
          { resource: "export X", save: "export *" },
          { resource: "unset X", save: "unset *" },
        ],
        directories: [],
      })
    }),
  )

  it.effect("splits PowerShell commands case-insensitively", () =>
    Effect.gen(function* () {
      const result = yield* ShellParse.scan(
        "Get-ChildItem; Write-Output 'done'",
        "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
        "C:\\workspace",
      )
      expect(result.commands).toEqual([
        { resource: "Get-ChildItem", save: "Get-ChildItem *" },
        { resource: "Write-Output 'done'", save: "Write-Output *" },
      ])
    }),
  )

  it.effect("does not permission directory changes separately", () =>
    Effect.gen(function* () {
      const result = yield* ShellParse.scan("cd 'src dir' && git status", "/bin/bash", "/workspace")
      expect(result).toEqual({
        commands: [{ resource: "git status", save: "git status *" }],
        directories: ["src dir"],
      })
    }),
  )

  it.effect("extracts PowerShell directory parameters", () =>
    Effect.gen(function* () {
      const result = yield* ShellParse.scan(
        "Set-Location -LiteralPath '..\\outside'; Get-ChildItem",
        "pwsh",
        "C:\\workspace",
      )
      expect(result.directories).toEqual(["..\\outside"])
    }),
  )

  it.effect("expands deterministic directory variables", () =>
    Effect.gen(function* () {
      const bash = yield* ShellParse.scan("cd ~/src", "/bin/bash", "/workspace")
      expect(bash.directories).toEqual([path.join(os.homedir(), "src")])

      const backslash = yield* ShellParse.scan("cd '~\\src'", "/bin/bash", "/workspace")
      expect(backslash.directories).toEqual(
        process.platform === "win32" ? [path.join(os.homedir(), "src")] : ["~\\src"],
      )

      const powershell = yield* ShellParse.scan(
        'Set-Location "$PWD/src"; Set-Location $PSHOME',
        "/usr/local/bin/pwsh",
        "/workspace",
      )
      expect(powershell.directories).toEqual(["/workspace/src", "/usr/local/bin"])
    }),
  )
})
