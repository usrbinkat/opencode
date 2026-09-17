export * as ShellParse from "./parse.js"

import { Context, Effect, Layer, Schema } from "effect"
import { fileURLToPath } from "url"
import os from "os"
import path from "path"
import type { Parser, Language, Node } from "web-tree-sitter"
import { shellParserWasm } from "#shell-parser-wasm"
import { ShellSelect } from "./select.js"
import { Wildcard } from "../util/wildcard.js"
import { makeGlobalNode } from "@opencode/util/effect/app-node"

type Part = { type: string; text: string }
const CWD = new Set(["cd", "chdir", "popd", "pushd", "push-location", "set-location"])
const POWERSHELL_PATH_FLAGS = new Set(["-literalpath", "-path"])

export type Result = {
  commands: Array<{ resource: string; save: string }>
  directories: string[]
}

const ARITY: Record<string, number> = {
  cat: 1,
  cd: 1,
  chmod: 1,
  chown: 1,
  cp: 1,
  echo: 1,
  env: 1,
  export: 1,
  grep: 1,
  kill: 1,
  killall: 1,
  ln: 1,
  ls: 1,
  mkdir: 1,
  mv: 1,
  ps: 1,
  pwd: 1,
  rm: 1,
  rmdir: 1,
  sleep: 1,
  source: 1,
  tail: 1,
  touch: 1,
  unset: 1,
  which: 1,
  aws: 3,
  az: 3,
  bazel: 2,
  brew: 2,
  bun: 2,
  "bun run": 3,
  "bun x": 3,
  cargo: 2,
  "cargo add": 3,
  "cargo run": 3,
  cdk: 2,
  cf: 2,
  cmake: 2,
  composer: 2,
  consul: 2,
  "consul kv": 3,
  crictl: 2,
  deno: 2,
  "deno task": 3,
  doctl: 3,
  docker: 2,
  "docker builder": 3,
  "docker compose": 3,
  "docker container": 3,
  "docker image": 3,
  "docker network": 3,
  "docker volume": 3,
  eksctl: 2,
  "eksctl create": 3,
  firebase: 2,
  flyctl: 2,
  gcloud: 3,
  gh: 3,
  git: 2,
  "git config": 3,
  "git remote": 3,
  "git stash": 3,
  go: 2,
  gradle: 2,
  helm: 2,
  heroku: 2,
  hugo: 2,
  ip: 2,
  "ip addr": 3,
  "ip link": 3,
  "ip netns": 3,
  "ip route": 3,
  kind: 2,
  "kind create": 3,
  kubectl: 2,
  "kubectl kustomize": 3,
  "kubectl rollout": 3,
  kustomize: 2,
  make: 2,
  mc: 2,
  "mc admin": 3,
  minikube: 2,
  mongosh: 2,
  mysql: 2,
  mvn: 2,
  ng: 2,
  npm: 2,
  "npm exec": 3,
  "npm init": 3,
  "npm run": 3,
  "npm view": 3,
  npx: 2,
  nvm: 2,
  nx: 2,
  openssl: 2,
  "openssl req": 3,
  "openssl x509": 3,
  pip: 2,
  pipenv: 2,
  pnpm: 2,
  "pnpm dlx": 3,
  "pnpm exec": 3,
  "pnpm run": 3,
  poetry: 2,
  podman: 2,
  "podman container": 3,
  "podman image": 3,
  psql: 2,
  pulumi: 2,
  "pulumi stack": 3,
  python: 2,
  pyenv: 2,
  rake: 2,
  rbenv: 2,
  "redis-cli": 2,
  rustup: 2,
  serverless: 2,
  sfdx: 3,
  skaffold: 2,
  sls: 2,
  sst: 2,
  swift: 2,
  systemctl: 2,
  terraform: 2,
  "terraform workspace": 3,
  tmux: 2,
  turbo: 2,
  ufw: 2,
  vault: 2,
  "vault auth": 3,
  "vault kv": 3,
  vercel: 2,
  volta: 2,
  wp: 2,
  yarn: 2,
  "yarn dlx": 3,
  "yarn run": 3,
}
const PREFIX_LENGTH = Math.max(...Object.values(ARITY))

