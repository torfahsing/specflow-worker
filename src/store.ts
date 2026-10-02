/**
 * Persistence seam for the worker daemon.
 *
 * Implements WorkerStore interface backed by Specflow HTTP API via SpecflowClient
 * (HttpWorkerStore) or in-memory (MemoryWorkerStore) for offline unit testing.
 *
 * The worker daemon has zero direct database coupling: all state synchronization
 * occurs over HTTP/SSE with the Specflow orchestrator.
 */

import type { SpecflowClient } from './client.js'

// ---------------------------------------------------------------------------
// Types (single source of truth for run event types)
// ---------------------------------------------------------------------------

export type RunEventType =
  | 'text'
  | 'reasoning'
  | 'tool_call'
  | 'tool_result'
  | 'error'

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
// WorkerStore interface
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
// HttpWorkerStore (Specflow API HTTP/SSE)
// ---------------------------------------------------------------------------

export class HttpWorkerStore implements WorkerStore {
  private activeTaskId = ''

  constructor(private client: SpecflowClient) {}

  setActiveTask(taskId: string): void {
    this.activeTaskId = taskId
  }

  async createRun(input: { taskId: string; featureId: string }): Promise<string> {
    this.activeTaskId = input.taskId
    return `run_${input.taskId}`
  }

  async updateRun(runId: string, patch: Partial<RunRecord>): Promise<void> {
    const status = patch.status === 'completed' ? 'completed' : 'failed'
    await this.client.finishTask(this.activeTaskId, {
      run_id: runId,
      status,
      error: patch.error,
      input_tokens: patch.inputTokens ?? (patch as any).input_tokens,
      output_tokens: patch.outputTokens ?? (patch as any).output_tokens,
      cost_usd: patch.costUsd ?? (patch as any).cost_usd,
    }).catch((err) => {
      console.warn('[store] finishTask notice:', err?.message || String(err))
    })
  }

  async emitRunEvent(
    runId: string,
    sequence: number,
    type: RunEventType,
    payload: unknown,
  ): Promise<void> {
    if (!RUN_EVENT_TYPES.has(type)) {
      console.warn(`[store] skipping unsupported run_event type "${type}"`)
      return
    }
    // High-frequency streaming text/reasoning deltas are suppressed over HTTP
    // to prevent socket saturation and database lock contention.
    // UI triggers "Agent working..." based on phase and tool execution state.
    if (type === 'text' || type === 'reasoning') {
      return
    }
    await this.client.sendEvents(this.activeTaskId, runId, [{ sequence, type, payload }]).catch((err) => {
      console.warn('[store] sendEvents notice:', err?.message || String(err))
    })
  }

  async updateTask(_taskId: string, _patch: Record<string, unknown>): Promise<void> {
    // Task state changes are synced to Specflow via claimTask and finishTask
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
