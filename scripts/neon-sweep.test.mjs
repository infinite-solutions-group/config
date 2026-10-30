import { test, describe, beforeEach, afterEach } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import {
  PROTECTED_BRANCH_NAMES,
  CI_PREFIXES,
  PREVIEW_PREFIX,
  isSweepablePrefix,
  parseExtraProtected,
  decodeDependabotName,
  decide,
  assertSweepable,
  sweep,
  main,
  githubCanary,
  sanitize,
  esc,
  formatSummary,
  neonRequest,
  listNeonBranches,
  deleteNeonBranch,
} from './neon-sweep.mjs'

const HOUR = 3600 * 1000
const noSleep = async () => {}
const NOW = Date.parse('2026-10-30T12:00:00Z')
const OLD = new Date(NOW - 48 * HOUR).toISOString()

function makeCtx(overrides = {}) {
  const calls = []
  const lookups = overrides.lookups ?? {}
  return {
    calls,
    now: NOW,
    maxAgeHours: 24,
    extraProtected: new Set(),
    gitBranchExists: async (name) => {
      calls.push(name)
      return name in lookups ? lookups[name] : false
    },
    ...overrides,
  }
}
const br = (name, extra = {}) => ({ id: `br-${name}`, name, created_at: OLD, ...extra })

test('constants', () => {
  assert.deepEqual(CI_PREFIXES, ['ci/', 'ci-pr-', 'ci-pt-'])
  assert.equal(PREVIEW_PREFIX, 'preview/')
  assert.equal(PROTECTED_BRANCH_NAMES.size, 10)
})

test('isSweepablePrefix', () => {
  for (const n of ['ci/1', 'ci-pr-5', 'ci-pt-5-2', 'preview/x'])
    assert.equal(isSweepablePrefix(n), true)
  for (const n of ['main', 'feature/x', 'cipr-1', 'Preview/x'])
    assert.equal(isSweepablePrefix(n), false)
})

test('hard denylist is skipped even when old', async () => {
  for (const name of PROTECTED_BRANCH_NAMES) {
    const ctx = makeCtx()
    const d = await decide(br(name), ctx)
    assert.equal(d.action, 'skip', name)
    assert.match(d.reason, /hard denylist/)
    assert.equal(ctx.calls.length, 0)
  }
})

test('primary / default / protected flags skip', async () => {
  const p = await decide(br('ci/1', { primary: true }), makeCtx())
  assert.equal(p.action, 'skip')
  assert.match(p.reason, /primary branch/)
  const d = await decide(br('ci/1', { default: true }), makeCtx())
  assert.equal(d.action, 'skip')
  assert.match(d.reason, /default branch/)
  const x = await decide(br('ci/1', { protected: true }), makeCtx())
  assert.equal(x.action, 'skip')
  assert.match(x.reason, /Neon-protected/)
})

test('EXTRA_PROTECTED skips', async () => {
  const d = await decide(br('ci/keepme'), makeCtx({ extraProtected: new Set(['ci/keepme']) }))
  assert.equal(d.action, 'skip')
  assert.match(d.reason, /EXTRA_PROTECTED/)
})

test('parseExtraProtected', () => {
  assert.deepEqual([...parseExtraProtected('')], [])
  assert.deepEqual([...parseExtraProtected(' a , b,, ,c ')], ['a', 'b', 'c'])
  assert.deepEqual([...parseExtraProtected(undefined)], [])
})

test('age boundary', async () => {
  const exact = new Date(NOW - 24 * HOUR).toISOString()
  const older = new Date(NOW - 24 * HOUR - 1).toISOString()
  const d1 = await decide(br('ci/1', { created_at: exact }), makeCtx())
  assert.equal(d1.action, 'skip')
  assert.match(d1.reason, /younger than MAX_AGE_HOURS/)
  const d2 = await decide(br('ci/1', { created_at: older }), makeCtx())
  assert.equal(d2.action, 'delete')
})

test('unparseable or missing created_at skips', async () => {
  for (const created_at of ['garbage', undefined, '']) {
    const d = await decide(br('ci/1', { created_at }), makeCtx())
    assert.equal(d.action, 'skip')
    assert.match(d.reason, /unparseable created_at/)
  }
})

