#!/usr/bin/env bun

import { parseArgs } from "util"
import { requireToken, requireRepo, requireEnv, addLabel } from "./lib.ts"

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    help: { type: "boolean", short: "h", default: false },
  },
})

if (values.help) {
  console.log(`
Usage: bun script/github/add-contributor-label.ts

Adds the "contributor" label to a PR when the author association is CONTRIBUTOR.

Required environment variables:
  GITHUB_TOKEN          GitHub token for API access
  GITHUB_REPOSITORY     owner/repo
  PR_NUMBER             Pull request number
  AUTHOR_ASSOCIATION    Author association (OWNER, MEMBER, CONTRIBUTOR, etc.)
`)
  process.exit(0)
}

const association = requireEnv("AUTHOR_ASSOCIATION")

if (association !== "CONTRIBUTOR") {
  console.log(`Author association is ${association}; no label needed`)
  process.exit(0)
}

const token = await requireToken()
const { owner, repo } = requireRepo()
const prNumber = Number(requireEnv("PR_NUMBER"))

await addLabel(owner, repo, prNumber, "contributor", token)
console.log(`Added contributor label to PR #${prNumber}`)
