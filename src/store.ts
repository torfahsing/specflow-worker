/**
 * Persistence seam for the worker daemon.
 *
 * Mirrors the adapter-interface layering of
 * specflow/packages/orchestrator/src/storage/interface.ts
 * (pure interface, no implementation import) with the
 * implementation co-located in this file.
 *
 * `MemoryWorkerStore` is production-importable (not test-only) so
 * `bun test` can exercise the runner without a live PocketBase.
 *
 * `PocketBaseStore` is the only module in the daemon allowed to
 * call `pb.collection('runs' | 'run_events' | 'tasks')`.
 * `presence.ts` / `queue.ts` keep their own transport-level
 * `local_workers` / `tasks` access so task updates are never
 * implemented twice (A14).
 */

import type PocketBase from 'pocketbase'

// ---------------------------------------------------------------------------
// Types (single source of truth for run_event.type select values)
// ---------------------------------------------------------------------------

export type RunEventType =
  | 'text'
  | 'reasoning'
  | 'tool_call'
  | 'tool_result'
  | 'error'

/**
 * Single source of truth for `run_events.type` select values.
 * Must match `pb_migrations/1800000002_runs_run_events.js` exactly.
 */
export const RUN_EVENT_TYPES: ReadonlySet<string> = new Set([
  'text',
  'reasoning',
  'tool_call',
  'tool_result',
  'error',
])

export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled'

export interface RunRecord {
  status?: RunStatus
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
  error?: string
}

// ---------------------------------------------------------------------------
// WorkerStore interface (mirrors storage/interface.ts shape)
// ---------------------------------------------------------------------------

export interface WorkerStore {
  createRun(input: { taskId: string; featureId: string }): Promise<string>
  updateRun(runId: string, patch: Partial<RunRecord>): Promise<void>
  emitRunEvent(
    runId: string,
    sequence: number,
    type: RunEventType,
    payload: unknown,
  ): Promise<void>
  updateTask(taskId: string, patch: Record<string, unknown>): Promise<void>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip `undefined` values from a patch object before sending to
 * PocketBase.  PB rejects `undefined` JSON values.
 */
function stripUndefined(
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      result[key] = value
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// PocketBaseStore
// ---------------------------------------------------------------------------

export class PocketBaseStore implements WorkerStore {
  constructor(private pb: PocketBase) {}

  async createRun(input: { taskId: string; featureId: string }): Promise<string> {
    try {
      const record = await this.pb.collection('runs').create({
        task: input.taskId,
        feature: input.featureId,
        status: 'running',
      })
      return record.id
    } catch (err) {
      console.warn('[pb] createRun notice:', (err as Error).message)
      return ''
    }
  }

  async updateRun(runId: string, patch: Partial<RunRecord>): Promise<void> {
    try {
      const data = stripUndefined(patch as Record<string, unknown>)
      if (Object.keys(data).length === 0) return
      await this.pb.collection('runs').update(runId, data)
    } catch (err) {
      console.warn('[pb] updateRun notice:', (err as Error).message)
    }
  }

  async emitRunEvent(
    runId: string,
    sequence: number,
    type: RunEventType,
    payload: unknown,
  ): Promise<void> {
    if (!RUN_EVENT_TYPES.has(type)) {
      console.warn(`[pb] skipping unsupported run_event type "${type}"`)
      return
    }
    try {
      await this.pb.collection('run_events').create({
        run: runId,
        sequence,
        type,
        payload,
      })
    } catch (err) {
      console.warn('[pb] emitRunEvent notice:', (err as Error).message)
    }
  }

  async updateTask(
    taskId: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    const data = stripUndefined(patch)
    try {
      await this.pb.collection('tasks').update(taskId, data)
    } catch (err) {
      // Retry once before surfacing (spec: "retry once before surfacing").
      try {
        await new Promise((resolve) => setTimeout(resolve, 250))
        await this.pb.collection('tasks').update(taskId, data)
      } catch (retryErr) {
        throw new Error(
          `[pb] failed to update task "${taskId}": ${(retryErr as Error).message}`,
        )
      }
    }
  }
}

// ---------------------------------------------------------------------------
// MemoryWorkerStore (production-importable, no network)
// ---------------------------------------------------------------------------

export interface MemoryRunRecord {
  id: string
  taskId: string
  featureId: string
  status: RunStatus
  inputTokens: number | undefined
  outputTokens: number | undefined
  costUsd: number | undefined
  error: string | undefined
}

export interface MemoryRunEvent {
  runId: string
  sequence: number
  type: RunEventType
  payload: unknown
}

export interface MemoryTaskPatch {
  taskId: string
  patch: Record<string, unknown>
}

export class MemoryWorkerStore implements WorkerStore {
  runs = new Map<string, MemoryRunRecord>()
  events: MemoryRunEvent[] = []
  taskPatches: MemoryTaskPatch[] = []
  private idCounter = 0

  async createRun(input: { taskId: string; featureId: string }): Promise<string> {
    const id = `run_${++this.idCounter}`
    this.runs.set(id, {
      id,
      taskId: input.taskId,
      featureId: input.featureId,
      status: 'running',
      inputTokens: undefined,
      outputTokens: undefined,
      costUsd: undefined,
      error: undefined,
    })
    return id
  }

  async updateRun(runId: string, patch: Partial<RunRecord>): Promise<void> {
    const run = this.runs.get(runId)
    if (!run) return
    if (patch.status !== undefined) run.status = patch.status
    // Support both camelCase (RunRecord interface) and snake_case
    // (PocketBase field naming convention) so tests and the runner
    // can use either without a conversion layer.
    if (patch.inputTokens !== undefined) run.inputTokens = patch.inputTokens
    if ('input_tokens' in patch && patch.input_tokens !== undefined) run.inputTokens = patch.input_tokens as number
    if (patch.outputTokens !== undefined) run.outputTokens = patch.outputTokens
    if ('output_tokens' in patch && patch.output_tokens !== undefined) run.outputTokens = patch.output_tokens as number
    if (patch.costUsd !== undefined) run.costUsd = patch.costUsd
    if ('cost_usd' in patch && patch.cost_usd !== undefined) run.costUsd = patch.cost_usd as number
    if (patch.error !== undefined) run.error = patch.error
  }

  async emitRunEvent(
    runId: string,
    sequence: number,
    type: RunEventType,
    payload: unknown,
  ): Promise<void> {
    this.events.push({ runId, sequence, type, payload })
  }

  async updateTask(taskId: string, patch: Record<string, unknown>): Promise<void> {
    this.taskPatches.push({ taskId, patch })
  }
}