test('CI orphans delete without git lookup', async () => {
  for (const name of ['ci/123-1', 'ci-pr-5', 'ci-pt-5-2']) {
    const ctx = makeCtx()
    const d = await decide(br(name), ctx)
    assert.equal(d.action, 'delete', name)
    assert.equal(d.rule, 'ci-orphan')
    assert.deepEqual(ctx.calls, [])
  }
})

test('preview orphan: git 404 deletes', async () => {
  const ctx = makeCtx({ lookups: { 'feat/foo': false } })
  const d = await decide(br('preview/feat/foo'), ctx)
  assert.equal(d.action, 'delete')
  assert.equal(d.rule, 'preview-orphan')
  assert.deepEqual(ctx.calls, ['feat/foo'])
})

test('preview: git branch exists skips', async () => {
  const ctx = makeCtx({ lookups: { 'feat/foo': true } })
  const d = await decide(br('preview/feat/foo'), ctx)
  assert.equal(d.action, 'skip')
  assert.match(d.reason, /git branch still exists/)
})

test('preview: unknown lookup refuses', async () => {
  const ctx = makeCtx({ lookups: { 'feat/foo': 'unknown' } })
  const d = await decide(br('preview/feat/foo'), ctx)
  assert.equal(d.action, 'skip')
  assert.match(d.reason, /refusing to delete/)
})

const DEP = 'preview/dependabot%2Fnpm_and_yarn%2Ffoo-1.2.3'
const DEP_RAW = 'dependabot%2Fnpm_and_yarn%2Ffoo-1.2.3'
const DEP_DECODED = 'dependabot/npm_and_yarn/foo-1.2.3'

test('dependabot encoded: both 404 deletes', async () => {
  const ctx = makeCtx({ lookups: { [DEP_RAW]: false, [DEP_DECODED]: false } })
  const d = await decide(br(DEP), ctx)
  assert.equal(d.action, 'delete')
  assert.equal(d.rule, 'preview-orphan')
  assert.deepEqual(ctx.calls, [DEP_RAW, DEP_DECODED])
})

test('dependabot encoded: decoded exists skips', async () => {
  const ctx = makeCtx({ lookups: { [DEP_RAW]: false, [DEP_DECODED]: true } })
  const d = await decide(br(DEP), ctx)
  assert.equal(d.action, 'skip')
  assert.match(d.reason, /git branch still exists/)
  assert.deepEqual(ctx.calls, [DEP_RAW, DEP_DECODED])
})

test('dependabot encoded: decoded unknown skips', async () => {
  const ctx = makeCtx({ lookups: { [DEP_RAW]: false, [DEP_DECODED]: 'unknown' } })
  const d = await decide(br(DEP), ctx)
  assert.equal(d.action, 'skip')
  assert.match(d.reason, /refusing to delete/)
})

test('dependabot encoded: as-is exists skips without decoded lookup', async () => {
  const ctx = makeCtx({ lookups: { [DEP_RAW]: true } })
  const d = await decide(br(DEP), ctx)
  assert.equal(d.action, 'skip')
  assert.deepEqual(ctx.calls, [DEP_RAW])
})

test('unmatched prefix skips', async () => {
  const ctx = makeCtx()
  const d = await decide(br('feature/x'), ctx)
  assert.equal(d.action, 'skip')
  assert.match(d.reason, /sweepable prefix/)
  assert.deepEqual(ctx.calls, [])
})

test('decodeDependabotName', () => {
  assert.equal(decodeDependabotName(DEP_RAW), DEP_DECODED)
  assert.equal(decodeDependabotName('a%2fb%2Fc'), 'a/b/c')
  assert.equal(decodeDependabotName('plain'), 'plain')
  assert.equal(decodeDependabotName('bad%E0%A4%A'), 'bad%E0%A4%A')
})

test('assertSweepable', () => {
  assert.doesNotThrow(() => assertSweepable([{ name: 'ci/1' }, { name: 'preview/x' }]))
  assert.throws(
    () => assertSweepable([{ name: 'ci/1' }, { name: 'main' }]),
    /Refusing to sweep: candidate\(s\) lack a sweepable prefix: main/
  )
})

