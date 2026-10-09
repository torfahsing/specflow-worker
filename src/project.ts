/**
 * Codebase Inspection for Specflow Worker Daemon.
 *
 * Implements the `project:inspect_codebase` control-plane query action:
 * answers the cloud orchestrator in one round trip with a bounded
 * "codebase briefing" — curated root-level manifests, configs, and a
 * deterministic sample of source snippets. Read-only: no writes, no git
 * commands, no provider spawning, no run/event recording.
 */

import path from 'node:path'
import { readdir } from 'node:fs/promises'
import { EXT_LANGUAGE } from './git/utils.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InspectedFile {
  path: string
  content: string
  truncated: boolean
}

export interface InspectedSnippet extends InspectedFile {
  language: string
}

export interface InspectCodebaseResult {
  dir: string
  manifests: InspectedFile[]
  configs: InspectedFile[]
  snippets: InspectedSnippet[]
}

export interface InspectCodebaseInput {
  dir: string
  maxBytes?: number
  maxSnippets?: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Curated root-level dependency/project declaration files.
 * Lockfiles (bun.lock, package-lock.json) are deliberately excluded —
 * derivable and potentially huge.
 */
export const MANIFEST_FILES: string[] = [
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'requirements.txt',
  'Gemfile',
  'composer.json',
  'pom.xml',
  'build.gradle',
  'mix.exs',
  'pubspec.yaml',
  'deno.json',
]

/** Curated root-level tooling/config files. */
export const CONFIG_FILES: string[] = [
  'tsconfig.json',
  '.gitignore',
  '.dockerignore',
  '.env.example',
  '.editorconfig',
  '.prettierrc',
  '.prettierrc.json',
  'eslint.config.js',
  'eslint.config.mjs',
  'biome.json',
  'biome.jsonc',
  'turbo.json',
]

/** Snippet-capable source extensions — every entry is a key of EXT_LANGUAGE so a language always resolves. */
export const SOURCE_EXTENSIONS: Set<string> = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.rb', '.java', '.sh', '.sql',
])

export const DEFAULT_MAX_BYTES = 100_000
export const DEFAULT_MAX_SNIPPETS = 10

/** Same skip set as the inline SKIP sets in the fs:* control actions (src/cli.ts). */
export const SKIP_DIRS: Set<string> = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.cache', '__pycache__',
])

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read one file relative to `root`, sliced to at most `maxBytes` characters
 * (string-length semantics, identical to fs:read_file). Returns null on
 * missing/unreadable files — inspection never throws for missing files,
 * mirroring the fs: walk's `.catch(() => [])` posture.
 */
async function readFileIfExists(root: string, relPath: string, maxBytes: number): Promise<InspectedFile | null> {
  try {
    const file = Bun.file(path.join(root, relPath))
    if (!(await file.exists())) return null
    let content = await file.text()
    let truncated = false
    if (content.length > maxBytes) {
      content = content.slice(0, maxBytes)
      truncated = true
    }
    return { path: relPath, content, truncated }
  } catch {
    return null
  }
}

/**
 * Collect up to `maxSnippets` source-file paths from `root`, walking the tree
 * like the fs:find_files action (same SKIP set, same early-return cap, same
 * silent per-directory catch) with two deltas: entries are sorted with
 * `localeCompare` before visiting (determinism, matching fs:get_tree) and only
 * files with a SOURCE_EXTENSIONS extension are kept.
 */
