# @infinite-solutions-group/config

Shared **ESLint**, **Prettier**, and **TSConfig** for Infinite Solutions
projects, plus a **reusable CI workflow**. One source of truth — bump the version
to pull improvements into every project.

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

## Policy

Strict from day one: 0 errors + 0 warnings, silent-catch ban, type-aware promise
rules, `no-explicit-any`, `jsx-a11y`. See each project's `docs/code-style.md`.
