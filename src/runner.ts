/**
 * Task execution orchestration — claim → inputs → branch alignment →
 * spawn → stream → finalize matrix.
 *
 * Mirrors the execution loop of specflow/packages/orchestrator/src/workflow/runner.ts
 * (reduced: no retry, no model fallback, no verification gate, no commits).
 *
 * All dependencies are injectable so `bun test` can exercise the runner
 * with a stubbed provider and stubbed git module — no live PocketBase
 * or real subprocess is required.
 *
 * `provider` and `git` are dependency-injectable (dep-wired) so the runner
 * is testable without spawning (used for the fast assertion tests) AND
 * exercised for real in the e2e tests.
 *
 * Zero provider/model literals in this file (gate #3).
 */

import type { WorkerStore, RunEventType, RunStatus } from './store.js'
import type { Presence } from './presence.js'
import type { WorkerConfig } from './config.js'
import type { ClaimedTask } from './queue.js'
import type { ProviderRunResult, ProviderStream, ProviderEvent } from './providers/cli.js'
import { RunRecorder } from './events.js'
import type { getCurrentBranch, branchExists, createBranch, checkoutBranch } from './git/utils.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunDeps {
  store: WorkerStore
  presence: Presence
  config: WorkerConfig
  git?: typeof import('./git/utils.js')
  provider?: typeof import('./providers/cli.js').runProvider
}

export interface ExecutionOutcome {
  status: 'done' | 'failed' | 'cancelled'
  runId: string
  error?: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Coerce `allowed_tools` from the task record into a string array.
 *
 * Accepts either a real array or a JSON string (the same tolerant
 * coercion as `service.ts:1152-1163`).
 */
function coerceArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string')
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      const parsed = JSON.parse(value)
      if (Array.isArray(parsed)) return parsed.filter((v) => typeof v === 'string')
    } catch {
      // not valid JSON — treat as empty
    }
  }
  return []
}

// ---------------------------------------------------------------------------
// executeClaimedTask
// ---------------------------------------------------------------------------

/**
 * Execute a single claimed task end-to-end.
 *
 * Ordered steps (spec §2.3):
 *   1. RunRecorder.start + presence.setBusy(true)
 *   2. Resolve inputs from the record + expanded feature
 *   3. Pre-run input failures → failed finalize + release presence
 *   4. Branch alignment (port of providers/cli.ts lines 201-213)
 *   5. Spawn provider with AbortController linked to shutdown signal
 *   6. Stream stdout NDJSON → run_events via recorder.emit
 *   7. Terminal error event (after streaming)
 *   8. Finalize (runs → tasks order)
 *   9. finally: presence.setBusy(false) + removeEventListener
 */
