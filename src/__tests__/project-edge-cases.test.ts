/**
 * Boundary and edge-case tests for src/project.ts — `project:inspect_codebase`.
 *
 * src/__tests__/project.test.ts covers the contract; src/__tests__/project-dispatch.test.ts
 * covers the wire dispatch. This file targets the awkward inputs an orchestrator
 * (or a buggy caller) can actually send: dir values that are not directories,
 * symlinks, permission failures, pathological `dir` forms, and non-integer /
 * negative / non-finite bound values. Several of these are *characterization*
 * tests: they pin the behavior the implementation has today (which mirrors the
 * existing fs:* actions) so a future change is a deliberate one, and they are
 * called out as such in the coverage report.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile, chmod, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { inspectCodebase, DEFAULT_MAX_BYTES } from '../project'

function pathsOf(list: ReadonlyArray<{ path: string }>): string[] {
  return list.map((item) => item.path)
}

function configsOf(result: { configs: ReadonlyArray<{ path: string }> }): string[] {
  return pathsOf(result.configs)
}

/** True when mode bits cannot make anything unreadable (root bypasses permissions). */
function runningAsRoot(): boolean {
  return typeof process.getuid === 'function' && process.getuid() === 0
}

describe('project/inspectCodebase — boundary conditions', () => {
  let testDir: string

  beforeEach(async () => {
    testDir = await mkdtemp(path.join(tmpdir(), 'specflow-worker-project-edge-'))
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  describe('dir values that are not a directory', () => {
    it('returns empty sections when dir is a regular file (ENOTDIR), without throwing', async () => {
      const aFile = path.join(testDir, 'not-a-dir.txt')
      await writeFile(aFile, 'plain file', 'utf8')

      const result = await inspectCodebase({ dir: aFile })

      expect(result).toEqual({ dir: aFile, manifests: [], configs: [], snippets: [] })
    })

    it('returns empty sections when dir is a symlink to a nonexistent target', async () => {
      const dangling = path.join(testDir, 'dangling-dir-link')
      await symlink(path.join(testDir, 'missing'), dangling)

      const result = await inspectCodebase({ dir: dangling })

      expect(result).toEqual({ dir: dangling, manifests: [], configs: [], snippets: [] })
    })

    it('inspects normally when dir itself is a symlink to a real directory', async () => {
      const real = path.join(testDir, 'real')
      await mkdir(path.join(real, 'src'), { recursive: true })
      await writeFile(path.join(real, 'package.json'), '{"name":"linked"}', 'utf8')
      await writeFile(path.join(real, 'src/index.ts'), 'export const a = 1\n', 'utf8')

      const asLink = path.join(testDir, 'link-to-real')
      await symlink(real, asLink)

      const result = await inspectCodebase({ dir: asLink })

      expect(pathsOf(result.manifests)).toEqual(['package.json'])
      expect(result.manifests[0]?.content).toBe('{"name":"linked"}')
      expect(pathsOf(result.snippets)).toEqual(['src/index.ts'])
      // dir is echoed verbatim, not resolved through the symlink.
      expect(result.dir).toBe(asLink)
    })

    it('returns empty sections for an unreadable directory instead of throwing', async () => {
      if (runningAsRoot()) return // chmod 000 cannot block root

      const locked = path.join(testDir, 'locked')
      await mkdir(path.join(locked, 'src'), { recursive: true })
      await writeFile(path.join(locked, 'package.json'), '{}', 'utf8')
      await writeFile(path.join(locked, 'src/index.ts'), 'export const a = 1\n', 'utf8')
      await chmod(locked, 0o000)

      try {
        const result = await inspectCodebase({ dir: locked })
        expect(result).toEqual({ dir: locked, manifests: [], configs: [], snippets: [] })
      } finally {
        await chmod(locked, 0o755).catch(() => {})
      }
    })

    it('CHARACTERIZATION: a relative dir resolves against the process cwd, not the project', async () => {
      // The spec says dir is an absolute path; nothing enforces it. A relative
      // value is path.join'd and resolved against the daemon's cwd, so "." or
      // "src" inspects the DAEMON'S directory — including its own manifests.
      // Same posture as fs:read_file with a relative path. Reported as a
      // hardening candidate (reject non-absolute dir), not silently fixed.
      const relative = await inspectCodebase({ dir: '.' })
      const absolute = await inspectCodebase({ dir: process.cwd() })

      expect(relative.dir).toBe('.')
      // A relative dir is not rejected and behaves exactly like the absolute
      // cwd — that equivalence is the finding.
      expect(relative.manifests).toEqual(absolute.manifests)
      expect(configsOf(relative)).toEqual(configsOf(absolute))
      expect(pathsOf(relative.snippets)).toEqual(pathsOf(absolute.snippets))

      if (await Bun.file(path.join(process.cwd(), 'package.json')).exists()) {
        expect(pathsOf(relative.manifests)).toContain('package.json')
      }
    })

    it('treats whitespace-only dir as a real (relative) path rather than as missing', async () => {
      // The empty-dir guard tests truthiness, so " " slips through and is joined
      // into " package.json". Asserting the exact output keeps it bounded.
      const result = await inspectCodebase({ dir: ' ' })

      expect(result.dir).toBe(' ')
      expect(result.manifests).toEqual([])
      expect(result.configs).toEqual([])
      expect(result.snippets).toEqual([])
    })

    it('accepts a non-absolute-but-deep path without throwing', async () => {
      const result = await inspectCodebase({ dir: 'no/such/dir/at/all' })

      expect(result).toEqual({ dir: 'no/such/dir/at/all', manifests: [], configs: [], snippets: [] })
    })
  })

  describe('symlinks inside the tree', () => {
    it('follows a symlinked source FILE but never descends into a symlinked directory', async () => {
      await mkdir(path.join(testDir, 'src'), { recursive: true })
      await writeFile(path.join(testDir, 'src/real.ts'), 'export const real = 1\n', 'utf8')
      await symlink(path.join(testDir, 'src/real.ts'), path.join(testDir, 'src/link.ts'))

      await mkdir(path.join(testDir, 'elsewhere'), { recursive: true })
      await writeFile(path.join(testDir, 'elsewhere/hidden.ts'), 'export const hidden = 1\n', 'utf8')
      await symlink(path.join(testDir, 'elsewhere'), path.join(testDir, 'src/loop'))

      const result = await inspectCodebase({ dir: testDir, maxSnippets: 50 })

      // `elsewhere` is a real directory so it is walked; the symlink `src/loop`
      // is never descended into (Dirent.isDirectory() is false for symlinks) —
      // the same posture as the fs:* walks.
      expect(pathsOf(result.snippets)).toEqual(['elsewhere/hidden.ts', 'src/link.ts', 'src/real.ts'])
      expect(pathsOf(result.snippets).some((p) => p.startsWith('src/loop/'))).toBe(false)
      // A symlinked file IS read, resolving through to its target's content.
      const link = result.snippets.find((s) => s.path === 'src/link.ts')
      expect(link?.content).toBe('export const real = 1\n')
      expect(link?.language).toBe('typescript')
    })

    it('CHARACTERIZATION: symlinked dirs whose target is inside the tree still yield no entries', async () => {
      const target = path.join(testDir, 'packages', 'app', 'src')
      await mkdir(target, { recursive: true })
      await writeFile(path.join(target, 'main.ts'), 'export const main = 1\n', 'utf8')
      await symlink(target, path.join(testDir, 'app-link'))

      const result = await inspectCodebase({ dir: testDir, maxSnippets: 50 })

      expect(pathsOf(result.snippets)).toEqual(['packages/app/src/main.ts'])
    })
  })

  describe('files that are both curated config and source', () => {
    it('CHARACTERIZATION: eslint.config.js is reported in configs AND snippets', async () => {
      await writeFile(path.join(testDir, 'eslint.config.js'), 'export default []\n', 'utf8')

      const result = await inspectCodebase({ dir: testDir })

      expect(pathsOf(result.configs)).toEqual(['eslint.config.js'])
      expect(pathsOf(result.snippets)).toEqual(['eslint.config.js'])
      expect(result.snippets[0]?.language).toBe('javascript')
    })

    it('does not let a curated config displace snippet budget', async () => {
      await writeFile(path.join(testDir, 'eslint.config.js'), 'export default []\n', 'utf8')
      await writeFile(path.join(testDir, 'a.ts'), 'export const a = 1\n', 'utf8')
      await writeFile(path.join(testDir, 'b.ts'), 'export const b = 1\n', 'utf8')

      const result = await inspectCodebase({ dir: testDir, maxSnippets: 2 })

      // Sorted walk: a.ts, b.ts, eslint.config.js -> the first two win the budget.
      expect(pathsOf(result.configs)).toEqual(['eslint.config.js'])
      expect(pathsOf(result.snippets)).toEqual(['a.ts', 'b.ts'])
    })
  })

  describe('non-integer, negative and non-finite bounds', () => {
    async function makeProject(): Promise<string> {
      const dir = path.join(testDir, 'proj')
      await mkdir(path.join(dir, 'src'), { recursive: true })
      await writeFile(path.join(dir, 'package.json'), '{"name":"demo"}', 'utf8')
      await writeFile(path.join(dir, 'src/one.ts'), 'const one = 1\n', 'utf8')
      await writeFile(path.join(dir, 'src/two.ts'), 'const two = 2\n', 'utf8')
      await writeFile(path.join(dir, 'src/three.ts'), 'const three = 3\n', 'utf8')
      return dir
    }

    it('CHARACTERIZATION: maxSnippets is an upper-bound check, so fractional values round up', async () => {
      const dir = await makeProject()

      const result = await inspectCodebase({ dir, maxSnippets: 1.9 })

      // The guard is `paths.length >= maxSnippets`, evaluated after each push:
      // length 1 >= 1.9 is false so a second entry is collected — ceil(), not
      // floor(). Identical arithmetic to fs:find_files' maxResults guard.
      expect(result.snippets.length).toBe(2)
    })

    it('CHARACTERIZATION: walk order is localeCompare collation, not codepoint order', async () => {
      const dir = path.join(testDir, 'collation')
      await mkdir(dir, { recursive: true })
      for (const name of ['two.ts', 'three.ts', 'Zeta.ts', 'alpha.ts']) {
        await writeFile(path.join(dir, name), 'export const v = 1\n', 'utf8')
      }

      const result = await inspectCodebase({ dir, maxSnippets: 50 })

      // ICU collation compares case-insensitively at the primary level, so
      // "alpha" < "three" < "two" < "Zeta" — notably "three" sorts BEFORE "two",
      // which is not codepoint order. Which files win the maxSnippets budget
      // therefore depends on the daemon's collation (fs:get_tree has the same
      // posture), so a cross-machine byte-identical briefing is not guaranteed.
      expect(pathsOf(result.snippets)).toEqual(['alpha.ts', 'three.ts', 'two.ts', 'Zeta.ts'])
    })

    it('collects no snippets for a negative maxSnippets', async () => {
      const dir = await makeProject()

      const result = await inspectCodebase({ dir, maxSnippets: -1 })

      expect(result.snippets).toEqual([])
      // Manifests/configs are unaffected by the snippet budget.
      expect(pathsOf(result.manifests)).toEqual(['package.json'])
    })

    it('collects every source file for maxSnippets Infinity', async () => {
      const dir = await makeProject()

      const result = await inspectCodebase({ dir, maxSnippets: Infinity })

      expect(result.snippets.length).toBe(3)
    })

    it('CHARACTERIZATION: the requester can widen the caps — there is no server-side ceiling', async () => {
      const dir = path.join(testDir, 'wide')
      await mkdir(dir, { recursive: true })
      const big = 'y'.repeat(250_000)
      await writeFile(path.join(dir, 'package.json'), big, 'utf8')

      const result = await inspectCodebase({ dir, maxBytes: 10_000_000 })

      // maxBytes is honoured verbatim, so one query-response can exceed the
      // 100k review-protection default by orders of magnitude. Only the
      // requester sets the bound; the module never clamps. Reported as a
      // hardening candidate (e.g. Math.min(maxBytes, HARD_MAX_BYTES)).
      expect(result.manifests[0]?.content.length).toBe(250_000)
      expect(result.manifests[0]?.truncated).toBe(false)
    })

    it('treats null and undefined caps as "use the default" (JSON cannot carry NaN)', async () => {
      const dir = await makeProject()

      // JSON.stringify(NaN) === "null", so a wire-level NaN arrives as null and
      // is rejected by the typeof guard — the default bounds hold.
      const viaNull = await inspectCodebase({
        dir,
        maxBytes: JSON.parse(JSON.stringify({ maxBytes: NaN })).maxBytes,
        maxSnippets: JSON.parse(JSON.stringify({ maxSnippets: NaN })).maxSnippets,
      })

      expect(viaNull.manifests[0]?.truncated).toBe(false)
      expect(viaNull.snippets.length).toBe(3)
      expect(viaNull.snippets.length).toBeLessThanOrEqual(10)
    })

    it('CHARACTERIZATION: an in-process NaN cap widens both bounds (hardening candidate)', async () => {
      const dir = await makeProject()

      // typeof NaN === 'number', so the NaN passes the guard; every comparison
      // with NaN is false, so content is never sliced and the walk never stops.
      // Unreachable over the wire (see the null test above) but reachable from
      // callers such as Number('abc'); a Number.isFinite guard would close it.
      const result = await inspectCodebase({ dir, maxBytes: NaN, maxSnippets: NaN })

      expect(result.snippets.length).toBe(3)
      expect(result.manifests[0]?.truncated).toBe(false)
      expect(result.manifests[0]?.content).toBe('{"name":"demo"}')
    })

    it('CHARACTERIZATION: a negative maxBytes slices from the end of the string', async () => {
      const dir = path.join(testDir, 'neg')
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, 'package.json'), '{"name":"demo"}', 'utf8')

      const result = await inspectCodebase({ dir, maxBytes: -3 })

      const manifest = result.manifests[0]
      expect(manifest?.truncated).toBe(true)
      // '{"name":"demo"}' is 15 chars; slice(0, -3) drops the LAST 3 chars
      // instead of collapsing to "" — content stays non-empty and is not bounded
      // by the (negative) request. Parity with fs:read_file, but worth pinning.
      expect(manifest?.content).toBe('{"name":"dem')
      expect(manifest!.content.length).toBe(12)
    })

    it('bounds every section at the default 100k cap in a single call', async () => {
      const dir = await makeProject()
      const big = 'x'.repeat(DEFAULT_MAX_BYTES + 500)
      await writeFile(path.join(dir, 'package.json'), big, 'utf8')
      await writeFile(path.join(dir, 'src/one.ts'), big, 'utf8')

      const result = await inspectCodebase({ dir })

      expect(result.manifests[0]?.content.length).toBe(DEFAULT_MAX_BYTES)
      expect(result.manifests[0]?.truncated).toBe(true)
      expect(result.snippets.find((s) => s.path === 'src/one.ts')?.content.length).toBe(DEFAULT_MAX_BYTES)
    })

    it('slices multi-line content mid-line without adding an ellipsis marker', async () => {
      const dir = path.join(testDir, 'mid')
      await mkdir(path.join(dir, 'src'), { recursive: true })
      await writeFile(path.join(dir, 'src/a.ts'), 'line1\nline2\nline3\n', 'utf8')

      const result = await inspectCodebase({ dir, maxBytes: 8 })

      expect(result.snippets[0]?.content).toBe('line1\nli')
      expect(result.snippets[0]?.truncated).toBe(true)
      expect(result.snippets[0]?.content.includes('...')).toBe(false)
    })
  })

  describe('tree shape', () => {
    it('has no depth limit: a source file 12 levels down is still collected', async () => {
      let cur = path.join(testDir, 'deep')
      for (let i = 0; i < 12; i++) cur = path.join(cur, `level-${i}`)
      await mkdir(cur, { recursive: true })
      await writeFile(path.join(cur, 'leaf.ts'), 'export const leaf = 1\n', 'utf8')

      const result = await inspectCodebase({ dir: path.join(testDir, 'deep'), maxSnippets: 50 })

      expect(pathsOf(result.snippets)).toEqual([
        Array.from({ length: 12 }, (_, i) => `level-${i}`).join('/') + '/leaf.ts',
      ])
      expect(result.snippets[0]?.path.split('/').length).toBe(13)
    })

    it('CHARACTERIZATION: a skipped directory hides everything beneath it, however deep', async () => {
      await mkdir(path.join(testDir, 'dist', 'nested', 'deeper'), { recursive: true })
      await writeFile(path.join(testDir, 'dist', 'nested', 'deeper', 'bundle.ts'), 'export const b = 1\n', 'utf8')
      await writeFile(path.join(testDir, 'src.ts'), 'export const s = 1\n', 'utf8')

      const result = await inspectCodebase({ dir: testDir, maxSnippets: 50 })

      expect(pathsOf(result.snippets)).toEqual(['src.ts'])
    })

    it('survives a wide tree and still honours the snippet budget', async () => {
      await mkdir(path.join(testDir, 'many'), { recursive: true })
      await Promise.all(
        Array.from({ length: 300 }, async (_, i) =>
          writeFile(path.join(testDir, 'many', `f${String(i).padStart(3, '0')}.ts`), 'export const v = 1\n', 'utf8'),
        ),
      )

      const startedAt = Date.now()
      const result = await inspectCodebase({ dir: testDir, maxSnippets: 5 })
      const elapsed = Date.now() - startedAt

      expect(result.snippets.length).toBe(5)
      expect(pathsOf(result.snippets)).toEqual([
        'many/f000.ts',
        'many/f001.ts',
        'many/f002.ts',
        'many/f003.ts',
        'many/f004.ts',
      ])
      expect(elapsed).toBeLessThan(5_000)
    })

    it('reads a file with an uppercase extension through the same relative path', async () => {
      await mkdir(path.join(testDir, 'legacy'), { recursive: true })
      await writeFile(path.join(testDir, 'legacy', 'Main.JAVA'), 'class Main {}\n', 'utf8')

      const result = await inspectCodebase({ dir: testDir })

      expect(result.snippets[0]?.path).toBe('legacy/Main.JAVA')
      expect(result.snippets[0]?.language).toBe('java')
    })

    it('handles a dot-only filename with no extension', async () => {
      await writeFile(path.join(testDir, 'Dockerfile'), 'FROM deno\n', 'utf8')
      await writeFile(path.join(testDir, 'Makefile'), 'all:\n', 'utf8')

      const result = await inspectCodebase({ dir: testDir })

      expect(result.snippets).toEqual([])
    })
  })
})