test('sweep calls the final guard before deleting anything', async () => {
  const deleted = []
  await assert.rejects(
    sweep({
      branches: [br('ci/1'), br('weird')],
      ctx: makeCtx(),
      dryRun: false,
      deleteBranch: async (b) => deleted.push(b.name),
      decideFn: async () => ({ action: 'delete', rule: 'x', reason: 'forced' }),
    }),
    /Refusing to sweep/
  )
  assert.deepEqual(deleted, [])
})

test('sweep dry run does not delete', async () => {
  let called = 0
  const res = await sweep({
    branches: [br('ci/1'), br('main')],
    ctx: makeCtx(),
    dryRun: true,
    deleteBranch: async () => {
      called++
    },
  })
  assert.equal(called, 0)
  assert.equal(res.deleted.length, 1)
  assert.equal(res.deleted[0].name, 'ci/1')
  assert.match(res.deleted[0].reason, /^DRY RUN: /)
  assert.equal(res.skipped.length, 1)
  assert.deepEqual(res.failed, [])
})

test('sweep records failures and continues', async () => {
  const res = await sweep({
    branches: [br('ci/1'), br('ci/2'), br('ci/3')],
    ctx: makeCtx(),
    dryRun: false,
    deleteBranch: async (b) => {
      if (b.name === 'ci/2') throw new Error('branch has children')
    },
  })
  assert.deepEqual(
    res.deleted.map((e) => e.name),
    ['ci/1', 'ci/3']
  )
  assert.equal(res.failed.length, 1)
  assert.equal(res.failed[0].name, 'ci/2')
  assert.match(res.failed[0].reason, /branch has children/)
})

// ---------------------------------------------------------------- CLI main()

