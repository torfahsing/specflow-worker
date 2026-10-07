/**
 * Tests for src/project.ts — the `project:inspect_codebase` control action.
 *
 * Scaffolding mirrors src/__tests__/git-utils.test.ts (mkdtemp per test,
 * recursive-force cleanup). Hermetic by construction: every fixture lives
 * inside the mkdtemp dir, no network, no git commands, no provider spawning.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
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

/** True when mode bits cannot make a file unreadable (root bypasses permissions). */
function runningAsRoot(): boolean {
  return typeof process.getuid === 'function' && process.getuid() === 0
}

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