export class InitializationError extends Schema.TaggedError<InitializationError>()(
  "ShellParse.InitializationError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

type Parsers = { bash: Parser; ps: Parser }

export interface Interface {
  readonly scan: (
    command: string,
    shell: string,
    cwd: string,
    options?: { portable?: boolean },
  ) => Effect.Effect<Result, Error | InitializationError>
  readonly scanPortable: (
    command: string,
    shell: string,
    cwd: string,
  ) => Effect.Effect<Result, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ShellParse") {}

// Process-scoped parser initialization. Tree-sitter WASM allocates Language
// grammars into a shared linear memory that grows monotonically — Language.load
// is cumulative and irrecoverable. Parser.init is idempotent (same Module3
// singleton). These resources must live for the process lifetime; scoping them
// to an Effect layer with a finalizer causes OOM when the layer rebuilds across
// test files because each rebuild calls Language.load into the same exhaustible
// WASM heap. A module-level promise (matching the upstream lazy(initialize)
// pattern) ensures exactly one initialization per process.
let processParserPromise: Promise<Parsers> | undefined
const loadParsersOnce = Effect.gen(function* () {
  if (!processParserPromise) {
    const started = Date.now()
    yield* Effect.logInfo("shell parser initialization started")
    processParserPromise = (async () => {
      const { Parser: ParserCtor, Language: LanguageCtor } = await import("web-tree-sitter")
      await ParserCtor.init({ locateFile: () => resolve(shellParserWasm.runtime) })
      const [bashLanguage, psLanguage] = await Promise.all([
        LanguageCtor.load(resolve(shellParserWasm.bash)),
        LanguageCtor.load(resolve(shellParserWasm.powershell)),
      ]) as [Language, Language]
      const bash = new ParserCtor()
      bash.setLanguage(bashLanguage)
      const ps = new ParserCtor()
      ps.setLanguage(psLanguage)
      return { bash, ps } as Parsers
    })()
    try {
      const parsers = yield* Effect.tryPromise({
        try: () => processParserPromise!,
        catch: (cause) =>
          new InitializationError({ message: "Failed to initialize shell parser", cause: cause as Error }),
      })
      yield* Effect.logInfo("shell parser initialization completed", { durationMs: Date.now() - started })
      return parsers
    } catch (error) {
      processParserPromise = undefined
      throw error
    }
  }
  return yield* Effect.tryPromise({
    try: () => processParserPromise!,
    catch: (cause) =>
      new InitializationError({ message: "Failed to initialize shell parser", cause: cause as Error }),
  })
}).pipe(Effect.withSpan("ShellParse.initialize"))

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // Pre-warm: trigger initialization at layer build so the first scan call
    // does not pay the WASM cold-start cost. Errors are surfaced on scan,
    // matching the photon.ts pattern for unavailable runtimes.
    yield* loadParsersOnce.pipe(Effect.ignore)

    const scanMethod = Effect.fnUntraced(function* (
      command: string,
      shell: string,
      cwd: string,
      options?: { portable?: boolean },
    ) {
      if (options?.portable) return yield* scanPortableImpl(command, shell, cwd)
      const parsers = yield* loadParsersOnce
      return yield* scanLegacyWith(parsers, command, shell, cwd)
    })

    const scanPortableMethod = Effect.fnUntraced(function* (
      command: string,
      shell: string,
      cwd: string,
    ) {
      return yield* scanPortableImpl(command, shell, cwd)
    })

    return Service.of({ scan: scanMethod, scanPortable: scanPortableMethod })
  }),
)

export { layer }
export const node = makeGlobalNode({ service: Service, layer, deps: [] })

