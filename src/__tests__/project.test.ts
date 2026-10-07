/**
 * Tests for the `project:inspect_codebase` control action.
 *
 * Scaffolding mirrors src/__tests__/git-utils.test.ts (mkdtemp per test,
 * recursive-force cleanup). Hermetic by construction: every fixture lives
 * inside the mkdtemp dir; the daemon subprocess only ever talks to a fake
 * orchestrator on localhost, and no git command or provider is involved.
 *
 * Three tiers deliberately share this one file, because spec §3.4 mandates
 * src/__tests__/project.test.ts as the only test artifact of this feature:
 *  1. `inspectCodebase()` contract tests (src/project.ts, unit).
 *  2. Boundary / edge-case tests, including CHARACTERIZATION pins that lock in
 *     today's behaviour for awkward inputs an orchestrator can actually send.
 *  3. Dispatch integration tests for the `project:` branch of `handleControl`
 *     (spec §3.2). That dispatcher is a closure created inside `runDaemon()`
 *     and is not exported, so it cannot be imported; instead the real daemon
 *     entrypoint is driven as a subprocess against a hermetic fake orchestrator
 *     (Bun.serve on port 0) that speaks only the three endpoints the daemon
 *     uses: POST /api/worker/heartbeat, GET /api/worker/stream and
 *     POST /api/worker/query-response. Tier 3 is what verifies acceptance
 *     criteria 4 (structured briefing in exactly one query-response), 6
 *     (unknown project:* answered instead of hanging; missing queryId silently
 *     dropped) and the observable half of 7 (no provider run, no git command).
 *     Tier 3 needs to bind a loopback port and spawn `bun src/cli.ts start`; if
 *     that is ever impossible in a CI sandbox, tier 3 is the section to gate off
 *     — tiers 1 and 2 stay pure-filesystem and hermetic.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile, chmod, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  inspectCodebase,
  MANIFEST_FILES,
  CONFIG_FILES,
  SOURCE_EXTENSIONS,
  SKIP_DIRS,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_SNIPPETS,
} from '../project'
import { EXT_LANGUAGE } from '../git/utils'

/** The eight directories the fs:* walks (and this action) must never traverse. */
const SKIPPED_DIR_NAMES = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'coverage',
  '.cache',
  '__pycache__',
]

/** The eleven snippet-capable extensions. */
const SOURCE_EXT_NAMES = [
  '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.rb', '.java', '.sh', '.sql',
]

/** Curated root-level manifests, in the exact response order. */
const EXPECTED_MANIFEST_FILES = [
  'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'requirements.txt',
  'Gemfile', 'composer.json', 'pom.xml', 'build.gradle', 'mix.exs', 'pubspec.yaml',
  'deno.json',
]

/** Curated root-level configs, in the exact response order. */
const EXPECTED_CONFIG_FILES = [
  'tsconfig.json', '.gitignore', '.dockerignore', '.env.example', '.editorconfig',
  '.prettierrc', '.prettierrc.json', 'eslint.config.js', 'eslint.config.mjs',
  'biome.json', 'biome.jsonc', 'turbo.json',
]

async function writeFixture(root: string, relPath: string, content: string): Promise<void> {
  const abs = path.join(root, relPath)
  await mkdir(path.dirname(abs), { recursive: true })
  await writeFile(abs, content, 'utf8')
}

function pathsOf(list: ReadonlyArray<{ path: string }>): string[] {
  return list.map((item) => item.path)
}

/** One captured POST /api/worker/query-response body. */
interface CapturedQueryResponse {
  queryId?: string
  result?: unknown
  error?: string | null
}

/** True when mode bits cannot make a file unreadable (root bypasses permissions). */
function runningAsRoot(): boolean {
  return typeof process.getuid === 'function' && process.getuid() === 0
}

// ---------------------------------------------------------------------------
// Tier 1 — inspectCodebase() contract (src/project.ts)
// ---------------------------------------------------------------------------