export async function executeClaimedTask(
  claimed: ClaimedTask,
  deps: RunDeps,
  signal: AbortSignal,
): Promise<ExecutionOutcome> {
  const { store, presence, config, git, provider } = deps
  const gitModule = git ?? await import('./git/utils.js')
  const runProviderFn = provider ?? (await import('./providers/cli.js')).runProvider

  const taskId = claimed.id
  const featureId = claimed.featureId
  const record = claimed.record
  const feature = record.expand?.feature ?? {}

  // Step 1: start the run recorder + set presence busy
  const recorder = await RunRecorder.start(store, { taskId, featureId })
  presence.setBusy(true)

  // Step 2: resolve execution inputs
  const prompt = record.prompt as string | undefined
  const command = record.provider_command as string | undefined
  const model = record.model as string | undefined
  const allowedTools = coerceArray(record.allowed_tools)
  const timeoutMs = normalizeTimeout(record.timeout)
  const cwd = feature.project_dir as string | undefined
  const branch = feature.git_branch as string | undefined

  // Step 3: pre-run input failures
  if (!prompt) {
    const error = `Task "${taskId}" has no "prompt" — prompt assembly happens upstream before queueing.`
    await recorder.finalize({ status: 'failed', error })
    await store.updateTask(taskId, { status: 'failed', error })
    presence.setBusy(false)
    return { status: 'failed', runId: recorder.runId, error }
  }

  if (!command) {
    const error = `Task "${taskId}" has no "provider_command".`
    await recorder.finalize({ status: 'failed', error })
    await store.updateTask(taskId, { status: 'failed', error })
    presence.setBusy(false)
    return { status: 'failed', runId: recorder.runId, error }
  }

  if (!cwd) {
    const error = `Feature "${featureId}" has no "project_dir".`
    await recorder.finalize({ status: 'failed', error })
    await store.updateTask(taskId, { status: 'failed', error })
    presence.setBusy(false)
    return { status: 'failed', runId: recorder.runId, error }
  }

  // Step 4: branch alignment (verbatim port of providers/cli.ts:201-213)
  if (branch) {
    try {
      const current = await gitModule.getCurrentBranch(cwd)
      if (current !== branch) {
        if (!(await gitModule.branchExists(cwd, branch))) {
          console.log(`[git] creating missing branch '${branch}'`)
          await gitModule.createBranch(cwd, branch)
        }
        console.log(`[git] switching to branch '${branch}' (was '${current}')`)
        await gitModule.checkoutBranch(cwd, branch)
      }
    } catch (err) {
      const msg = (err as Error).message
      const error = `Failed to align branch '${branch}' in '${cwd}': ${msg}`
      await recorder.finalize({ status: 'failed', error })
      await store.updateTask(taskId, { status: 'failed', error })
      presence.setBusy(false)
      return { status: 'failed', runId: recorder.runId, error }
    }
  } else {
    console.log(`[git] skipping branch alignment (no branch specified)`)
  }

  // Step 5: spawn with AbortController linked to shutdown signal
  const controller = new AbortController()
  const abortListener = () => controller.abort()
  signal.addEventListener('abort', abortListener, { once: true })

  let result: ProviderRunResult
  let cancelled = false

  try {
    console.log(
      `[runner] executeClaimedTask: task=${taskId} feature=${featureId} cwd=${cwd} branch=${branch ?? 'none'} provider=${command} model=${model ?? 'none'} timeout=${timeoutMs / 1000}s`,
    )

    result = await runProviderFn(
      {
        command,
        model,
        allowedTools,
        prompt,
        cwd,
        timeoutMs,
        signal: controller.signal,
        pathOverride: config.pathOverride,
        extraEnv: config.envValues,
      },
      async (e: ProviderEvent) => {
        await recorder.emit(e.type, e.payload)
      },
    )
  } catch (err) {
    const error = (err as Error).message
    await recorder.finalize({ status: 'failed', error })
    await store.updateTask(taskId, { status: 'failed', error })
    presence.setBusy(false)
    signal.removeEventListener('abort', abortListener)
    return { status: 'failed', runId: recorder.runId, error }
  }

  // Step 6: classification determines outcome
  // cancelled: signal aborted but NOT a timeout
  cancelled = result.cancelled

  if (cancelled) {
    // Step 7: terminal error event for cancellation
    await recorder.emitTerminalError({
      message: 'Aborted',
      exit_code: result.exitCode,
      signal: result.signalCode,
    })

    // Step 8: finalize — cancelled matrix
    await recorder.finalize({ status: 'cancelled' })
    await store.updateTask(taskId, {
      status: 'queued',
      assigned_worker: null,
    })
    presence.setBusy(false)
    signal.removeEventListener('abort', abortListener)
    return { status: 'cancelled', runId: recorder.runId }
  }

  // Step 7: terminal error event for non-cancellation failures
  if (result.error) {
    await recorder.emitTerminalError({
      message: result.error,
      exit_code: result.exitCode,
      signal: result.signalCode,
    })
  }

  // Step 8: finalize matrix (single place, runs → tasks order)
  if (result.error) {
    // Any error path → failed
    await recorder.finalize({ status: 'failed', error: result.error })
    await store.updateTask(taskId, { status: 'failed', error: result.error })
    presence.setBusy(false)
    signal.removeEventListener('abort', abortListener)
    return { status: 'failed', runId: recorder.runId, error: result.error }
  }

  // Clean success path
  const tokens = result.stream.tokens
  const costUsd = result.stream.cost

  await recorder.finalize({
    status: 'completed',
    tokens: tokens
      ? { input: tokens.input, output: tokens.output }
      : undefined,
    costUsd: typeof costUsd === 'number' ? costUsd : undefined,
  })

  await store.updateTask(taskId, { status: 'done' })
  presence.setBusy(false)
  signal.removeEventListener('abort', abortListener)

  return { status: 'done', runId: recorder.runId }
}

/**
 * Normalise a raw timeout value to milliseconds.
 * Mirrors normalizeTimeout from providers/cli.ts so the runner
 * does not need to import it directly (keeps the dependency graph clean).
 */
function normalizeTimeout(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return 1_800_000
  const n = typeof raw === 'string' ? Number(raw) : (raw as number)
  if (Number.isNaN(n) || n === 0) return 1_800_000
  return n < 10_000 ? n * 1_000 : n
}
