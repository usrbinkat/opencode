#!/usr/bin/env bun

import { parseArgs } from "util"
import {
  requireToken,
  requireRepo,
  isExempt,
  githubFetch,
  githubPaginate,
  findMarkerComment,
  removeLabel,
  COMPLIANCE_MARKER,
} from "./lib.ts"

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    execute: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
})

if (values.help) {
  console.log(`
Usage: bun script/github/compliance-close.ts [--execute]

Finds open issues and PRs labeled needs:compliance where the compliance
comment is older than 2 hours, then closes them with an explanation.

Dry-run by default. Pass --execute to comment and close.

Required environment variables:
  GITHUB_TOKEN          GitHub token for API access
  GITHUB_REPOSITORY     owner/repo
  DEFAULT_BRANCH        Repository default branch name
`)
  process.exit(0)
}

const execute = values.execute || process.env.GITHUB_ACTIONS === "true"
const token = await requireToken()
const { owner, repo } = requireRepo()
const defaultBranch = process.env.DEFAULT_BRANCH ?? "v2"

type Issue = {
  number: number
  pull_request?: unknown
  user: { login: string } | null
  author_association: string
}

type Comment = { id: number; body: string; created_at: string }

const items = await githubPaginate<Issue>(
  `/repos/${owner}/${repo}/issues?labels=needs:compliance&state=open`,
  token,
)

if (items.length === 0) {
  console.log("No open issues/PRs with needs:compliance label")
  process.exit(0)
}

const now = Date.now()
const twoHours = 2 * 60 * 60 * 1000

for (const item of items) {
  const isPR = !!item.pull_request
  const kind = isPR ? "PR" : "issue"
  const login = item.user?.login ?? null

  if (await isExempt(login, item.author_association)) {
    console.log(`Skipping ${kind} #${item.number}; author ${login ?? "unknown"} is exempt`)
    await removeLabel(owner, repo, item.number, "needs:compliance", token)
    continue
  }

  const complianceComment = await findMarkerComment(owner, repo, item.number, COMPLIANCE_MARKER, token)
  if (!complianceComment) continue

  // findMarkerComment returns {id, body} — fetch created_at separately
  const comments = await githubPaginate<Comment>(`/repos/${owner}/${repo}/issues/${item.number}/comments`, token)
  const fullComment = comments.find((c) => c.body.includes(COMPLIANCE_MARKER))
  if (!fullComment) continue

  const commentAge = now - new Date(fullComment.created_at).getTime()
  if (commentAge < twoHours) {
    console.log(`${kind} #${item.number} still within 2-hour window (${Math.round(commentAge / 60000)}m elapsed)`)
    continue
  }

  if (!execute) {
    console.log(`[dry-run] Would close ${kind} #${item.number}`)
    continue
  }

  const closeMessage = isPR
    ? `This pull request has been automatically closed because it was not updated to meet the [contributing guidelines](../blob/${defaultBranch}/CONTRIBUTING.md) within the 2-hour window.\n\nFeel free to open a new pull request that follows the guidelines.`
    : `This issue has been automatically closed because it was not updated to meet the [contributing guidelines](../blob/${defaultBranch}/CONTRIBUTING.md) within the 2-hour window.\n\nFeel free to open a new issue that follows the issue templates.`

  await githubFetch(`/repos/${owner}/${repo}/issues/${item.number}/comments`, {
    method: "POST",
    token,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body: closeMessage }),
  })

  await removeLabel(owner, repo, item.number, "needs:compliance", token)

  if (isPR) {
    await githubFetch(`/repos/${owner}/${repo}/pulls/${item.number}`, {
      method: "PATCH",
      token,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: "closed" }),
    })
  } else {
    await githubFetch(`/repos/${owner}/${repo}/issues/${item.number}`, {
      method: "PATCH",
      token,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: "closed", state_reason: "not_planned" }),
    })
  }

  console.log(`Closed non-compliant ${kind} #${item.number} after 2-hour window`)
}