/**
 * Scan a shell command for permission-relevant resources and directory changes.
 * Requires ShellParse.Service in the Effect context — provide it via the node
 * graph (production) or via Effect.provide(ShellParse.layer) (tests/scripts).
 */
export const scan = Effect.fnUntraced(function* (
  command: string,
  shell: string,
  cwd: string,
  options?: { portable?: boolean },
) {
  const service = yield* Service
  return yield* service.scan(command, shell, cwd, options)
})

const scanLegacyWith = Effect.fnUntraced(function* (
  parsers: Parsers,
  command: string,
  shell: string,
  cwd: string,
) {
  const powershell = ShellSelect.ps(shell)
  const tree = (powershell ? parsers.ps : parsers.bash).parse(command)
  if (!tree) return yield* Effect.fail(new Error("Failed to parse shell command"))

  return yield* Effect.acquireUseRelease(
    Effect.succeed(tree),
    (tree) =>
      Effect.sync(() =>
        tree.rootNode.descendantsOfType("command").reduce(
          (result, node) => {
            if (!node) return result
            const command = parts(node)
            const tokens = command.map((part) => part.text)
            if (tokens.length === 0) return result
            const name = powershell ? tokens[0].toLowerCase() : tokens[0]
            if (CWD.has(name)) {
              result.directories.push(...directoryArgs(command, powershell, cwd, shell))
              return result
            }
            result.commands.push({
              resource: (node.parent?.type === "redirected_statement" ? node.parent.text : node.text).trim(),
              save: `${prefix(tokens).join(" ")} *`,
            })
            return result
          },
          { commands: [] as Array<{ resource: string; save: string }>, directories: [] as string[] },
        ),
      ),
    (tree) => Effect.sync(() => tree.delete()),
  )
})

/**
 * Scan a shell command using the portable (JS-only) scanner. Requires
 * ShellParse.Service in the Effect context.
 */
export const scanPortable = Effect.fnUntraced(function* (
  command: string,
  shell: string,
  cwd: string,
) {
  const service = yield* Service
  return yield* service.scanPortable(command, shell, cwd)
})

