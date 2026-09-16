#!/usr/bin/env bun

import { parseArgs } from "util"
import { requireToken, requireRepo, isExempt, githubFetch } from "./lib.ts"

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    days: { type: "string", default: "60" },
    execute: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
})

if (values.help) {
  console.log(`
Usage: bun script/github/close-issues.ts [options]

Closes issues with no activity for a configurable number of days.
Exempt authors (team members, org owners, bots) are skipped.

Dry-run by default in local execution. Automatically executes in CI
when GITHUB_ACTIONS is set.

Options:
  --days <n>     Inactivity threshold in days (default: 60)
  --execute      Comment and close matching issues
  -h, --help     Show this help message
`)
  process.exit(0)
}

const days = Number(values.days)
if (!Number.isInteger(days) || days <= 0) {
  console.error("--days must be a positive integer")
  process.exit(2)
}

const execute = values.execute || process.env.GITHUB_ACTIONS === "true"
const token = await requireToken()
const { owner, repo } = requireRepo()
const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
const msg = `To stay organized issues are automatically closed after ${days} days of no activity. If the issue is still relevant please open a new one.`

type Issue = {
  number: number
  updated_at: string
  author_association: string
  user: { login: string } | null
}

async function closeIssue(num: number) {
  await githubFetch(`/repos/${owner}/${repo}/issues/${num}/comments`, {
    method: "POST",
    token,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body: msg }),
  })

  await githubFetch(`/repos/${owner}/${repo}/issues/${num}`, {
    method: "PATCH",
    token,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state: "closed", state_reason: "not_planned" }),
  })

  console.log(`Closed https://github.com/${owner}/${repo}/issues/${num}`)
}

let page = 1
let closed = 0

while (true) {
  const response = await githubFetch(
    `/repos/${owner}/${repo}/issues?state=open&sort=updated&direction=asc&per_page=100&page=${page}`,
    { token },
  )
  const all: Issue[] = await response.json()
  if (all.length === 0) break
  console.log(`Fetched page ${page} with ${all.length} issues`)

  for (const issue of all) {
    const updated = new Date(issue.updated_at)
    if (updated >= cutoff) {
      console.log(`\nFound fresh issue #${issue.number}, stopping`)
      console.log(`Closed ${closed} issues total`)
      process.exit(0)
    }

    if (await isExempt(issue.user?.login ?? null, issue.author_association)) {
      console.log(`Skipping stale issue #${issue.number}; author ${issue.user?.login ?? "unknown"} is exempt`)
      continue
    }

    if (!execute) {
      console.log(`[dry-run] Would close #${issue.number}`)
      closed++
      continue
    }

    await closeIssue(issue.number)
    closed++
  }

  page++
}

console.log(`Closed ${closed} issues total`)