async function collectSnippetPaths(root: string, maxSnippets: number): Promise<string[]> {
  const paths: string[] = []

  const walk = async (currentDir: string, relative: string) => {
    if (paths.length >= maxSnippets) return
    try {
      const entries = await readdir(currentDir, { withFileTypes: true }).catch(() => [])
      entries.sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of entries) {
        if (SKIP_DIRS.has(entry.name)) continue
        const relPath = relative ? `${relative}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          await walk(path.join(currentDir, entry.name), relPath)
          if (paths.length >= maxSnippets) return
        } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
          paths.push(relPath)
          if (paths.length >= maxSnippets) return
        }
      }
    } catch {}
  }

  await walk(root, '')
  return paths
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Inspect a local codebase on behalf of the cloud orchestrator: curated
 * root-level manifests, configs, and a bounded sample of source snippets —
 * in one round trip. Missing/empty dir and missing files yield empty arrays,
 * never a thrown error.
 */
export async function inspectCodebase(input: InspectCodebaseInput): Promise<InspectCodebaseResult> {
  const dir = input.dir || ''
  if (!dir) {
    return { dir, manifests: [], configs: [], snippets: [] }
  }

  const maxBytes = typeof input.maxBytes === 'number' ? input.maxBytes : DEFAULT_MAX_BYTES
  const maxSnippets = typeof input.maxSnippets === 'number' ? input.maxSnippets : DEFAULT_MAX_SNIPPETS

  const manifestResults = await Promise.all(MANIFEST_FILES.map((f) => readFileIfExists(dir, f, maxBytes)))
  const manifests = manifestResults.filter((x): x is InspectedFile => x !== null)

  const configResults = await Promise.all(CONFIG_FILES.map((f) => readFileIfExists(dir, f, maxBytes)))
  const configs = configResults.filter((x): x is InspectedFile => x !== null)

  const snippetPaths = await collectSnippetPaths(dir, maxSnippets)
  const snippetFiles = await Promise.all(snippetPaths.map((p) => readFileIfExists(dir, p, maxBytes)))
  const snippets = snippetFiles
    .filter((x): x is InspectedFile => x !== null)
    .map((f): InspectedSnippet => {
      const ext = path.extname(f.path).toLowerCase()
      return { ...f, language: EXT_LANGUAGE[ext] || 'plaintext' }
    })

  return { dir, manifests, configs, snippets }
}

export interface RunVerificationInput {
  dir: string
  command?: string
  timeoutMs?: number
}

export interface RunVerificationResult {
  passed: boolean
  command: string
  exitCode: number
  output: string
}

/**
 * Deterministically run build/test verification for a project directory.
 * If command is not specified, autodetects from package.json scripts (test, build).
 */
export async function runVerification(input: RunVerificationInput): Promise<RunVerificationResult> {
  const dir = input.dir || ''
  if (!dir) {
    return { passed: false, command: '', exitCode: 1, output: 'No project directory provided' }
  }

  let command = input.command?.trim()
  if (!command) {
    // Autodetect from package.json
    try {
      const pkgJsonPath = path.join(dir, 'package.json')
      const file = Bun.file(pkgJsonPath)
      if (await file.exists()) {
        const pkg = await file.json()
        const scripts = pkg.scripts || {}
        const parts: string[] = []
        if (scripts.build) parts.push('npm run build')
        if (scripts.test) parts.push('npm test')
        if (parts.length > 0) {
          command = parts.join(' && ')
        }
      }
    } catch {}
  }

  // If still no command detected, look for Makefile or Cargo.toml or pyproject.toml
  if (!command) {
    try {
      if (await Bun.file(path.join(dir, 'Cargo.toml')).exists()) {
        command = 'cargo test'
      } else if (await Bun.file(path.join(dir, 'Makefile')).exists()) {
        command = 'make test'
      } else if (await Bun.file(path.join(dir, 'pyproject.toml')).exists()) {
        command = 'pytest'
      }
    } catch {}
  }

  if (!command) {
    // No verification command discovered — pass automatically
    return { passed: true, command: 'none', exitCode: 0, output: 'No test/build script found to verify' }
  }

  try {
    const timeout = input.timeoutMs || 180_000 // 3 minutes timeout default
    const proc = Bun.spawn(['sh', '-c', command], {
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, CI: '1', NODE_ENV: 'test' },
    })

    const timeoutPromise = new Promise<{ passed: boolean; command: string; exitCode: number; output: string }>((resolve) => {
      setTimeout(() => {
        try { proc.kill() } catch {}
        resolve({
          passed: false,
          command: command!,
          exitCode: 124,
          output: `Verification command timed out after ${Math.round(timeout / 1000)}s: ${command}`,
        })
      }, timeout)
    })

    const execPromise = (async () => {
      const [stdoutText, stderrText] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      const exitCode = await proc.exited
      const combined = [stdoutText, stderrText].filter(Boolean).join('\n').trim()
      // Cap output size to avoid memory explosion (e.g. 50k chars)
      const output = combined.length > 50_000
        ? combined.slice(0, 10_000) + '\n\n...[truncated]...\n\n' + combined.slice(-40_000)
        : combined

      return {
        passed: exitCode === 0,
        command: command!,
        exitCode,
        output,
      }
    })()

    return await Promise.race([execPromise, timeoutPromise])
  } catch (err: any) {
    return {
      passed: false,
      command: command || '',
      exitCode: 1,
      output: `Failed to execute verification: ${err?.message || String(err)}`,
    }
  }
}
