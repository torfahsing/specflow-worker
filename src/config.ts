/**
 * Configuration resolution for the worker daemon.
 *
 * Loads ~/.specflow/worker.env (KEY=VALUE, no dotenv dependency — Bun
 * auto-loads cwd .env). Precedence: process env wins; worker.env fills
 * gaps. All public functions are pure or injectable so they are
 * unit-testable without touching the real filesystem or process env.
 */

import { homedir, hostname } from 'node:os'
import path from 'node:path'

export interface WorkerConfig {
  specflowUrl: string
  specflowToken?: string
  workerName: string
  pathOverride?: string
  envValues: Record<string, string>
  workerEnvPath: string
  concurrency?: number
  providerCommand?: string
}

const DEFAULT_SPECFLOW_URL = 'http://127.0.0.1:3200'
export const DEFAULT_WORKER_CONCURRENCY = 4

/**
 * Parse a raw `KEY=VALUE` text block into a flat record.
 *
 * Rules:
 *  - Blank lines and `#` comments are skipped.
 *  - A leading `export ` is tolerated (shell-style).
 *  - The line is split at the first `=` only.
 *  - Both key and value are trimmed.
 *  - If the value is wrapped in a matched pair of `"` or `'`, the
 *    outer quotes are stripped (only one level).
 *  - Lines without `=` are ignored.
 */
export function parseEnv(text: string): Record<string, string> {
  const result: Record<string, string> = {}

  for (const raw of text.split('\n')) {
    let line = raw.trim()

    // skip blanks and comments
    if (line === '' || line.startsWith('#')) continue

    // tolerate a leading `export `
    if (line.startsWith('export ')) line = line.slice(7).trim()

    const eqIndex = line.indexOf('=')
    if (eqIndex === -1) continue

    const key = line.slice(0, eqIndex).trim()
    let value = line.slice(eqIndex + 1).trim()

    // strip one matched pair of surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1)
    }

    if (key !== '') {
      result[key] = value
    }
  }

  return result
}

/**
 * Merge process env and parsed worker.env into a WorkerConfig.
 *
 * Precedence: `env[K] !== undefined` wins. `pathOverride` comes from
 * `file.PATH` ONLY, never from `env.PATH`.
 */
export function resolveConfig(
  env: NodeJS.ProcessEnv,
  file: Record<string, string>,
): WorkerConfig {
  const specflowUrl =
    env.SPECFLOW_URL ??
    file.SPECFLOW_URL ??
    DEFAULT_SPECFLOW_URL

  const specflowToken =
    env.SPECFLOW_TOKEN ??
    file.SPECFLOW_TOKEN

  const workerName = env.WORKER_NAME ?? file.WORKER_NAME ?? hostname()
  const pathOverride = file.PATH

  // envValues are the raw worker.env pairs that will be forwarded into
  // spawned provider processes (PATH override is handled separately above).
  const envValues: Record<string, string> = { ...file }
  if (pathOverride !== undefined) {
    envValues.PATH = pathOverride
  }

  const rawConcurrency = env.SPECFLOW_WORKER_CONCURRENCY ?? file.SPECFLOW_WORKER_CONCURRENCY
  const parsedConcurrency = rawConcurrency ? parseInt(rawConcurrency, 10) : undefined
  const concurrency = parsedConcurrency && !isNaN(parsedConcurrency) && parsedConcurrency > 0 ? parsedConcurrency : DEFAULT_WORKER_CONCURRENCY

  return {
    specflowUrl,
    specflowToken,
    workerName,
    pathOverride,
    envValues,
    workerEnvPath: '', // filled by loadConfig
    concurrency,
  }
}

/**
 * Load configuration from the environment and an optional worker.env file.
 *
 * The worker.env path defaults to `~/.specflow/worker.env` (or
 * `$SPECFLOW_DIR/.specflow/worker.env` when `SPECFLOW_DIR` is set).
 * The file is read via `Bun.file`; if it does not exist, an empty
 * record is used (no error). The function never writes the file.
 */
export async function loadConfig(overrides?: {
  env?: NodeJS.ProcessEnv
  workerEnvPath?: string
}): Promise<WorkerConfig> {
  const env = overrides?.env ?? process.env
  const baseDir = env.SPECFLOW_DIR ?? homedir()
  const workerEnvPath =
    overrides?.workerEnvPath ?? path.join(baseDir, '.specflow', 'worker.env')

  let fileValues: Record<string, string> = {}
  try {
    const f = Bun.file(workerEnvPath)
    if (await f.exists()) {
      fileValues = parseEnv(await f.text())
    }
  } catch {
    // missing or unreadable → empty file values
  }

  const config = resolveConfig(env, fileValues)
  return { ...config, workerEnvPath }
}

/**
 * Save worker configuration to worker.env.
 * Creates parent directory if missing and preserves non-overridden variables.
 */
export async function saveWorkerEnv(
  values: {
    specflowUrl?: string
    specflowToken?: string
    workerName?: string
  },
  workerEnvPath?: string,
): Promise<string> {
  const targetPath =
    workerEnvPath ??
    path.join(process.env.SPECFLOW_DIR ?? homedir(), '.specflow', 'worker.env')
  const targetDir = path.dirname(targetPath)

  const { mkdir } = await import('node:fs/promises')
  await mkdir(targetDir, { recursive: true })

  let existing: Record<string, string> = {}
  try {
    const f = Bun.file(targetPath)
    if (await f.exists()) {
      existing = parseEnv(await f.text())
    }
  } catch {
    // empty if file does not exist
  }

  if (values.specflowUrl) existing.SPECFLOW_URL = values.specflowUrl
  if (values.specflowToken) existing.SPECFLOW_TOKEN = values.specflowToken
  if (values.workerName) existing.WORKER_NAME = values.workerName

  const lines: string[] = [
    '# Specflow Worker Configuration',
    `# Updated: ${new Date().toISOString()}`,
    '',
  ]
  for (const [k, v] of Object.entries(existing)) {
    lines.push(`${k}=${v}`)
  }
  lines.push('')

  await Bun.write(targetPath, lines.join('\n'))
  return targetPath
}