const scanPortableImpl = Effect.fnUntraced(function* (command: string, shell: string, cwd: string) {
  const { ShellScan } = yield* Effect.tryPromise({
    try: () => import("./scan.js"),
    catch: (cause) => new Error(`Portable shell scanner failed to load: ${cause}`, { cause }),
  })
  const powershell = ShellSelect.ps(shell)
  const result = powershell ? ShellScan.scanPowerShell(command) : ShellScan.scan(command)
  if (result.kind === "opaque")
    return yield* Effect.fail(new Error(`Portable shell scanner cannot analyze command: ${result.reason}`))

  const output: Result = { commands: [], directories: [] }
  for (const item of result.commands) {
    // The legacy command walk skips declarations, not the substitutions within them.
    if (item.declaration) continue
    const words = item.redirectWordCount === undefined ? item.rawWords : item.rawWords.slice(0, item.redirectWordCount)
    // The shipped PowerShell grammar treats bare statement-head foreach prefixes as control flow.
    if (powershell && item.statementHead && /^foreach(?:-|$)/i.test(words[0] ?? "")) continue
    const name = powershell ? words[0]?.toLowerCase() : words[0]
    if (CWD.has(name)) {
      output.directories.push(
        ...directoryArgs(
          words.flatMap((text): Part[] => {
            const parameter = powershell ? /^(-(?:literalpath|path)):(.*)$/i.exec(text) : undefined
            if (parameter)
              return [
                { type: "command_parameter", text: parameter[1] },
                { type: "word", text: parameter[2] },
              ]
            return [{ type: powershell && text.startsWith("-") ? "command_parameter" : "word", text }]
          }),
          powershell,
          cwd,
          shell,
        ),
      )
      continue
    }
    const selected = prefix(words.slice(0, PREFIX_LENGTH))
    const conventional = `${selected.join(" ")} *`
    const end = item.wordEnds?.[selected.length - 1]
    // Keep existing grants stable unless normalized spacing loses the original source boundary.
    const save =
      !powershell || end === undefined || Wildcard.match(item.resource, conventional)
        ? conventional
        : (() => {
            const boundary =
              item.wordEnds?.find(
                (value) => value >= end && (value >= item.resource.length || /\s/.test(item.resource[value])),
              ) ?? end
            const separator = /^\s+(?:`(?:\r\n|\r|\n)\s*)?/.exec(item.resource.slice(boundary))?.[0]
            return `${item.resource.slice(0, boundary)}${separator ?? " "}*`
          })()
    output.commands.push({
      resource: item.resource,
      save,
    })
  }
  return output
})

function parts(node: Node) {
  return Array.from({ length: node.childCount }).flatMap((_, index): Part[] => {
    const child = node.child(index)
    if (!child) return []
    if (child.type === "command_elements")
      return Array.from({ length: child.childCount }).flatMap((_, itemIndex): Part[] => {
        const item = child.child(itemIndex)
        if (!item || item.type === "command_argument_sep" || item.type === "redirection") return []
        return [{ type: item.type, text: item.text }]
      })
    if (!["command_name", "command_name_expr", "word", "string", "raw_string", "concatenation"].includes(child.type))
      return []
    return [{ type: child.type, text: child.text }]
  })
}

function directoryArgs(command: Part[], powershell: boolean, cwd: string, shell: string) {
  if (!powershell)
    return command
      .slice(1)
      .filter((part) => !part.text.startsWith("-"))
      .map((part) => directoryArgument(part.text, powershell, cwd, shell))
      .filter((part) => part !== undefined)

  const directories: string[] = []
  let path = false
  for (const part of command.slice(1)) {
    if (path) {
      const value = directoryArgument(part.text, powershell, cwd, shell)
      if (value) directories.push(value)
      path = false
      continue
    }
    if (part.type === "command_parameter") {
      path = POWERSHELL_PATH_FLAGS.has(part.text.toLowerCase())
      continue
    }
    const value = directoryArgument(part.text, powershell, cwd, shell)
    if (value) directories.push(value)
  }
  return directories
}

function directoryArgument(value: string, powershell: boolean, cwd: string, shell: string) {
  const quote = value[0]
  const text = (quote === '"' || quote === "'") && value.at(-1) === quote ? value.slice(1, -1) : value
  if (!powershell) return expandKnownDirectory(text)

  // PowerShell exposes environment variables through $env:NAME and provides these
  // automatic directory variables. Expand only values we can determine without executing code.
  return expandKnownDirectory(
    text
      .replace(/\$\{env:([^}]+)\}/gi, (_, key: string) => environment(key) ?? "")
      .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, key: string) => environment(key) ?? "")
      .replace(/\$(HOME|PWD|PSHOME)(?=$|[\\/])/gi, (_, key: string) => {
        if (key.toUpperCase() === "HOME") return os.homedir()
        if (key.toUpperCase() === "PWD") return cwd
        return path.dirname(shell)
      }),
  )
}

function expandKnownDirectory(value: string) {
  // Unknown shell expressions cannot be resolved safely during permission analysis.
  if (value.includes("$") || value.includes("`") || value.startsWith("(")) return
  if (value === "~") return os.homedir()
  if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) {
    return path.join(os.homedir(), value.slice(2))
  }
  return value
}

function environment(key: string) {
  if (process.platform !== "win32") return process.env[key]
  const name = Object.keys(process.env).find((item) => item.toLowerCase() === key.toLowerCase())
  return name ? process.env[name] : undefined
}

function prefix(tokens: string[]) {
  for (let length = tokens.length; length > 0; length--) {
    const arity = ARITY[tokens.slice(0, length).join(" ")]
    if (arity !== undefined) return tokens.slice(0, arity)
  }
  return tokens.slice(0, 1)
}

function resolve(asset: string) {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (path.isAbsolute(asset)) return asset
  return fileURLToPath(new URL(asset, import.meta.url))
}

