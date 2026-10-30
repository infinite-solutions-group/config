// Weekly Neon branch sweep. Plain Node ESM, built-in fetch, zero dependencies.
// Pure decision logic is exported; the CLI only runs when executed directly.
import { appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const PROTECTED_BRANCH_NAMES = new Set([
  'main',
  'master',
  'staging',
  'production',
  'prod',
  'develop',
  'dev',
  'test-base',
  'preview/develop',
  'preview/main',
])
export const CI_PREFIXES = ['ci/', 'ci-pr-', 'ci-pt-']
export const PREVIEW_PREFIX = 'preview/'

export function isSweepablePrefix(name) {
  return CI_PREFIXES.some((p) => name.startsWith(p)) || name.startsWith(PREVIEW_PREFIX)
}

export function parseExtraProtected(str) {
  return new Set(
    String(str ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  )
}

export function decodeDependabotName(name) {
  // Decode only %2F; any other percent sequence is left untouched.
  return name.replace(/%2f/gi, '/')
}

const DEFAULT_MAX_DELETES = 25

const skip = (reason) => ({ action: 'skip', reason })

export async function decide(branch, ctx) {
  const name = branch.name
  if (branch.primary) return skip('primary branch')
  if (branch.default) return skip('default branch')
  if (branch.protected) return skip('Neon-protected branch')
  if (PROTECTED_BRANCH_NAMES.has(name)) return skip('in hard denylist')
  if (ctx.extraProtected.has(name)) return skip('in EXTRA_PROTECTED')

  const created = Date.parse(branch.created_at)
  if (!branch.created_at || Number.isNaN(created)) return skip('unparseable created_at')
  const age = ctx.now - created
  if (!(age > ctx.maxAgeHours * 3600 * 1000)) return skip('younger than MAX_AGE_HOURS')

  if (CI_PREFIXES.some((p) => name.startsWith(p))) {
    return { action: 'delete', rule: 'ci-orphan', reason: 'CI branch older than MAX_AGE_HOURS' }
  }

  if (name.startsWith(PREVIEW_PREFIX)) {
    const gitName = name.slice(PREVIEW_PREFIX.length)
    const results = [await ctx.gitBranchExists(gitName)]
    if (results[0] === false && /%2f/i.test(gitName)) {
      results.push(await ctx.gitBranchExists(decodeDependabotName(gitName)))
    }
    if (results.includes(true)) return skip('git branch still exists')
    if (results.includes('unknown')) {
      const note = ctx.lookupNote ? ` (${ctx.lookupNote})` : ''
      return skip(`GitHub lookup failed (non-404), refusing to delete${note}`)
    }
    return {
      action: 'delete',
      rule: 'preview-orphan',
      reason: 'preview branch older than MAX_AGE_HOURS and git branch no longer exists',
    }
  }

  return skip('name does not match a sweepable prefix')
}

export function assertSweepable(candidates) {
  const bad = candidates.filter((c) => !isSweepablePrefix(c.name))
  if (bad.length > 0) {
    throw new Error(
      `Refusing to sweep: candidate(s) lack a sweepable prefix: ${bad.map((b) => b.name).join(', ')}`
    )
  }
}

export async function sweep({ branches, ctx, dryRun, deleteBranch, decideFn = decide }) {
  const result = { deleted: [], skipped: [], failed: [] }
  const candidates = []
  for (const branch of branches) {
    const d = await decideFn(branch, ctx)
    const entry = { name: branch.name, id: branch.id, rule: d.rule, reason: d.reason }
    if (d.action === 'delete') candidates.push({ branch, entry })
    else result.skipped.push(entry)
  }

  // Fail-closed ceiling: a wrong repo/token or a bad rule can turn everything into a
  // candidate, so refuse a large sweep outright (dry runs included, to surface it).
  const maxDeletes = ctx.maxDeletes ?? DEFAULT_MAX_DELETES
  if (candidates.length > maxDeletes) {
    throw new Error(
      `Refusing to sweep: ${candidates.length} delete candidate(s) exceed max_deletes=${maxDeletes}; review the list and re-run once with a larger max_deletes`
    )
  }

  // Final guard: nothing is deleted if any candidate is outside the sweepable prefixes.
  assertSweepable(candidates.map((c) => c.branch))

  for (const { branch, entry } of candidates) {
    if (dryRun) {
      result.deleted.push({ ...entry, reason: `DRY RUN: ${entry.reason}` })
      continue
    }
    try {
      await deleteBranch(branch)
      result.deleted.push(entry)
    } catch (err) {
      result.failed.push({ ...entry, reason: err instanceof Error ? err.message : String(err) })
    }
  }
  return result
}

// ---------------------------------------------------------------- CLI

const NEON_API = 'https://console.neon.tech/api/v2'
const TIMEOUT_MS = 30_000
const MAX_ATTEMPTS = 5
const MAX_DELAY_MS = 30_000
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const retriable = (status) => status === 423 || status === 429 || status >= 500

function backoffMs(attempt, res) {
  const ra = Number(res?.headers?.get('retry-after'))
  const ms = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * 2 ** attempt
  return Math.min(ms, MAX_DELAY_MS)
}

// Neon request with timeout and retry on 423 / 429 / 5xx / network errors.
// Returns the final Response (possibly non-ok); throws only on a final network error.
export async function neonRequest(url, init = {}, { sleepImpl = defaultSleep } = {}) {
  for (let attempt = 0; ; attempt++) {
    const last = attempt === MAX_ATTEMPTS - 1
    let res
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch (err) {
      if (last) throw err
      await sleepImpl(backoffMs(attempt))
      continue
    }
    if (!retriable(res.status) || last) return res
    await sleepImpl(backoffMs(attempt, res))
  }
}

export async function listNeonBranches(projectId, apiKey, opts = {}) {
  const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }
  const all = []
  let cursor
  for (let page = 0; page < 100; page++) {
    const qs = new URLSearchParams({ limit: '1000' })
    if (cursor) qs.set('cursor', cursor)
    const res = await neonRequest(
      `${NEON_API}/projects/${encodeURIComponent(projectId)}/branches?${qs}`,
      { headers },
      opts
    )
    if (!res.ok) throw new Error(`Neon list branches failed: HTTP ${res.status}`)
    const body = await res.json()
    all.push(...(body.branches ?? []))
    const next = body.pagination?.next
    if (!next || next === cursor) return all
    cursor = next
  }
  throw new Error('Neon list branches failed: too many pages')
}

export async function deleteNeonBranch(projectId, apiKey, branch, opts = {}) {
  const res = await neonRequest(
    `${NEON_API}/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branch.id)}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    },
    opts
  )
  if (!res.ok) {
    let detail = ''
    try {
      detail = (await res.json()).message ?? ''
    } catch {
      // body not JSON; the status code is enough
    }
    throw new Error(`Neon delete failed: HTTP ${res.status}${detail ? ` ${sanitize(detail)}` : ''}`)
  }
}

const ghHeaders = (token) => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'neon-sweep',
})
const encodePath = (name) => name.split('/').map(encodeURIComponent).join('/')

// Positive control: the token must be able to read the repo and its default branch,
// otherwise a 404 on a preview branch proves nothing.
async function canaryStatus(repo, token, fetchImpl = fetch) {
  const get = (url) =>
    fetchImpl(url, { headers: ghHeaders(token), signal: AbortSignal.timeout(TIMEOUT_MS) })
  try {
    const repoRes = await get(`https://api.github.com/repos/${repo}`)
    if (repoRes.status !== 200) return { ok: false, status: repoRes.status }
    const defaultBranch = (await repoRes.json()).default_branch
    if (!defaultBranch) return { ok: false, status: 'no default_branch' }
    const brRes = await get(
      `https://api.github.com/repos/${repo}/branches/${encodePath(defaultBranch)}`
    )
    return { ok: brRes.status === 200, status: brRes.status }
  } catch (err) {
    return { ok: false, status: err instanceof Error ? err.name : 'error' }
  }
}

export async function githubCanary(repo, token, fetchImpl = fetch) {
  return (await canaryStatus(repo, token, fetchImpl)).ok
}

function makeGitBranchExists(repo, token) {
  return async (gitName) => {
    try {
      const res = await fetch(
        `https://api.github.com/repos/${repo}/branches/${encodePath(gitName)}`,
        {
          headers: ghHeaders(token),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        }
      )
      if (res.status === 200) return true
      if (res.status === 404) return false
      return 'unknown'
    } catch {
      return 'unknown'
    }
  }
}

// Strip control characters (log-injection / workflow-command safety).
export function sanitize(s) {
  return String(s ?? '').replace(/[\x00-\x1f\x7f]/g, '')
}

// Sanitize, then HTML-entity encode so branch names and API messages cannot inject
// markup, links, or table breaks into the step summary.
const ENTITIES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
  '|': '&#124;',
  '[': '&#91;',
  ']': '&#93;',
}
export function esc(s) {
  return sanitize(s).replace(/[&<>"'`|[\]]/g, (c) => ENTITIES[c])
}

const maskId = (id) => `…${String(id).slice(-4)}`

export function formatSummary({ projectId, dryRun, maxAgeHours, result }) {
  const table = (title, rows) => {
    const lines = [`### ${title} (${rows.length})`, '']
    if (rows.length === 0) return [...lines, '_none_', ''].join('\n')
    lines.push('| Branch | Rule | Reason |', '| --- | --- | --- |')
    for (const r of rows)
      lines.push(`| <code>${esc(r.name)}</code> | ${esc(r.rule ?? '')} | ${esc(r.reason)} |`)
    return [...lines, ''].join('\n')
  }
  return [
    '## Neon branch sweep',
    '',
    `- Dry run: **${dryRun}**`,
    `- Project: <code>${esc(maskId(projectId))}</code>`,
    `- Max age: ${maxAgeHours}h`,
    `- Deleted: ${result.deleted.length} | Skipped: ${result.skipped.length} | Failed: ${result.failed.length}`,
    '',
    table(dryRun ? 'Would delete' : 'Deleted', result.deleted),
    table('Failed', result.failed),
    table('Skipped', result.skipped),
  ].join('\n')
}

export async function main(env = process.env, { sleepImpl = defaultSleep } = {}) {
  const apiKey = env.NEON_API_KEY
  const projectId = env.NEON_PROJECT_ID
  const repo = env.GITHUB_REPOSITORY
  const missing = ['NEON_API_KEY', 'NEON_PROJECT_ID', 'GITHUB_REPOSITORY'].filter((k) => !env[k])
  if (missing.length > 0) {
    console.error(`Error: missing required env var(s): ${missing.join(', ')}`)
    return 1
  }
  const maxAgeHours = Number(env.MAX_AGE_HOURS ?? '24')
  if (!Number.isFinite(maxAgeHours) || maxAgeHours < 1) {
    console.error('Error: MAX_AGE_HOURS must be a finite number >= 1')
    return 1
  }
  const rawMaxDeletes = env.MAX_DELETES ?? '25'
  const maxDeletes = Number(rawMaxDeletes)
  if (String(rawMaxDeletes).trim() === '' || !Number.isInteger(maxDeletes) || maxDeletes < 1) {
    console.error('Error: MAX_DELETES must be an integer >= 1')
    return 1
  }
  const dryRun = ['true', '1'].includes(String(env.DRY_RUN ?? '').toLowerCase())
  const token = env.GITHUB_TOKEN

  let gitBranchExists = async () => 'unknown'
  let lookupNote
  if (!token) {
    console.warn('Warning: GITHUB_TOKEN not set; preview/* branches will never be deleted.')
    lookupNote = 'no GITHUB_TOKEN'
  } else {
    const canary = await canaryStatus(repo, token)
    if (canary.ok) {
      gitBranchExists = makeGitBranchExists(repo, token)
    } else {
      console.warn(
        `Warning: GitHub canary failed (HTTP ${sanitize(canary.status)}); preview/* branches will not be deleted this run`
      )
      lookupNote = 'GitHub canary failed'
    }
  }

  const ctx = {
    now: Date.now(),
    maxAgeHours,
    extraProtected: parseExtraProtected(env.EXTRA_PROTECTED ?? ''),
    gitBranchExists,
    lookupNote,
    maxDeletes,
  }

  const opts = { sleepImpl }
  const branches = await listNeonBranches(projectId, apiKey, opts)
  console.log(
    `Neon project ${maskId(projectId)}: ${branches.length} branch(es); dry run: ${dryRun}; max age: ${maxAgeHours}h`
  )
  const result = await sweep({
    branches,
    ctx,
    dryRun,
    deleteBranch: (b) => deleteNeonBranch(projectId, apiKey, b, opts),
  })

  for (const [label, rows] of [
    [dryRun ? 'WOULD DELETE' : 'DELETED', result.deleted],
    ['FAILED', result.failed],
    ['SKIPPED', result.skipped],
  ]) {
    for (const r of rows)
      console.log(`${label} ${sanitize(r.name)} [${r.rule ?? '-'}] ${sanitize(r.reason)}`)
  }
  console.log(
    `Done: ${result.deleted.length} ${dryRun ? 'would be deleted' : 'deleted'}, ${result.skipped.length} skipped, ${result.failed.length} failed`
  )

  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      `${formatSummary({ projectId, dryRun, maxAgeHours, result })}\n`
    )
  }
  return !dryRun && result.failed.length > 0 ? 1 : 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`Error: ${sanitize(err instanceof Error ? err.message : err)}`)
      process.exit(1)
    }
  )
}