describe('project/inspectCodebase', () => {
  let testDir: string

  beforeEach(async () => {
    testDir = await mkdtemp(path.join(tmpdir(), 'specflow-worker-project-test-'))
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  describe('manifests and configs', () => {
    it('reads existing curated manifests and configs with relative paths and raw content', async () => {
      await writeFixture(testDir, 'package.json', '{"name":"demo","version":"1.0.0"}')
      await writeFixture(testDir, 'pyproject.toml', '[project]\nname = "demo"\n')
      await writeFixture(testDir, 'deno.json', '{"tasks":{}}\n')
      await writeFixture(testDir, 'tsconfig.json', '{"compilerOptions":{"strict":true}}')
      await writeFixture(testDir, '.gitignore', 'node_modules\ndist\n')
      await writeFixture(testDir, '.editorconfig', 'root = true\n')

      const result = await inspectCodebase({ dir: testDir })

      expect(result.dir).toBe(testDir)
      expect(
        result.manifests.map((m) => ({ path: m.path, content: m.content, truncated: m.truncated }))
      ).toEqual([
        { path: 'package.json', content: '{"name":"demo","version":"1.0.0"}', truncated: false },
        { path: 'pyproject.toml', content: '[project]\nname = "demo"\n', truncated: false },
        { path: 'deno.json', content: '{"tasks":{}}\n', truncated: false },
      ])
      expect(pathsOf(result.configs)).toEqual(['tsconfig.json', '.gitignore', '.editorconfig'])
      expect(result.configs.map((c) => c.content)).toEqual([
        '{"compilerOptions":{"strict":true}}',
        'node_modules\ndist\n',
        'root = true\n',
      ])
      expect(result.configs.every((c) => c.truncated === false)).toBe(true)
    })

    it('preserves curated-list order rather than alphabetical or filesystem order', async () => {
      // Created in reverse alphabetical order; MANIFEST_FILES order is
      // package.json < pyproject.toml < Cargo.toml, CONFIG_FILES order is
      // tsconfig.json < .gitignore < .editorconfig.
      await writeFixture(testDir, '.editorconfig', 'root = true\n')
      await writeFixture(testDir, '.gitignore', 'build\n')
      await writeFixture(testDir, 'tsconfig.json', '{}')
      await writeFixture(testDir, 'Cargo.toml', '[package]\nname = "x"\n')
      await writeFixture(testDir, 'pyproject.toml', '[project]\n')
      await writeFixture(testDir, 'package.json', '{}')

      const result = await inspectCodebase({ dir: testDir })

      expect(pathsOf(result.manifests)).toEqual(['package.json', 'pyproject.toml', 'Cargo.toml'])
      expect(pathsOf(result.configs)).toEqual(['tsconfig.json', '.gitignore', '.editorconfig'])
    })

    it('reports the contract response shape exactly', async () => {
      await writeFixture(testDir, 'package.json', '{}')
      await writeFixture(testDir, 'tsconfig.json', '{}')
      await writeFixture(testDir, 'src/index.ts', 'export const a = 1\n')

      const result = await inspectCodebase({ dir: testDir })

      expect(Object.keys(result).sort()).toEqual(['configs', 'dir', 'manifests', 'snippets'])
      expect(Object.keys(result.manifests[0] ?? {}).sort()).toEqual(['content', 'path', 'truncated'])
      expect(Object.keys(result.snippets[0] ?? {}).sort()).toEqual([
        'content',
        'language',
        'path',
        'truncated',
      ])
    })

    it('never reports lockfiles as manifests', async () => {
      await writeFixture(testDir, 'bun.lock', '{"lockfileVersion":1}')
      await writeFixture(testDir, 'package-lock.json', '{"lockfileVersion":3}')
      await writeFixture(testDir, 'yarn.lock', '# @generated\n')
      await writeFixture(testDir, 'pnpm-lock.yaml', 'lockfileVersion: 9\n')
      await writeFixture(testDir, 'Cargo.lock', '# generated\n')

      const result = await inspectCodebase({ dir: testDir })

      expect(result.manifests).toEqual([])
      expect(result.snippets).toEqual([])
    })

    it('collects only root-level manifests/configs, never nested ones', async () => {
      await writeFixture(testDir, 'package.json', '{"name":"root"}')
      await writeFixture(testDir, 'src/package.json', '{"name":"nested"}')
      await writeFixture(testDir, 'nested/tsconfig.json', '{"nested":true}')

      const result = await inspectCodebase({ dir: testDir, maxSnippets: 50 })

      expect(pathsOf(result.manifests)).toEqual(['package.json'])
      expect(pathsOf(result.configs)).toEqual([])
      expect(pathsOf(result.snippets)).toEqual([])
    })

    it('treats a curated name that is a directory as missing (never reads inside it)', async () => {
      await mkdir(path.join(testDir, 'package.json'), { recursive: true })
      await writeFixture(testDir, 'package.json/inner.json', '{"leak":true}')

      const result = await inspectCodebase({ dir: testDir })

      expect(result.manifests).toEqual([])
      expect(result.configs).toEqual([])
    })
  })

  describe('missing files, missing dir, empty dir', () => {
    it('skips curated files that do not exist, with no null entries', async () => {
      await writeFixture(testDir, 'package.json', '{"name":"only"}')

      const result = await inspectCodebase({ dir: testDir })

      expect(result.manifests).toEqual([
        { path: 'package.json', content: '{"name":"only"}', truncated: false },
      ])
      expect(result.manifests).not.toContainEqual(null)
      expect(result.manifests.every((m) => m !== null && typeof m.content === 'string')).toBe(true)
      expect(result.configs).toEqual([])
      expect(result.snippets).toEqual([])
    })

    it('returns empty arrays for a directory that does not exist, without throwing', async () => {
      const missing = path.join(testDir, 'nope')

      await expect(inspectCodebase({ dir: missing })).resolves.toEqual({
        dir: missing,
        manifests: [],
        configs: [],
        snippets: [],
      })
    })

    it('returns empty arrays for a deeply nested nonexistent path', async () => {
      const missing = path.join(testDir, 'a', 'b', 'c')

      const result = await inspectCodebase({ dir: missing })

      expect(result.manifests).toEqual([])
      expect(result.configs).toEqual([])
      expect(result.snippets).toEqual([])
    })

    it('returns empty arrays for an existing but empty directory', async () => {
      const empty = path.join(testDir, 'empty-repo')
      await mkdir(empty, { recursive: true })

      const result = await inspectCodebase({ dir: empty })

      expect(result).toEqual({ dir: empty, manifests: [], configs: [], snippets: [] })
    })

    it('returns empty arrays for an empty dir string without reading the daemon cwd', async () => {
      // Regression guard: path.join('', 'package.json') is relative to the
      // daemon cwd, and this repo has a package.json / tsconfig.json there.
      const result = await inspectCodebase({ dir: '' })

      expect(result).toEqual({ dir: '', manifests: [], configs: [], snippets: [] })
    })

    it('returns empty arrays when dir is absent/non-string without reading the daemon cwd', async () => {
      const undefinedDir = await inspectCodebase({ dir: undefined as unknown as string })
      const nullDir = await inspectCodebase({ dir: null as unknown as string })

      expect(undefinedDir).toEqual({ dir: '', manifests: [], configs: [], snippets: [] })
      expect(nullDir).toEqual({ dir: '', manifests: [], configs: [], snippets: [] })
    })
  })

  describe('soft-fail reads', () => {
    it('treats an unreadable manifest and an unreadable snippet as missing, without throwing', async () => {
      await writeFixture(testDir, 'package.json', '{"name":"locked"}')
      await writeFixture(testDir, 'src/locked.ts', 'export const hidden = 1')
      await writeFixture(testDir, 'src/readable.ts', 'export const ok = 1')
      await chmod(path.join(testDir, 'package.json'), 0o000)
      await chmod(path.join(testDir, 'src/locked.ts'), 0o000)

      try {
        const result = await inspectCodebase({ dir: testDir })

        if (runningAsRoot()) {
          // root bypasses mode bits, so both files stay readable
          expect(pathsOf(result.manifests)).toEqual(['package.json'])
          expect(result.snippets.length).toBe(2)
          return
        }
        expect(pathsOf(result.manifests)).toEqual([])
        expect(pathsOf(result.snippets)).toEqual(['src/readable.ts'])
      } finally {
        await chmod(path.join(testDir, 'package.json'), 0o644)
        await chmod(path.join(testDir, 'src/locked.ts'), 0o644)
      }
    })

    it('drops a dangling symlink from snippets instead of reporting a null entry', async () => {
      await writeFixture(testDir, 'src/real.ts', 'export const real = 1')
      await symlink(path.join(testDir, 'gone.ts'), path.join(testDir, 'src/broken.ts'))

      const result = await inspectCodebase({ dir: testDir })

      expect(pathsOf(result.snippets)).toEqual(['src/real.ts'])
      expect(result.snippets).not.toContainEqual(null)
    })
  })

  describe('snippets', () => {
    it('collects a nested source file with relative /-separated path and language', async () => {
      await writeFixture(testDir, 'src/index.ts', 'export const answer = 42\n')

      const result = await inspectCodebase({ dir: testDir })

      expect(result.snippets).toEqual([
        {
          path: 'src/index.ts',
          language: 'typescript',
          content: 'export const answer = 42\n',
          truncated: false,
        },
      ])
      expect(result.snippets[0]?.path).not.toContain('\\')
      expect(result.snippets[0]?.path).not.toContain(testDir)
    })

    it('maps every source extension to a non-empty language via EXT_LANGUAGE', async () => {
      const expectedLanguages: Record<string, string> = {
        '.ts': 'typescript',
        '.tsx': 'typescript',
        '.js': 'javascript',
        '.jsx': 'javascript',
        '.py': 'python',
        '.go': 'go',
        '.rs': 'rust',
        '.rb': 'ruby',
        '.java': 'java',
        '.sh': 'shell',
        '.sql': 'sql',
      }
      for (const ext of SOURCE_EXT_NAMES) {
        await writeFixture(testDir, `src/probe${ext}`, `// ${ext}\n`)
      }

      const result = await inspectCodebase({ dir: testDir, maxSnippets: 50 })

      expect(result.snippets.length).toBe(SOURCE_EXT_NAMES.length)
      const languageByExt = new Map(
        result.snippets.map((s) => [path.extname(s.path).toLowerCase(), s.language] as const)
      )
      for (const ext of SOURCE_EXT_NAMES) {
        const expected: string = expectedLanguages[ext] ?? ''
        const fromSharedMap: string = EXT_LANGUAGE[ext] ?? ''
        expect(expected).not.toBe('')
        expect(fromSharedMap).not.toBe('') // every curated ext must resolve via EXT_LANGUAGE
        expect(languageByExt.get(ext)).toBe(expected)
        expect(languageByExt.get(ext)).toBe(fromSharedMap)
        expect(languageByExt.get(ext)).not.toBe('plaintext')
      }
    })

    it('lowercases the extension when resolving language', async () => {
      await writeFixture(testDir, 'src/UPPER.TS', 'export const loud = true\n')

      const result = await inspectCodebase({ dir: testDir })

      expect(result.snippets).toEqual([
        {
          path: 'src/UPPER.TS',
          language: 'typescript',
          content: 'export const loud = true\n',
          truncated: false,
        },
      ])
    })

    it('ignores files whose extension is not a source extension', async () => {
      await writeFixture(testDir, 'README.md', '# project\n')
      await writeFixture(testDir, 'docker-compose.yaml', 'services: {}\n')
      await writeFixture(testDir, 'data.json', '{"a":1}')
      await writeFixture(testDir, 'styles/app.css', 'body{}')
      await writeFixture(testDir, 'assets/logo.png', '\uFFFD\uFFFDbinary\uFFFD')
      await writeFixture(testDir, 'src/keep.go', 'package main\n')

      const result = await inspectCodebase({ dir: testDir })

      expect(pathsOf(result.snippets)).toEqual(['src/keep.go'])
    })

    it('includes hidden source files but never skipped-directory contents', async () => {
      await writeFixture(testDir, 'lib.ts/index.ts', 'export const dirLike = 1\n')
      await writeFixture(testDir, '.husky/pre-commit.sh', '#!/bin/sh\nexit 0\n')

      const result = await inspectCodebase({ dir: testDir })

      // A directory that *looks* like a source file is recursed into, not returned as a snippet.
      expect(pathsOf(result.snippets)).toEqual(['.husky/pre-commit.sh', 'lib.ts/index.ts'])
    })

    it('preserves raw text content including newlines and non-ASCII characters', async () => {
      const raw = 'export const greeting = "héllo wörld 🎉"\nconst nl = "\n"\n'
      await writeFixture(testDir, 'src/i18n.ts', raw)

      const result = await inspectCodebase({ dir: testDir })

      expect(result.snippets[0]?.content).toBe(raw)
      expect(result.snippets[0]?.truncated).toBe(false)
    })
  })

  describe('bounds: maxSnippets and skipped directories', () => {
    it('never traverses or returns node_modules, .git, dist, build, .next, coverage, .cache, __pycache__', async () => {
      for (const name of SKIPPED_DIR_NAMES) {
        await writeFixture(testDir, `${name}/inner/deep.ts`, 'export const hidden = 1')
      }
      await writeFixture(testDir, 'keep.ts', 'export const kept = 1')

      const result = await inspectCodebase({ dir: testDir, maxSnippets: 50 })

      expect(pathsOf(result.snippets)).toEqual(['keep.ts'])
      for (const snippet of result.snippets) {
        for (const name of SKIPPED_DIR_NAMES) {
          expect(snippet.path).not.toContain(`${name}/`)
          expect(snippet.path).not.toContain(`${name}.`)
        }
      }
    })

    it('stops snippet collection at maxSnippets, keeping the first sorted paths', async () => {
      // Created out of sort order so an unsorted walk cannot pass by accident.
      for (const name of ['f', 'c', 'a', 'e', 'b', 'd']) {
        await writeFixture(testDir, `${name}.ts`, `export const ${name} = 1`)
      }

      const result = await inspectCodebase({ dir: testDir, maxSnippets: 2 })

      expect(result.snippets.length).toBe(2)
      expect(pathsOf(result.snippets)).toEqual(['a.ts', 'b.ts'])
    })

    it('applies maxSnippets across directories in a single global budget', async () => {
      await writeFixture(testDir, 'tools/d.ts', 'export const d = 1')
      await writeFixture(testDir, 'src/nested/c.ts', 'export const c = 1')
      await writeFixture(testDir, 'src/b.ts', 'export const b = 1')
      await writeFixture(testDir, 'src/a.ts', 'export const a = 1')

      const result = await inspectCodebase({ dir: testDir, maxSnippets: 3 })

      expect(result.snippets.length).toBe(3)
      expect(pathsOf(result.snippets)).toEqual(['src/a.ts', 'src/b.ts', 'src/nested/c.ts'])
    })

    it('defaults maxSnippets to DEFAULT_MAX_SNIPPETS when unspecified', async () => {
      for (let i = 15; i >= 1; i--) {
        await writeFixture(testDir, `f${String(i).padStart(2, '0')}.ts`, `export const n = ${i}`)
      }

      const result = await inspectCodebase({ dir: testDir })

      expect(DEFAULT_MAX_SNIPPETS).toBe(10)
      expect(result.snippets.length).toBe(DEFAULT_MAX_SNIPPETS)
      expect(pathsOf(result.snippets)).toEqual(
        Array.from({ length: 10 }, (_, i) => `f${String(i + 1).padStart(2, '0')}.ts`)
      )
    })

    it('returns no snippets when maxSnippets is 0 but still returns manifests/configs', async () => {
      await writeFixture(testDir, 'package.json', '{}')
      await writeFixture(testDir, 'tsconfig.json', '{}')
      await writeFixture(testDir, 'a.ts', 'export const a = 1')

      const result = await inspectCodebase({ dir: testDir, maxSnippets: 0 })

      expect(result.snippets).toEqual([])
      expect(pathsOf(result.manifests)).toEqual(['package.json'])
      expect(pathsOf(result.configs)).toEqual(['tsconfig.json'])
    })

    it('falls back to defaults for non-numeric caps coming off the wire', async () => {
      const long = 'x'.repeat(200)
      await writeFixture(testDir, 'src/big.ts', long)
      await writeFixture(testDir, 'src/a2.ts', 'export const a = 1')
      await writeFixture(testDir, 'src/a3.ts', 'export const a = 1')

      const result = await inspectCodebase({
        dir: testDir,
        maxBytes: '50' as unknown as number,
        maxSnippets: '2' as unknown as number,
      })

      // '50' must not be honoured as a cap (3 files < the default of 10, so a
      // numeric 2 would have yielded 2 and a coerced 0/NaN would have yielded 0),
      // and the 200-char file must not be truncated at 50.
      expect(DEFAULT_MAX_SNIPPETS).toBe(10)
      expect(DEFAULT_MAX_BYTES).toBe(100_000)
      expect(result.snippets.length).toBe(3)
      const big = result.snippets.find((s) => s.path === 'src/big.ts')
      expect(big?.content.length).toBe(long.length)
      expect(big?.truncated).toBe(false)
    })
  })

  describe('bounds: maxBytes truncation', () => {
    it('slices content at maxBytes and flags truncated for snippets and manifests', async () => {
      const fullSnippet = 'const data = "' + 'z'.repeat(300) + '"\n'
      const fullManifest = '{"name":"pkg","filler":"' + 'y'.repeat(200) + '"}'
      await writeFixture(testDir, 'src/big.ts', fullSnippet)
      await writeFixture(testDir, 'package.json', fullManifest)

      const result = await inspectCodebase({ dir: testDir, maxBytes: 50 })

      const snippet = result.snippets.find((s) => s.path === 'src/big.ts')
      expect(snippet?.content.length).toBe(50)
      expect(snippet?.content).toBe(fullSnippet.slice(0, 50))
      expect(snippet?.truncated).toBe(true)

      const manifest = result.manifests.find((m) => m.path === 'package.json')
      expect(manifest?.content.length).toBe(50)
      expect(manifest?.content).toBe(fullManifest.slice(0, 50))
      expect(manifest?.truncated).toBe(true)
    })

    it('does not flag truncation when content length equals maxBytes exactly', async () => {
      const exact = 'a'.repeat(50)
      await writeFixture(testDir, 'src/exact.ts', exact)

      const result = await inspectCodebase({ dir: testDir, maxBytes: 50 })

      expect(result.snippets[0]?.content).toBe(exact)
      expect(result.snippets[0]?.content.length).toBe(50)
      expect(result.snippets[0]?.truncated).toBe(false)
    })

    it('flags truncation when content length exceeds maxBytes by one character', async () => {
      await writeFixture(testDir, 'src/over.ts', 'a'.repeat(51))

      const result = await inspectCodebase({ dir: testDir, maxBytes: 50 })

      expect(result.snippets[0]?.content.length).toBe(50)
      expect(result.snippets[0]?.truncated).toBe(true)
    })

    it('leaves files under the default 100k cap untruncated', async () => {
      const body = 'export const pad = "' + 'q'.repeat(5_000) + '"\n'
      await writeFixture(testDir, 'src/pad.ts', body)

      const result = await inspectCodebase({ dir: testDir })

      expect(DEFAULT_MAX_BYTES).toBe(100_000)
      expect(result.snippets[0]?.content).toBe(body)
      expect(result.snippets[0]?.truncated).toBe(false)
    })

    it('slices by UTF-16 code units for multibyte content (fs:read_file semantics)', async () => {
      const content = '🎉'.repeat(30) // 60 UTF-16 code units
      await writeFixture(testDir, 'src/emoji.ts', content)

      const result = await inspectCodebase({ dir: testDir, maxBytes: 10 })

      expect(result.snippets[0]?.content.length).toBe(10)
      expect(result.snippets[0]?.truncated).toBe(true)
    })

    it('returns empty content for an empty file without flagging truncation', async () => {
      await writeFixture(testDir, 'package.json', '')
      await writeFixture(testDir, 'src/empty.ts', '')

      const result = await inspectCodebase({ dir: testDir })

      expect(result.manifests).toEqual([{ path: 'package.json', content: '', truncated: false }])
      expect(result.snippets).toEqual([
        { path: 'src/empty.ts', language: 'typescript', content: '', truncated: false },
      ])
    })

    it('returns empty content with truncated true for non-empty files at maxBytes 0', async () => {
      await writeFixture(testDir, 'src/a.ts', 'export const a = 1')

      const result = await inspectCodebase({ dir: testDir, maxBytes: 0 })

      expect(result.snippets[0]?.content).toBe('')
      expect(result.snippets[0]?.truncated).toBe(true)
    })

    it('truncates configs as well as manifests and snippets in one call', async () => {
      await writeFixture(testDir, 'tsconfig.json', '{\n' + ' '.repeat(120) + '\n}')

      const result = await inspectCodebase({ dir: testDir, maxBytes: 10 })

      expect(result.configs.length).toBe(1)
      expect(result.configs[0]?.content.length).toBe(10)
      expect(result.configs[0]?.truncated).toBe(true)
    })
  })

  describe('determinism', () => {
    it('returns snippets in sorted depth-first order (dirs visited inline at their sorted position)', async () => {
      // Laid down in scrambled order: a sorted walk must still yield sorted DFS.
      await writeFixture(testDir, 'd/e.ts', 'export const e = 1')
      await writeFixture(testDir, 'c.ts', 'export const c = 1')
      await writeFixture(testDir, 'b/z/deep.ts', 'export const d = 1')
      await writeFixture(testDir, 'a.ts', 'export const a = 1')
      await writeFixture(testDir, 'b/nested.ts', 'export const b = 1')

      const result = await inspectCodebase({ dir: testDir })

      expect(pathsOf(result.snippets)).toEqual([
        'a.ts',
        'b/nested.ts',
        'b/z/deep.ts',
        'c.ts',
        'd/e.ts',
      ])
    })

    it('is stable across repeated invocations on the same tree', async () => {
      await writeFixture(testDir, 'src/index.ts', 'export const a = 1')
      await writeFixture(testDir, 'src/app/main.ts', 'export const b = 1')
      await writeFixture(testDir, 'src/util/format.ts', 'export const c = 1')
      await writeFixture(testDir, 'index.ts', 'export const d = 1')

      const first = await inspectCodebase({ dir: testDir })
      const second = await inspectCodebase({ dir: testDir })

      expect(pathsOf(second.snippets)).toEqual(pathsOf(first.snippets))
      expect(second).toEqual(first)
    })

    it('honours the sorted-DFS budget so maxSnippets yields the same prefix each run', async () => {
      await writeFixture(testDir, 'sub/m03.ts', 'export const n = 3')
      await writeFixture(testDir, 'm02.ts', 'export const n = 2')
      await writeFixture(testDir, 'm01.ts', 'export const n = 1')

      const a = await inspectCodebase({ dir: testDir, maxSnippets: 2 })
      const b = await inspectCodebase({ dir: testDir, maxSnippets: 2 })

      expect(pathsOf(a.snippets)).toEqual(['m01.ts', 'm02.ts'])
      expect(pathsOf(b.snippets)).toEqual(pathsOf(a.snippets))
    })
  })

  describe('dir echo and path shape', () => {
    it('echoes dir exactly as provided (not resolved), including a trailing separator', async () => {
      await writeFixture(testDir, 'package.json', '{}')
      await writeFixture(testDir, 'src/index.ts', 'export const a = 1')

      const withSlash = await inspectCodebase({ dir: `${testDir}${path.sep}` })
      const plain = await inspectCodebase({ dir: testDir })

      expect(withSlash.dir).toBe(`${testDir}${path.sep}`)
      expect(plain.dir).toBe(testDir)
      expect(pathsOf(withSlash.manifests)).toEqual(['package.json'])
      expect(pathsOf(withSlash.snippets)).toEqual(['src/index.ts'])
    })

    it('reports every path relative to dir with forward-slash separators', async () => {
      await writeFixture(testDir, 'src/a/b/c/deep.ts', 'export const deep = 1')

      const result = await inspectCodebase({ dir: testDir })

      expect(pathsOf(result.snippets)).toEqual(['src/a/b/c/deep.ts'])
      for (const snippet of result.snippets) {
        expect(snippet.path.startsWith('/')).toBe(false)
        expect(snippet.path).not.toContain('..')
      }
    })
  })

  // -------------------------------------------------------------------------
  // Tier 2 — boundary conditions and CHARACTERIZATION pins
  // -------------------------------------------------------------------------

  describe('dir values that are not a usable directory', () => {
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
      // value is path.join'ed and resolved against the daemon's cwd, so "." or
      // "src" inspects the DAEMON'S directory — including its own manifests.
      // Same posture as fs:read_file with a relative path. Reported as a
      // hardening candidate (reject non-absolute dir), not silently fixed.
      const relative = await inspectCodebase({ dir: '.' })
      const absolute = await inspectCodebase({ dir: process.cwd() })

      expect(relative.dir).toBe('.')
      expect(relative.manifests).toEqual(absolute.manifests)
      expect(pathsOf(relative.configs)).toEqual(pathsOf(absolute.configs))
      expect(pathsOf(relative.snippets)).toEqual(pathsOf(absolute.snippets))

      if (await Bun.file(path.join(process.cwd(), 'package.json')).exists()) {
        expect(pathsOf(relative.manifests)).toContain('package.json')
      }
    })

    it('treats a whitespace-only dir as a real (relative) path rather than as missing', async () => {
      // The empty-dir guard tests truthiness, so " " slips through and is joined
      // into " package.json". Asserting the exact output keeps it bounded.
      const result = await inspectCodebase({ dir: ' ' })

      expect(result.dir).toBe(' ')
      expect(result.manifests).toEqual([])
      expect(result.configs).toEqual([])
      expect(result.snippets).toEqual([])
    })

    it('accepts a non-absolute but deep dir path without throwing', async () => {
      const result = await inspectCodebase({ dir: 'no/such/dir/at/all' })

      expect(result).toEqual({ dir: 'no/such/dir/at/all', manifests: [], configs: [], snippets: [] })
    })
  })

  describe('symlinks inside the tree', () => {
    it('reads a symlinked source FILE but never descends into a symlinked directory', async () => {
      await writeFixture(testDir, 'src/real.ts', 'export const real = 1\n')
      await symlink(path.join(testDir, 'src/real.ts'), path.join(testDir, 'src/link.ts'))

      await mkdir(path.join(testDir, 'elsewhere'), { recursive: true })
      await writeFile(path.join(testDir, 'elsewhere/hidden.ts'), 'export const hidden = 1\n', 'utf8')
      await symlink(path.join(testDir, 'elsewhere'), path.join(testDir, 'src/loop'))

      const result = await inspectCodebase({ dir: testDir, maxSnippets: 50 })

      // `elsewhere` is a real directory so it is walked; the symlink `src/loop`
      // is never descended into (Dirent.isDirectory() is false for symlinks) —
      // the same posture as the fs:* walks, and it makes link cycles harmless.
      expect(pathsOf(result.snippets)).toEqual(['elsewhere/hidden.ts', 'src/link.ts', 'src/real.ts'])
      expect(pathsOf(result.snippets).some((p) => p.startsWith('src/loop/'))).toBe(false)
      // A symlinked file IS read, resolving through to its target's content.
      const link = result.snippets.find((s) => s.path === 'src/link.ts')
      expect(link?.content).toBe('export const real = 1\n')
      expect(link?.language).toBe('typescript')
    })

    it('CHARACTERIZATION: symlinked entries are read through, so a target outside dir leaks into the briefing', async () => {
      // Bun.file()/readdir-as-a-file follow symlinks, so a project that plants a
      // link can put file content from OUTSIDE the inspected directory into the
      // answer sent to the orchestrator. This is identical posture to fs:read_file
      // (which also resolves links) and is therefore reported as a hardening
      // candidate — e.g. skip entries whose realpath() escapes `dir` — rather
      // than silently changed here. Pinned so any future fix is a deliberate one.
      const repo = path.join(testDir, 'repo')
      await mkdir(repo, { recursive: true })
      await writeFile(path.join(testDir, 'outside.ts'), 'export const secret = 1\n', 'utf8')
      await writeFile(path.join(testDir, 'outside.json'), '{"stolen":true}', 'utf8')
      await symlink(path.join(testDir, 'outside.ts'), path.join(repo, 'leak.ts'))
      await symlink(path.join(testDir, 'outside.json'), path.join(repo, 'package.json'))

      const result = await inspectCodebase({ dir: repo })

      expect(result.snippets).toEqual([
        { path: 'leak.ts', language: 'typescript', content: 'export const secret = 1\n', truncated: false },
      ])
      expect(result.manifests).toEqual([
        { path: 'package.json', content: '{"stolen":true}', truncated: false },
      ])
      // The escaped content is still bounded by maxBytes, so the leak is capped.
      const bounded = await inspectCodebase({ dir: repo, maxBytes: 10 })
      expect(bounded.snippets[0]?.content).toBe('export con')
      expect(bounded.snippets[0]?.truncated).toBe(true)
    })
  })

  describe('a curated config that is also a source file', () => {
    it('CHARACTERIZATION: reports eslint.config.js in configs AND snippets', async () => {
      await writeFixture(testDir, 'eslint.config.js', 'export default []\n')

      const result = await inspectCodebase({ dir: testDir })

      // Both sections are curated views of the same tree, so one file can appear
      // twice by design (the orchestrator dedupes). Pinned, not fixed.
      expect(pathsOf(result.configs)).toEqual(['eslint.config.js'])
      expect(pathsOf(result.snippets)).toEqual(['eslint.config.js'])
      expect(result.snippets[0]?.language).toBe('javascript')
    })

    it('does not let a curated config displace the snippet budget', async () => {
      await writeFixture(testDir, 'eslint.config.js', 'export default []\n')
      await writeFixture(testDir, 'a.ts', 'export const a = 1\n')
      await writeFixture(testDir, 'b.ts', 'export const b = 1\n')

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
      expect(viaNull.snippets.length).toBeLessThanOrEqual(DEFAULT_MAX_SNIPPETS)
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

    it('applies the default 100k cap to every section in a single call', async () => {
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
      await writeFixture(testDir, 'mid/src/a.ts', 'line1\nline2\nline3\n')

      const result = await inspectCodebase({ dir: path.join(testDir, 'mid'), maxBytes: 8 })

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
      await writeFixture(testDir, 'dist/nested/deeper/bundle.ts', 'export const b = 1\n')
      await writeFixture(testDir, 'src.ts', 'export const s = 1\n')

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

    it('ignores files with no extension at all (Dockerfile, Makefile)', async () => {
      await writeFixture(testDir, 'Dockerfile', 'FROM deno\n')
      await writeFixture(testDir, 'Makefile', 'all:\n')

      const result = await inspectCodebase({ dir: testDir })

      expect(result.snippets).toEqual([])
    })
  })

  describe('exported constants', () => {
    it('MANIFEST_FILES lists the curated manifests and excludes lockfiles', async () => {
      expect(MANIFEST_FILES).toEqual(EXPECTED_MANIFEST_FILES)
      for (const lockfile of ['bun.lock', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock']) {
        expect(MANIFEST_FILES).not.toContain(lockfile)
      }
    })

    it('CONFIG_FILES lists the curated configs', async () => {
      expect(CONFIG_FILES).toEqual(EXPECTED_CONFIG_FILES)
    })

    it('curated lists are unique and root-level only', async () => {
      for (const list of [MANIFEST_FILES, CONFIG_FILES]) {
        expect(new Set(list).size).toBe(list.length)
        for (const entry of list) {
          expect(entry).not.toContain('/')
          expect(entry).not.toContain(path.sep)
          expect(entry.length).toBeGreaterThan(0)
        }
      }
    })

    it('SOURCE_EXTENSIONS contains exactly the code extensions, all resolvable in EXT_LANGUAGE', async () => {
      expect([...SOURCE_EXTENSIONS].sort()).toEqual([...SOURCE_EXT_NAMES].sort())
      for (const ext of SOURCE_EXTENSIONS) {
        expect(ext.startsWith('.')).toBe(true)
        expect(ext).toBe(ext.toLowerCase())
        expect(EXT_LANGUAGE[ext]).toBeDefined()
        expect(EXT_LANGUAGE[ext]).not.toBe('')
      }
    })

    it('SKIP_DIRS matches the fs:* skip set exactly', async () => {
      expect([...SKIP_DIRS].sort()).toEqual([...SKIPPED_DIR_NAMES].sort())
    })

    it('defaults match the review-protection posture', async () => {
      expect(DEFAULT_MAX_BYTES).toBe(100_000)
      expect(DEFAULT_MAX_SNIPPETS).toBe(10)
    })
  })
})

// ---------------------------------------------------------------------------
// Tier 3 — dispatch integration: the real `project:` branch of handleControl
// (src/cli.ts §3.2) driven over SSE against a hermetic fake orchestrator.
// ---------------------------------------------------------------------------

describe('project:inspect_codebase dispatch (real handleControl over SSE)', () => {
  const READY_TIMEOUT_MS = 25_000
  const RESPONSE_TIMEOUT_MS = 15_000
  const ALLOWED_PATHS = new Set([
    '/api/worker/heartbeat',
    '/api/worker/stream',
    '/api/worker/query-response',
  ])

  let server: any = null
  let proc: any = null
  let baseUrl = ''
  let sandboxDir = ''
  let repoDir = ''
  let sseController: ReadableStreamDefaultController<Uint8Array> | null = null
  let markSseConnected: () => void = () => {}
  const sseConnected: Promise<void> = new Promise((resolve) => { markSseConnected = resolve })

  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []
  const queryResponses: CapturedQueryResponse[] = []
  const requestPaths: string[] = []

  function stdoutText(): string {
    return stdoutChunks.join('')
  }

  function stderrText(): string {
    return stderrChunks.join('')
  }

  function diagnostics(label: string): string {
    return `--- ${label} ---\nstdout:\n${stdoutText()}\nstderr:\n${stderrText()}\nrequests:\n${requestPaths.join('\n')}`
  }

  async function drain(stream: ReadableStream<Uint8Array>, sink: string[]): Promise<void> {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      sink.push(decoder.decode(value, { stream: true }))
    }
  }

  async function waitFor(condition: () => boolean, timeoutMs: number, label: string): Promise<void> {
    const startedAt = Date.now()
    while (!condition()) {
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}.${diagnostics(label)}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }

  /** Emit one `worker_control` event on the live SSE stream, exactly as the orchestrator would. */
  function sendControl(payload: Record<string, unknown>): void {
    if (!sseController) throw new Error('SSE stream is not connected yet')
    const frame = `event: worker_control\ndata: ${JSON.stringify(payload)}\n\n`
    sseController.enqueue(new TextEncoder().encode(frame))
  }

  /** Await the next query-response captured for a specific queryId. */
  async function askAndCapture(queryId: string, payload: Record<string, unknown>): Promise<CapturedQueryResponse> {
    const before = queryResponses.length
    sendControl({ queryId, ...payload })
    await waitFor(() => queryResponses.length > before, RESPONSE_TIMEOUT_MS, `query-response for ${queryId}`)
    return queryResponses[before] as CapturedQueryResponse
  }

  function responsesFor(queryId: string): CapturedQueryResponse[] {
    return queryResponses.filter((r) => r?.queryId === queryId)
  }

  beforeAll(async () => {
    sandboxDir = await mkdtemp(path.join(tmpdir(), 'specflow-worker-project-dispatch-'))
    repoDir = path.join(sandboxDir, 'repo')
    await mkdir(path.join(repoDir, 'src'), { recursive: true })
    await writeFile(path.join(repoDir, 'package.json'), '{"name":"demo","version":"1.0.0"}', 'utf8')
    await writeFile(path.join(repoDir, 'tsconfig.json'), '{\n  "compilerOptions": {\n    "strict": true\n  }\n}\n', 'utf8')
    await writeFile(path.join(repoDir, 'src/index.ts'), 'export const greeting = "hi"\n', 'utf8')

    server = Bun.serve({
      port: 0,
      async fetch(req: Request) {
        const url = new URL(req.url)
        requestPaths.push(url.pathname)

        if (url.pathname === '/api/worker/heartbeat') {
          return Response.json({ status: 'ok', worker_id: 'wrk_project_dispatch_test' })
        }

        if (url.pathname === '/api/worker/stream') {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              sseController = controller
              markSseConnected()
            },
          })
          return new Response(stream, {
            headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
          })
        }

        if (url.pathname === '/api/worker/query-response') {
          let body: CapturedQueryResponse | null = null
          try {
            body = (await req.json()) as CapturedQueryResponse
          } catch {
            body = null
          }
          queryResponses.push(body as CapturedQueryResponse)
          return Response.json({ status: 'ok' })
        }

        return new Response('not found', { status: 404 })
      },
    })
    baseUrl = `http://127.0.0.1:${(server as any).port}`

    // HOME/SPECFLOW_DIR/cwd are redirected into the sandbox so the daemon can
    // never read or write the developer's real ~/.specflow/worker.env.
    const cliPath = path.join(import.meta.dir, '..', 'cli.ts')
    proc = Bun.spawn([process.execPath, cliPath, 'start'], {
      cwd: sandboxDir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        SPECFLOW_URL: baseUrl,
        SPECFLOW_TOKEN: 'sfw_live_dispatchtesttoken',
        SPECFLOW_DIR: sandboxDir,
        HOME: sandboxDir,
      },
    })

    const drainStdout = drain(proc.stdout as ReadableStream<Uint8Array>, stdoutChunks)
    const drainStderr = drain(proc.stderr as ReadableStream<Uint8Array>, stderrChunks)

    await waitFor(() => stdoutText().includes('[worker] registered'), READY_TIMEOUT_MS, 'daemon registration')
    await sseConnected
    await waitFor(
      () => stdoutText().includes('SSE subscription established'),
      READY_TIMEOUT_MS,
      'daemon SSE subscription',
    )

    void drainStdout
    void drainStderr
  }, READY_TIMEOUT_MS + 10_000)

  afterAll(async () => {
    if (proc) {
      try {
        proc.kill()
      } catch {}
      await Promise.race([proc.exited, new Promise((resolve) => setTimeout(resolve, 3_000))])
    }
    if (sseController) {
      try {
        sseController.close()
      } catch {}
    }
    if (server) server.stop(true)
    if (sandboxDir) await rm(sandboxDir, { recursive: true, force: true })
  })

  it('answers an inspect_codebase query with manifests, configs and snippets in ONE query-response', async () => {
    const captured = await askAndCapture('q_inspect_basic', {
      action: 'project:inspect_codebase',
      dir: repoDir,
    })

    expect(captured.queryId).toBe('q_inspect_basic')
    expect(captured.error ?? null).toBeFalsy()

    const result = captured.result as any
    expect(result).toBeObject()
    expect(result.dir).toBe(repoDir)

    // Spec §6.4 — the three sections, each with relative paths and raw content.
    expect(result.manifests).toEqual([
      { path: 'package.json', content: '{"name":"demo","version":"1.0.0"}', truncated: false },
    ])
    expect(result.configs).toEqual([
      {
        path: 'tsconfig.json',
        content: '{\n  "compilerOptions": {\n    "strict": true\n  }\n}\n',
        truncated: false,
      },
    ])
    expect(result.snippets).toEqual([
      {
        path: 'src/index.ts',
        language: 'typescript',
        content: 'export const greeting = "hi"\n',
        truncated: false,
      },
    ])

    // Exactly one round trip — one POST per queryId, no partial/streamed answers.
    expect(responsesFor('q_inspect_basic').length).toBe(1)
  }, RESPONSE_TIMEOUT_MS + 5_000)

  it('forwards maxBytes and maxSnippets from the wire through to the result bounds', async () => {
    const captured = await askAndCapture('q_inspect_bounds', {
      action: 'project:inspect_codebase',
      dir: repoDir,
      maxBytes: 12,
      maxSnippets: 1,
    })

    const result = captured.result as any
    expect(result).toBeObject()

    for (const file of [
      ...(result.manifests as any[]),
      ...(result.configs as any[]),
      ...(result.snippets as any[]),
    ]) {
      expect(file.content.length).toBeLessThanOrEqual(12)
      expect(file.truncated).toBeTrue()
    }
    expect(result.snippets.length).toBe(1)
    expect(result.snippets[0].path).toBe('src/index.ts')
  }, RESPONSE_TIMEOUT_MS + 5_000)

  it('answers an unknown project:* action instead of hanging', async () => {
    const captured = await askAndCapture('q_unknown', {
      action: 'project:bogus',
      dir: repoDir,
    })

    expect(captured.queryId).toBe('q_unknown')
    expect(captured.result).toBeNull()
    expect(captured.error).toBe('Unknown project action: project:bogus')
    expect(responsesFor('q_unknown').length).toBe(1)
  }, RESPONSE_TIMEOUT_MS + 5_000)

  it('silently drops a project: action with no queryId, without blocking the stream', async () => {
    const before = queryResponses.length

    // No queryId: the guard must return without answering...
    sendControl({ action: 'project:inspect_codebase', dir: repoDir })
    // ...so this sentinel on the same live stream must be the ONLY new response.
    const sentinel = await askAndCapture('q_sentinel_after_drop', {
      action: 'project:inspect_codebase',
      dir: repoDir,
    })

    expect(sentinel.queryId).toBe('q_sentinel_after_drop')
    const newOnes = queryResponses.slice(before)
    expect(newOnes.length).toBe(1)
    expect(newOnes.every((r) => r?.queryId === 'q_sentinel_after_drop')).toBeTrue()
    expect(queryResponses.some((r) => r && r.queryId === undefined)).toBeFalse()
  }, RESPONSE_TIMEOUT_MS + 5_000)

  it('reads a real non-git directory without any git command or provider run', async () => {
    // repoDir is a plain temp directory: not a git repo, no provider configured.
    const captured = await askAndCapture('q_no_side_effects', {
      action: 'project:inspect_codebase',
      dir: repoDir,
    })
    expect((captured.result as any).manifests.length).toBe(1)

    // Only the three protocol endpoints were ever contacted — in particular no
    // /api/worker/tasks/* run or event ingestion calls.
    const unexpected = requestPaths.filter((p) => !ALLOWED_PATHS.has(p))
    expect(unexpected).toEqual([])

    // A task execution would log [runner]/run_task lines; an inspection must not.
    const logs = stdoutText() + stderrText()
    expect(logs.includes('[runner]')).toBeFalse()
    expect(logs.includes('run_task')).toBeFalse()
    expect(logs.includes('chat_step')).toBeFalse()
  }, RESPONSE_TIMEOUT_MS + 5_000)

  it('reports the contract failure shape for an unknown action and keeps answering later queries', async () => {
    const bogus = await askAndCapture('q_bogus_two', { action: 'project:nope', dir: repoDir })
    expect(bogus.error).toBe('Unknown project action: project:nope')

    // The namespace branch must not swallow the stream: a follow-up still works.
    const followUp = await askAndCapture('q_follow_up', { action: 'project:inspect_codebase', dir: repoDir })
    expect((followUp.result as any).snippets[0].language).toBe('typescript')
  }, (RESPONSE_TIMEOUT_MS + 5_000) * 2)

  it('returns empty sections for a nonexistent dir over the wire, as a success (not an error)', async () => {
    const captured = await askAndCapture('q_missing_dir', {
      action: 'project:inspect_codebase',
      dir: path.join(sandboxDir, 'does-not-exist'),
    })

    expect(captured.error ?? null).toBeFalsy()
    expect(captured.result).toEqual({
      dir: path.join(sandboxDir, 'does-not-exist'),
      manifests: [],
      configs: [],
      snippets: [],
    })
  }, RESPONSE_TIMEOUT_MS + 5_000)
})