describe('main() with stubbed fetch', () => {
  const realFetch = globalThis.fetch
  const realLog = console.log
  const realWarn = console.warn
  const realError = console.error
  let requests
  let logs

  const old = new Date(Date.now() - 48 * HOUR).toISOString()
  const neonBranches = [
    { id: 'id-main', name: 'main', primary: true, created_at: old },
    { id: 'id-ci', name: 'ci/123-1', created_at: old },
    { id: 'id-gone', name: 'preview/feat-gone', created_at: old },
    { id: 'id-live', name: 'preview/feat-live', created_at: old },
    { id: 'id-err', name: 'preview/feat-err', created_at: old },
    { id: 'id-dep', name: 'preview/dependabot%2Fnpm_and_yarn%2Ffoo-1.2.3', created_at: old },
    { id: 'id-pt', name: 'ci-pt-9-1', created_at: old },
  ]
  const jsonRes = (status, body) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  function installFetch({ listStatus = 200, repoStatus = 200 } = {}) {
    requests = []
    globalThis.fetch = async (url, init = {}) => {
      const method = init.method ?? 'GET'
      requests.push({ method, url: String(url), headers: init.headers ?? {} })
      const u = String(url)
      if (u.startsWith('https://console.neon.tech/')) {
        if (method === 'GET') {
          return listStatus === 200
            ? jsonRes(200, { branches: neonBranches })
            : jsonRes(listStatus, { message: 'boom' })
        }
        if (u.endsWith('/branches/id-pt')) return jsonRes(409, { message: 'branch has children' })
        return jsonRes(200, {})
      }
      if (u.startsWith('https://api.github.com/')) {
        if (u === 'https://api.github.com/repos/o/r') {
          return jsonRes(repoStatus, { default_branch: 'main' })
        }
        if (u.endsWith('/branches/main')) return jsonRes(200, {})
        if (u.endsWith('/branches/feat-live')) return jsonRes(200, {})
        if (u.endsWith('/branches/feat-err')) return jsonRes(500, {})
        return jsonRes(404, {})
      }
      throw new Error(`unexpected fetch ${method} ${u}`)
    }
  }

  beforeEach(() => {
    logs = []
    console.log = (...a) => logs.push(a.join(' '))
    console.warn = () => {}
    console.error = () => {}
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    console.log = realLog
    console.warn = realWarn
    console.error = realError
  })

  const baseEnv = {
    NEON_API_KEY: 'neon-key',
    NEON_PROJECT_ID: 'proj-1',
    GITHUB_REPOSITORY: 'o/r',
  }
  const deletes = () =>
    requests.filter((r) => r.method === 'DELETE').map((r) => r.url.split('/branches/')[1])

  test('real run deletes orphans, reports failures, exits 1', async () => {
    installFetch()
    const dir = mkdtempSync(join(tmpdir(), 'neon-sweep-'))
    const summary = join(dir, 'summary.md')
    try {
      const code = await main(
        {
          ...baseEnv,
          DRY_RUN: 'false',
          GITHUB_TOKEN: 't',
          GITHUB_STEP_SUMMARY: summary,
        },
        { sleepImpl: noSleep }
      )
      assert.equal(code, 1)
      assert.deepEqual(deletes().sort(), ['id-ci', 'id-dep', 'id-gone', 'id-pt'])

      const gh = requests.filter((r) => r.url.startsWith('https://api.github.com/'))
      const ghUrls = gh.map((r) => r.url)
      const base = 'https://api.github.com/repos/o/r/branches/'
      const i1 = ghUrls.indexOf(`${base}dependabot%252Fnpm_and_yarn%252Ffoo-1.2.3`)
      const i2 = ghUrls.indexOf(`${base}dependabot/npm_and_yarn/foo-1.2.3`)
      assert.ok(i1 >= 0 && i2 > i1, `dependabot lookups in order: ${ghUrls.join(', ')}`)
      for (const r of gh) assert.equal(r.headers.Authorization, 'Bearer t')

      for (const r of requests.filter((r) => r.url.startsWith('https://console.neon.tech/'))) {
        assert.equal(r.headers.Authorization, 'Bearer neon-key')
      }

      const md = readFileSync(summary, 'utf8')
      for (const s of [
        '### Deleted (3)',
        '### Failed (1)',
        'ci-pt-9-1',
        'branch has children',
        '### Skipped (3)',
      ]) {
        assert.ok(md.includes(s), `summary missing ${s}`)
      }
      assert.ok(!md.includes('neon-key'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('dry run issues no DELETE and exits 0', async () => {
    installFetch()
    const code = await main(
      { ...baseEnv, DRY_RUN: 'true', GITHUB_TOKEN: 't' },
      { sleepImpl: noSleep }
    )
    assert.equal(code, 0)
    assert.deepEqual(deletes(), [])
    assert.equal(logs.filter((l) => l.startsWith('WOULD DELETE')).length, 4)
  })

  test('no GITHUB_TOKEN: no GitHub calls, preview/* never deleted', async () => {
    installFetch()
    await main({ ...baseEnv, DRY_RUN: 'false' }, { sleepImpl: noSleep })
    assert.equal(requests.filter((r) => r.url.includes('api.github.com')).length, 0)
    assert.deepEqual(deletes().sort(), ['id-ci', 'id-pt'])
  })

  test('Neon list failure rejects', async () => {
    installFetch({ listStatus: 500 })
    await assert.rejects(
      main({ ...baseEnv, DRY_RUN: 'false', GITHUB_TOKEN: 't' }, { sleepImpl: noSleep }),
      /Neon list branches failed/
    )
  })
  test('canary failure: previews never deleted, warning mentions canary', async () => {
    installFetch({ repoStatus: 404 })
    const warns = []
    console.warn = (...a) => warns.push(a.join(' '))
    const code = await main(
      { ...baseEnv, DRY_RUN: 'false', GITHUB_TOKEN: 't' },
      { sleepImpl: noSleep }
    )
    assert.equal(code, 1) // ci-pt-9-1 still fails with 409
    assert.deepEqual(deletes().sort(), ['id-ci', 'id-pt'])
    assert.ok(
      warns.some((w) => /GitHub canary failed \(HTTP 404\)/.test(w)),
      warns.join('|')
    )
    // no per-branch lookups once the canary fails
    assert.ok(!requests.some((r) => r.url.endsWith('/branches/feat-gone')))
  })

  test('canary success logs nothing about canary', async () => {
    installFetch()
    const warns = []
    console.warn = (...a) => warns.push(a.join(' '))
    await main({ ...baseEnv, DRY_RUN: 'true', GITHUB_TOKEN: 't' }, { sleepImpl: noSleep })
    assert.ok(!warns.some((w) => /canary/.test(w)))
  })

  test('MAX_AGE_HOURS below 1 is rejected', async () => {
    installFetch()
    for (const v of ['0.1', '0', '-3', 'abc']) {
      const code = await main(
        { ...baseEnv, MAX_AGE_HOURS: v, GITHUB_TOKEN: 't' },
        { sleepImpl: noSleep }
      )
      assert.equal(code, 1, v)
    }
    assert.equal(requests.length, 0)
    assert.equal(
      await main(
        { ...baseEnv, MAX_AGE_HOURS: '1', DRY_RUN: 'true', GITHUB_TOKEN: 't' },
        { sleepImpl: noSleep }
      ),
      0
    )
  })

  test('project id is masked in output and summary', async () => {
    installFetch()
    const dir = mkdtempSync(join(tmpdir(), 'neon-sweep-'))
    const summary = join(dir, 'summary.md')
    try {
      await main(
        {
          ...baseEnv,
          NEON_PROJECT_ID: 'proj-secret-1234',
          DRY_RUN: 'true',
          GITHUB_TOKEN: 't',
          GITHUB_STEP_SUMMARY: summary,
        },
        { sleepImpl: noSleep }
      )
      const all = logs.join('\n') + readFileSync(summary, 'utf8')
      assert.ok(!all.includes('proj-secret-1234'))
      assert.ok(all.includes('…1234'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('MAX_PREVIEW_DELETE_FRACTION must be in (0, 1]', async () => {
    installFetch()
    for (const v of ['0', '1.5', 'abc', '-0.2', '']) {
      const code = await main(
        { ...baseEnv, MAX_PREVIEW_DELETE_FRACTION: v, GITHUB_TOKEN: 't' },
        { sleepImpl: noSleep }
      )
      assert.equal(code, 1, JSON.stringify(v))
    }
    assert.equal(requests.length, 0)
  })

  test('MAX_PREVIEW_DELETE_FRACTION=1 disables the cap; default 0.5 trips it', async () => {
    const allPreviews = Array.from({ length: 4 }, (_, i) => ({
      id: `p${i}`,
      name: `preview/gone${i}`,
      created_at: old,
    }))
    const stub = () => {
      requests = []
      globalThis.fetch = async (url, init = {}) => {
        const method = init.method ?? 'GET'
        const u = String(url)
        requests.push({ method, url: u, headers: init.headers ?? {} })
        if (u.startsWith('https://console.neon.tech/')) {
          return method === 'GET' ? jsonRes(200, { branches: allPreviews }) : jsonRes(200, {})
        }
        if (u === 'https://api.github.com/repos/o/r')
          return jsonRes(200, { default_branch: 'main' })
        if (u.endsWith('/branches/main')) return jsonRes(200, {})
        return jsonRes(404, {})
      }
    }
    const env = { ...baseEnv, DRY_RUN: 'false', GITHUB_TOKEN: 't' }
    stub()
    await assert.rejects(main(env, { sleepImpl: noSleep }), /Refusing to sweep: 4 of 4/)
    assert.deepEqual(deletes(), [])
    stub()
    const code = await main({ ...env, MAX_PREVIEW_DELETE_FRACTION: '1' }, { sleepImpl: noSleep })
    assert.equal(code, 0)
    assert.deepEqual(deletes().sort(), ['p0', 'p1', 'p2', 'p3'])
  })

  test('pagination follows pagination.next with limit=1000', async () => {
    requests = []
    globalThis.fetch = async (url, init = {}) => {
      requests.push({ method: init.method ?? 'GET', url: String(url) })
      const cursor = new URL(String(url)).searchParams.get('cursor')
      return cursor
        ? jsonRes(200, { branches: [{ id: 'b2', name: 'ci/2' }], pagination: {} })
        : jsonRes(200, { branches: [{ id: 'b1', name: 'ci/1' }], pagination: { next: 'CUR1' } })
    }
    const out = await listNeonBranches('p', 'k', { sleepImpl: noSleep })
    assert.deepEqual(
      out.map((b) => b.id),
      ['b1', 'b2']
    )
    assert.equal(requests.length, 2)
    for (const r of requests) assert.equal(new URL(r.url).searchParams.get('limit'), '1000')
    assert.equal(new URL(requests[1].url).searchParams.get('cursor'), 'CUR1')
  })

  test('every request carries an abort signal', async () => {
    installFetch()
    const signals = []
    const inner = globalThis.fetch
    globalThis.fetch = async (url, init = {}) => {
      signals.push(init.signal)
      return inner(url, init)
    }
    await main({ ...baseEnv, DRY_RUN: 'false', GITHUB_TOKEN: 't' }, { sleepImpl: noSleep })
    assert.ok(signals.length > 5)
    for (const sg of signals) assert.ok(sg instanceof AbortSignal)
  })
})

// ---------------------------------------------------------------- hardening

describe('githubCanary', () => {
  const res = (status, body = {}) => new Response(JSON.stringify(body), { status })
  test('200/200 is trusted', async () => {
    const urls = []
    const f = async (u, init) => {
      urls.push(String(u))
      assert.equal(init.headers.Authorization, 'Bearer t')
      return String(u).endsWith('/repos/o/r') ? res(200, { default_branch: 'trunk' }) : res(200)
    }
    assert.equal(await githubCanary('o/r', 't', f), true)
    assert.deepEqual(urls, [
      'https://api.github.com/repos/o/r',
      'https://api.github.com/repos/o/r/branches/trunk',
    ])
  })
  test('repo 404 is untrusted', async () => {
    assert.equal(await githubCanary('o/r', 't', async () => res(404)), false)
  })
  test('default branch lookup failing is untrusted', async () => {
    const f = async (u) =>
      String(u).endsWith('/repos/o/r') ? res(200, { default_branch: 'main' }) : res(404)
    assert.equal(await githubCanary('o/r', 't', f), false)
  })
  test('missing default_branch or network error is untrusted', async () => {
    assert.equal(await githubCanary('o/r', 't', async () => res(200, {})), false)
    assert.equal(
      await githubCanary('o/r', 't', async () => {
        throw new Error('net')
      }),
      false
    )
  })
  test('untrusted lookup note appears in the skip reason', async () => {
    const ctx = makeCtx({ lookups: { x: 'unknown' }, lookupNote: 'GitHub canary failed' })
    const d = await decide(br('preview/x'), ctx)
    assert.equal(d.action, 'skip')
    assert.match(d.reason, /canary/)
    assert.match(d.reason, /refusing to delete/)
  })
})

describe('preview delete cap', () => {
  const previews = (n) => Array.from({ length: n }, (_, i) => br(`preview/f${i}`))
  const run = (n, liveCount, extra = {}) =>
    sweep({
      branches: previews(n),
      ctx: makeCtx({
        gitBranchExists: async (name) => Number(name.slice(1)) < liveCount,
        ...extra,
      }),
      dryRun: true,
      deleteBranch: async () => {},
    })
  test('4 of 5 throws, even in dry run', async () => {
    await assert.rejects(
      run(5, 1),
      /Refusing to sweep: 4 of 5 preview\/\* branches would be deleted \(cap 0\.5\)/
    )
  })
  test('2 of 5 does not trigger', async () => {
    assert.equal((await run(5, 3)).deleted.length, 2)
  })
  test('1 of 1 does not trigger', async () => {
    assert.equal((await run(1, 0)).deleted.length, 1)
  })
  test('4 of 10 does not trigger; custom fraction honoured', async () => {
    assert.equal((await run(10, 6)).deleted.length, 4)
    await assert.rejects(run(10, 6, { maxPreviewDeleteFraction: 0.3 }), /cap 0\.3/)
  })
})

describe('neon retry/backoff', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })
  const stub = (statuses, headers = {}) => {
    const calls = []
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init })
      const st = statuses[Math.min(calls.length - 1, statuses.length - 1)]
      return new Response('{}', { status: st, headers })
    }
    return calls
  }
  const sleeper = () => {
    const delays = []
    return { delays, sleepImpl: async (ms) => void delays.push(ms) }
  }

  test('423, 423, 200 succeeds on the third call', async () => {
    const calls = stub([423, 423, 200])
    const { delays, sleepImpl } = sleeper()
    await deleteNeonBranch('p', 'k', { id: 'b' }, { sleepImpl })
    assert.equal(calls.length, 3)
    assert.deepEqual(delays, [1000, 2000])
  })
  test('5x 423 gives up and sweep records a failed entry', async () => {
    const calls = stub([423])
    const { delays, sleepImpl } = sleeper()
    const res = await sweep({
      branches: [br('ci/1')],
      ctx: makeCtx(),
      dryRun: false,
      deleteBranch: (b) => deleteNeonBranch('p', 'k', b, { sleepImpl }),
    })
    assert.equal(calls.length, 5)
    assert.equal(delays.length, 4)
    assert.equal(res.failed.length, 1)
    assert.match(res.failed[0].reason, /423/)
  })
  test('429 honours Retry-After, capped at 30s', async () => {
    stub([429, 429, 200], { 'retry-after': '3' })
    let s = sleeper()
    await neonRequest('https://console.neon.tech/x', {}, { sleepImpl: s.sleepImpl })
    assert.deepEqual(s.delays, [3000, 3000])
    stub([429, 200], { 'retry-after': '999' })
    s = sleeper()
    await neonRequest('https://console.neon.tech/x', {}, { sleepImpl: s.sleepImpl })
    assert.deepEqual(s.delays, [30000])
  })
  test('5xx retries, 409 and 404 do not', async () => {
    let calls = stub([503, 200])
    await neonRequest('https://console.neon.tech/x', {}, { sleepImpl: sleeper().sleepImpl })
    assert.equal(calls.length, 2)
    calls = stub([409])
    const r = await neonRequest(
      'https://console.neon.tech/x',
      {},
      { sleepImpl: sleeper().sleepImpl }
    )
    assert.equal(r.status, 409)
    assert.equal(calls.length, 1)
  })
  test('backoff doubles per attempt', async () => {
    stub([500])
    const { delays, sleepImpl } = sleeper()
    await neonRequest('https://console.neon.tech/x', {}, { sleepImpl })
    assert.deepEqual(delays, [1000, 2000, 4000, 8000])
  })
  test('GET list retries on 500 then succeeds', async () => {
    const calls = stub([500, 200])
    globalThis.fetch = ((inner) => async (u, i) => {
      const r = await inner(u, i)
      return r.status === 200 ? new Response(JSON.stringify({ branches: [] }), { status: 200 }) : r
    })(globalThis.fetch)
    assert.deepEqual(await listNeonBranches('p', 'k', { sleepImpl: noSleep }), [])
    assert.equal(calls.length, 2)
  })
})

describe('output hygiene', () => {
  test('sanitize strips control characters', () => {
    assert.equal(sanitize('a\x00b\nc\r\x1b[31md\x7fe'), 'abc[31mde')
    assert.equal(sanitize(undefined), '')
  })
  test('esc neutralises HTML, backticks, pipes and control chars', () => {
    const out = esc('<img src="x">&`|\n::error::boom')
    assert.ok(!/[<>"`|\n]/.test(out), out)
    assert.ok(out.includes('&lt;') && out.includes('&amp;') && out.includes('&quot;'))
  })
  test('summary wraps names in <code>, escapes and masks project', () => {
    const md = formatSummary({
      projectId: 'abcdef1234',
      dryRun: true,
      maxAgeHours: 24,
      result: {
        deleted: [],
        failed: [],
        skipped: [{ name: 'x`<b>\ny', rule: undefined, reason: '[l](http://e)|z' }],
      },
    })
    assert.ok(md.includes('<code>x&#96;&lt;b&gt;y</code>'), md)
    assert.ok(!md.includes('abcdef1234'))
    assert.ok(md.includes('…1234'))
    assert.ok(!md.includes('|z'))
  })
})
