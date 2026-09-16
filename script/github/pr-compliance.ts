#!/usr/bin/env bun

import { parseArgs } from "util"
import {
  requireToken,
  requireRepo,
  requireEnv,
  githubFetch,
  addLabel,
  removeLabel,
  upsertMarkerComment,
  deleteMarkerComment,
  COMPLIANCE_MARKER,
} from "./lib.ts"

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    help: { type: "boolean", short: "h", default: false },
  },
})

if (values.help) {
  console.log(`
Usage: bun script/github/pr-compliance.ts

Validates PR template sections and manages the needs:compliance label.

Required environment variables:
  GITHUB_TOKEN          GitHub token for API access
  GITHUB_REPOSITORY     owner/repo
  PR_NUMBER             Pull request number
  PR_TITLE              Pull request title
  PR_BODY               Pull request body
  PR_CREATED_AT         Pull request creation timestamp
  PR_LABELS             JSON array of label names on the PR
  DEFAULT_BRANCH        Repository default branch name
  AUTHOR_EXEMPT         "true" to skip all checks
`)
  process.exit(0)
}

if (process.env.AUTHOR_EXEMPT === "true") {
  console.log("Author is exempt; skipping compliance check")
  process.exit(0)
}

const token = await requireToken()
const { owner, repo } = requireRepo()
const prNumber = Number(requireEnv("PR_NUMBER"))
const title = requireEnv("PR_TITLE")
const body = process.env.PR_BODY ?? ""
const createdAt = requireEnv("PR_CREATED_AT")
const defaultBranch = requireEnv("DEFAULT_BRANCH")
const prLabels: string[] = JSON.parse(process.env.PR_LABELS ?? "[]")

// Skip PRs older than Feb 19, 2026 00:00 UTC
const cutoff = new Date("2026-02-19T00:00:00Z")
if (new Date(createdAt) < cutoff) {
  console.log(`Skipping: PR #${prNumber} was created before cutoff (${createdAt})`)
  process.exit(0)
}

const isDocsRefactorOrFeat = /^(docs|refactor|feat)\s*(\([a-zA-Z0-9-]+\))?\s*:/.test(title)
const issues: string[] = []

// Check template sections exist
const hasWhatSection = /### What does this PR do\?/.test(body)
const hasTypeSection = /### Type of change/.test(body)
const hasVerifySection = /### How did you verify your code works\?/.test(body)
const hasChecklistSection = /### Checklist/.test(body)
const hasIssueSection = /### Issue for this PR/.test(body)

if (!hasWhatSection || !hasTypeSection || !hasVerifySection || !hasChecklistSection || !hasIssueSection) {
  issues.push(
    `PR description is missing required template sections. Please use the [PR template](../blob/${defaultBranch}/.github/pull_request_template.md).`,
  )
}

if (hasWhatSection) {
  const whatMatch = body.match(/### What does this PR do\?\s*\n([\s\S]*?)(?=###|$)/)
  const whatContent = whatMatch ? whatMatch[1].trim() : ""
  const placeholder = "Please provide a description of the issue"
  const onlyPlaceholder = whatContent.includes(placeholder) && whatContent.replace(placeholder, "").replace(/[*\s]/g, "").length < 20
  if (!whatContent || onlyPlaceholder) {
    issues.push('"What does this PR do?" section is empty or only contains placeholder text. Please describe the changes.')
  }
}

if (hasTypeSection) {
  const typeMatch = body.match(/### Type of change\s*\n([\s\S]*?)(?=###|$)/)
  const typeContent = typeMatch ? typeMatch[1] : ""
  if (!/- \[x\]/i.test(typeContent)) {
    issues.push('No "Type of change" checkbox is checked. Please select at least one.')
  }
}

if (!isDocsRefactorOrFeat && hasIssueSection) {
  const issueMatch = body.match(/### Issue for this PR\s*\n([\s\S]*?)(?=###|$)/)
  const issueContent = issueMatch ? issueMatch[1].trim() : ""
  if (!/(closes|fixes|resolves)\s+#\d+/i.test(issueContent) && !/#\d+/.test(issueContent)) {
    issues.push("No issue referenced. Please add `Closes #<number>` linking to the relevant issue.")
  }
}

if (hasVerifySection) {
  const verifyMatch = body.match(/### How did you verify your code works\?\s*\n([\s\S]*?)(?=###|$)/)
  const verifyContent = verifyMatch ? verifyMatch[1].trim() : ""
  if (!verifyContent) {
    issues.push('"How did you verify your code works?" section is empty. Please explain how testing was done.')
  }
}

if (hasChecklistSection) {
  const checklistMatch = body.match(/### Checklist\s*\n([\s\S]*?)(?=###|$)/)
  const checklistContent = checklistMatch ? checklistMatch[1] : ""
  const checked = (checklistContent.match(/- \[x\]/gi) || []).length
  if (checked < 2) {
    issues.push("Not all checklist items are checked. Please confirm local testing and that no unrelated changes are included.")
  }
}

const hasComplianceLabel = prLabels.includes("needs:compliance")

if (issues.length > 0) {
  if (!hasComplianceLabel) {
    await addLabel(owner, repo, prNumber, "needs:compliance", token)
  }

  const comment = `${COMPLIANCE_MARKER}
This PR doesn't fully meet the [contributing guidelines](../blob/${defaultBranch}/CONTRIBUTING.md) and [PR template](../blob/${defaultBranch}/.github/pull_request_template.md).

**What needs to be fixed:**
${issues.map((i) => `- ${i}`).join("\n")}

Please edit the PR description to address the above within **2 hours**, or it will be automatically closed.

If this was flagged incorrectly, please let a maintainer know.`

  await upsertMarkerComment(owner, repo, prNumber, COMPLIANCE_MARKER, comment, token)
  console.log(`PR #${prNumber} is non-compliant: ${issues.join(", ")}`)
} else if (hasComplianceLabel) {
  await removeLabel(owner, repo, prNumber, "needs:compliance", token)
  await deleteMarkerComment(owner, repo, prNumber, COMPLIANCE_MARKER, token)

  await githubFetch(`/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
    method: "POST",
    token,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body: "Thanks for updating the PR! It now meets the contributing guidelines. :+1:" }),
  })

  console.log(`PR #${prNumber} is now compliant, label removed`)
} else {
  console.log(`PR #${prNumber} is compliant`)
}
