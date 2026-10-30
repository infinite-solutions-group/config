# @infinite-solutions-group/config

Shared **ESLint**, **Prettier**, and **TSConfig** for Infinite Solutions
projects, plus a **reusable CI workflow** and a **reusable Neon branch sweep**.
One source of truth — bump the version to pull improvements into every project.

**Public but write-locked:** anyone can read; only org members can push, only via
PR (org Baseline ruleset: signed commits, PR required, no force-push/delete).
Version tags are protected (immutable). **Zero runtime dependencies** and **no
install/lifecycle scripts** — minimal supply-chain surface — and this repo
dogfoods the `shai-hulud-detect` scan on every PR.

## Consume (pin to a tag or commit SHA)

`package.json`:

```jsonc
{
  "devDependencies": {
    "@infinite-solutions-group/config": "github:infinite-solutions-group/config#v1.0.0"
    // for maximum tamper-resistance, pin the full commit SHA instead of the tag
  }
}
```

Peer deps (install in your project): `eslint typescript typescript-eslint
@eslint/js eslint-plugin-react eslint-plugin-react-hooks eslint-plugin-jsx-a11y
globals prettier`.

**ESLint** — `eslint.config.mjs`:

```js
import base from '@infinite-solutions-group/config/eslint'
export default base
// or: export default [...base, { rules: { /* project overrides */ } }]
```

**Prettier** — `.prettierrc`:

```json
"@infinite-solutions-group/config/prettier"
```

**TSConfig** — `tsconfig.json`:

```json
{ "extends": "@infinite-solutions-group/config/tsconfig.base.json" }
```

**CI** — `.github/workflows/ci.yml`:

```yaml
jobs:
  ci:
    uses: infinite-solutions-group/config/.github/workflows/ci.reusable.yml@v1.0.0
```

## Neon branch sweep (reusable workflow)

`neon-sweep.reusable.yml` deletes stale Neon branches in the caller's Neon
project. Plain Node 24, no dependencies (`scripts/neon-sweep.mjs`).

**Deletes** (only if older than `max_age_hours`, default 24, minimum 1):

- CI orphans: `ci/*`, `ci-pr-*`, `ci-pt-*`
- Preview orphans: `preview/<git-branch>` where `<git-branch>` no longer exists
  in the calling repo (Dependabot `%2F`-encoded names are also checked decoded)

**Never touches:**

- primary, default, or Neon-protected branches
- the hard denylist: `main`, `master`, `staging`, `production`, `prod`,
  `develop`, `dev`, `test-base`, `preview/develop`, `preview/main`
- anything in `extra_protected` (comma-separated names)
- anything younger than `max_age_hours`, or with an unparseable `created_at`
- a `preview/*` branch whose GitHub lookup fails for any reason other than a 404
  (or when no token is available)
- a branch that has children: Neon's error is logged under Failed and the sweep
  continues

A final guard aborts the whole run if any delete candidate lacks a sweepable
prefix. Every run writes a Markdown step summary (Deleted / Failed / Skipped,
with rule and reason for each, so the skipped list is the audit trail). The job
exits non-zero if any delete failed (never for a dry run).

Caller workflow, pinned by commit SHA:

```yaml
name: neon-sweep
on:
  schedule:
    - cron: "23 6 * * 1"   # Mondays 06:23 UTC
  workflow_dispatch:
    inputs:
      dry_run: { type: boolean, default: true }
jobs:
  sweep:
    uses: infinite-solutions-group/config/.github/workflows/neon-sweep.reusable.yml@<MERGED_SHA>
    with:
      dry_run: ${{ github.event_name == 'workflow_dispatch' && inputs.dry_run || false }}
      # max_deletes: 50   # one-off, for a large backlog
    secrets:
      NEON_API_KEY: ${{ secrets.NEON_API_KEY }}
      NEON_PROJECT_ID: ${{ secrets.NEON_PROJECT_ID }}
    permissions: { contents: read }
```

**Caller requirements:** the Neon project must map 1:1 to the calling repo,
and Neon preview branches must be named exactly `preview/<raw git branch name>`
(as the Neon and Vercel integration does). Run `workflow_dispatch` with
`dry_run` first and read the step summary before the Monday cron fires.
Fail-closed checks protect against a bad token or `GITHUB_REPOSITORY`: before
sweeping, a canary reads the repo and its default branch, and if either call
fails no `preview/*` branch is deleted that run. `max_age_hours` must be at
least 1. Neon calls are retried with backoff on 423, 429 and 5xx, and every
request has a 30 second timeout.

Mike uses one personal Neon API key as `NEON_API_KEY` in all four callers.
Rotating it means re-running
`gh secret set NEON_API_KEY -R infinite-solutions-group/<repo>` for each of
finos, mikeludden, quayside-web and isg-web.

**Delete ceiling:** `max_deletes` (integer >= 1, default 25; the script reads
`MAX_DELETES`) applies to all rules. If more branches than that would be
deleted, the run refuses before deleting anything, and a dry run shows the same
refusal, so you can read the list and raise `max_deletes` for one run.

Run locally in dry-run mode:

```sh
NEON_API_KEY=… NEON_PROJECT_ID=… GITHUB_TOKEN=$(gh auth token) GITHUB_REPOSITORY=owner/repo DRY_RUN=true node scripts/neon-sweep.mjs
```

Tests: `npm test` (`node --test`, no install needed).

## Policy

Strict from day one: 0 errors + 0 warnings, silent-catch ban, type-aware promise
rules, `no-explicit-any`, `jsx-a11y`. See each project's `docs/code-style.md`.
