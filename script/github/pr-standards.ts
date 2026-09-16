#!/usr/bin/env bun

import { parseArgs } from "util"
import {
  requireToken,
  requireRepo,
  requireEnv,
  graphqlQuery,
  addLabel,
  removeLabel,
  findMarkerComment,
  upsertMarkerComment,
  PR_TITLE_MARKER,
  PR_ISSUE_MARKER,
} from "./lib.ts"

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    help: { type: "boolean", short: "h", default: false },
  },
})

if (values.help) {
  console.log(`
Usage: bun script/github/pr-standards.ts

Validates PR title format and linked issue requirements.
Manages needs:title and needs:issue labels and marker comments.

Required environment variables:
  GITHUB_TOKEN          GitHub token for API access
  GITHUB_REPOSITORY     owner/repo
  PR_NUMBER             Pull request number
  PR_TITLE              Pull request title
  PR_BODY               Pull request body
  PR_CREATED_AT         Pull request creation timestamp
  DEFAULT_BRANCH        Repository default branch name
`)
  process.exit(0)
}

const token = await requireToken()
const { owner, repo } = requireRepo()
const prNumber = Number(requireEnv("PR_NUMBER"))
const title = requireEnv("PR_TITLE")
const body = process.env.PR_BODY ?? ""
const createdAt = requireEnv("PR_CREATED_AT")
const defaultBranch = requireEnv("DEFAULT_BRANCH")

// Skip PRs older than Feb 19, 2026 00:00 UTC
const cutoff = new Date("2026-02-19T00:00:00Z")
if (new Date(createdAt) < cutoff) {
  console.log(`Skipping: PR #${prNumber} was created before cutoff (${createdAt})`)
  process.exit(0)
}

// Step 1: Check title format
const titlePattern = /^(feat|fix|docs|chore|refactor|test)\s*(\([a-zA-Z0-9-]+\))?\s*:/
if (!titlePattern.test(title)) {
  await addLabel(owner, repo, prNumber, "needs:title", token)

  const existing = await findMarkerComment(owner, repo, prNumber, PR_TITLE_MARKER, token)
  if (!existing) {
    const comment = `${PR_TITLE_MARKER}
Hey! The PR title \`${title}\` doesn't follow conventional commit format.

Please update it to start with one of:
- \`feat:\` or \`feat(scope):\` new feature
- \`fix:\` or \`fix(scope):\` bug fix
- \`docs:\` or \`docs(scope):\` documentation changes
- \`chore:\` or \`chore(scope):\` maintenance tasks
- \`refactor:\` or \`refactor(scope):\` code refactoring
- \`test:\` or \`test(scope):\` adding or updating tests

Where \`scope\` is the package name (e.g., \`app\`, \`desktop\`, \`opencode\`).

See [CONTRIBUTING.md](../blob/${defaultBranch}/CONTRIBUTING.md#use-conventional-titles) for details.`

    await upsertMarkerComment(owner, repo, prNumber, PR_TITLE_MARKER, comment, token)
  }
  process.exit(0)
}

await removeLabel(owner, repo, prNumber, "needs:title", token)

// Step 2: Check for linked issue (skip for docs/refactor/feat PRs)
if (/^(docs|refactor|feat)\s*(\([a-zA-Z0-9-]+\))?\s*:/.test(title)) {
  await removeLabel(owner, repo, prNumber, "needs:issue", token)
  console.log("Skipping issue check for docs/refactor/feat PR")
  process.exit(0)
}

type QueryResult = {
  repository: {
    pullRequest: {
      closingIssuesReferences: {
        totalCount: number
      }
    }
  }
}

const result = await graphqlQuery<QueryResult>(
  `query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        closingIssuesReferences(first: 1) {
          totalCount
        }
      }
    }
  }`,
  { owner, repo, number: prNumber },
  token,
)

const linkedIssues = result.repository.pullRequest.closingIssuesReferences.totalCount
const issueMatch = body.match(/### Issue for this PR\s*\n([\s\S]*?)(?=###|$)/)
const issueContent = issueMatch ? issueMatch[1].trim() : body
const hasBodyIssueRef = /(closes|fixes|resolves)\s+#\d+/i.test(issueContent) || /#\d+/.test(issueContent)

if (linkedIssues === 0 && !hasBodyIssueRef) {
  await addLabel(owner, repo, prNumber, "needs:issue", token)

  const existing = await findMarkerComment(owner, repo, prNumber, PR_ISSUE_MARKER, token)
  if (!existing) {
    const comment = `${PR_ISSUE_MARKER}
Thanks for the contribution!

This PR doesn't have a linked issue. All PRs must reference an existing issue.

Please:
1. Open an issue describing the bug/feature (if one doesn't exist)
2. Add \`Fixes #<number>\` or \`Closes #<number>\` to this PR description

See [CONTRIBUTING.md](../blob/${defaultBranch}/CONTRIBUTING.md#link-issues-when-required) for details.`

    await upsertMarkerComment(owner, repo, prNumber, PR_ISSUE_MARKER, comment, token)
  }
  process.exit(0)
}

await removeLabel(owner, repo, prNumber, "needs:issue", token)
console.log("PR meets all standards")
