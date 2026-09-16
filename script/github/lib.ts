#!/usr/bin/env bun

import { fileURLToPath } from "url"
import path from "path"

// ── Comment markers ─────────────────────────────────────────────────
export const COMPLIANCE_MARKER = "<!-- issue-compliance -->"
export const PR_TITLE_MARKER = "<!-- pr-standards:title -->"
export const PR_ISSUE_MARKER = "<!-- pr-standards:issue -->"

// ── Token resolution ────────────────────────────────────────────────
export async function requireToken(): Promise<string> {
  const env = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  if (env) return env

  const proc = Bun.spawn(["gh", "auth", "token"], { stdout: "pipe", stderr: "pipe" })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  if ((await proc.exited) === 0 && stdout.trim()) return stdout.trim()

  console.error(`GitHub authentication required. Set GITHUB_TOKEN or run gh auth login.\n${stderr.trim()}`)
  process.exit(1)
}

// ── Team member exemption ───────────────────────────────────────────
const teamMembersPath = path.resolve(fileURLToPath(import.meta.url), "../../../.github/TEAM_MEMBERS")
const agentLogin = "opencode-agent[bot]"
const orgAssociations = new Set(["OWNER", "MEMBER"])

let teamMembersCache: Set<string> | undefined

async function loadTeamMembers(): Promise<Set<string>> {
  if (teamMembersCache) return teamMembersCache
  try {
    const text = await Bun.file(teamMembersPath).text()
    teamMembersCache = new Set(
      text
        .split("\n")
        .map((line) => line.trim().toLowerCase())
        .filter(Boolean),
    )
  } catch {
    teamMembersCache = new Set()
  }
  return teamMembersCache
}

export async function isExempt(login: string | null | undefined, association: string | null | undefined): Promise<boolean> {
  if (login === agentLogin) return true
  if (association && orgAssociations.has(association)) return true
  if (!login) return false
  const members = await loadTeamMembers()
  return members.has(login.toLowerCase())
}

// ── GitHub API fetch with retry and backoff ──────────────────────────
type FetchInit = RequestInit & { token?: string }

export async function githubFetch(urlPath: string, init: FetchInit = {}, attempt = 0): Promise<Response> {
  const { token, ...fetchInit } = init
  const url = urlPath.startsWith("https://") ? urlPath : `https://api.github.com${urlPath}`
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(fetchInit.headers as Record<string, string> | undefined),
  }
  if (token) headers.Authorization = `Bearer ${token}`

  const response = await fetch(url, { ...fetchInit, headers })
  if (response.ok) return response

  const body = await response.text()
  const retryAfter = response.headers.get("retry-after")
  const reset = response.headers.get("x-ratelimit-reset")
  const retryMs = retryAfter
    ? Number(retryAfter) * 1000
    : response.headers.get("x-ratelimit-remaining") === "0" && reset
      ? Math.max(0, Number(reset) * 1000 - Date.now()) + 1_000
      : body.toLowerCase().includes("secondary rate limit")
        ? 300_000
        : response.status >= 500
          ? Math.min(300_000, 10_000 * 2 ** attempt)
          : 0

  if ((response.status === 403 || response.status === 429 || response.status >= 500) && retryMs > 0 && attempt < 10) {
    console.warn(`GitHub API ${response.status}; retrying in ${Math.ceil(retryMs / 1000)}s (attempt ${attempt + 1})`)
    await Bun.sleep(retryMs)
    return githubFetch(urlPath, init, attempt + 1)
  }

  throw new Error(`GitHub API ${response.status} ${response.statusText}: ${body}`)
}

// ── Pagination ──────────────────────────────────────────────────────
export async function githubPaginate<T>(urlPath: string, token: string, perPage = 100): Promise<T[]> {
  const results: T[] = []
  let page = 1

  while (true) {
    const separator = urlPath.includes("?") ? "&" : "?"
    const response = await githubFetch(`${urlPath}${separator}per_page=${perPage}&page=${page}`, { token })
    const batch: T[] = await response.json()
    if (batch.length === 0) break
    results.push(...batch)
    if (batch.length < perPage) break
    page++
  }

  return results
}

export async function graphqlQuery<T>(query: string, variables: Record<string, unknown>, token: string): Promise<T> {
  const response = await githubFetch("https://api.github.com/graphql", {
    method: "POST",
    token,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  })
  const body: { data?: T; errors?: Array<{ message: string }> } = await response.json()
  if (body.errors?.length) throw new Error(`GraphQL: ${body.errors.map((e) => e.message).join(", ")}`)
  if (!body.data) throw new Error("GraphQL response missing data")
  return body.data
}

// ── Comment marker CRUD ─────────────────────────────────────────────
type Comment = { id: number; body: string }

export async function findMarkerComment(
  owner: string,
  repo: string,
  issueNumber: number,
  marker: string,
  token: string,
): Promise<Comment | undefined> {
  const comments = await githubPaginate<Comment>(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, token)
  return comments.find((c) => c.body.includes(marker))
}

export async function upsertMarkerComment(
  owner: string,
  repo: string,
  issueNumber: number,
  marker: string,
  body: string,
  token: string,
): Promise<void> {
  const existing = await findMarkerComment(owner, repo, issueNumber, marker, token)
  if (existing) {
    await githubFetch(`/repos/${owner}/${repo}/issues/comments/${existing.id}`, {
      method: "PATCH",
      token,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    })
  } else {
    await githubFetch(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
      method: "POST",
      token,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    })
  }
}

export async function deleteMarkerComment(
  owner: string,
  repo: string,
  issueNumber: number,
  marker: string,
  token: string,
): Promise<void> {
  const existing = await findMarkerComment(owner, repo, issueNumber, marker, token)
  if (existing) {
    await githubFetch(`/repos/${owner}/${repo}/issues/comments/${existing.id}`, { method: "DELETE", token })
  }
}

// ── Label helpers ───────────────────────────────────────────────────
export async function addLabel(owner: string, repo: string, issueNumber: number, label: string, token: string): Promise<void> {
  await githubFetch(`/repos/${owner}/${repo}/issues/${issueNumber}/labels`, {
    method: "POST",
    token,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ labels: [label] }),
  })
}

export async function removeLabel(owner: string, repo: string, issueNumber: number, label: string, token: string): Promise<void> {
  try {
    await githubFetch(`/repos/${owner}/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`, {
      method: "DELETE",
      token,
    })
  } catch {
    // Label may not exist; safe to ignore
  }
}

// ── Repository context ──────────────────────────────────────────────
export function requireRepo(): { owner: string; repo: string } {
  const full = process.env.GITHUB_REPOSITORY
  if (!full) {
    console.error("GITHUB_REPOSITORY is required")
    process.exit(1)
  }
  const [owner, repo] = full.split("/")
  if (!owner || !repo) {
    console.error(`Invalid GITHUB_REPOSITORY: ${full}`)
    process.exit(1)
  }
  return { owner, repo }
}

export function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    console.error(`${name} environment variable is required`)
    process.exit(1)
  }
  return value
}
