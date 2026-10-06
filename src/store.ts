/**
 * Persistence seam for the worker daemon.
 *
 * Implements WorkerStore interface backed by Specflow HTTP API via SpecflowClient
 * (HttpWorkerStore) or in-memory (MemoryWorkerStore) for offline unit testing.
 *
 * The worker daemon has zero direct database coupling: all state synchronization
 * occurs over HTTP/SSE with the Specflow orchestrator.
 */

import type { SpecflowClient, WorkerEventItem } from './client.js'

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
  output?: unknown
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

interface RunStreamState {
  taskId: string
  runId: string
  eventBuffer: WorkerEventItem[]
  flushTimer: ReturnType<typeof setTimeout> | null
  pendingFlush: Promise<void>
}

export class HttpWorkerStore implements WorkerStore {
  private runs = new Map<string, RunStreamState>()
  private defaultTaskId = ''

  constructor(private client: SpecflowClient) {}

  setActiveTask(taskId: string, runId?: string): void {
    this.defaultTaskId = taskId
    if (runId) {
      this.ensureRunState(taskId, runId)
    }
  }

  private ensureRunState(taskId: string, runId: string): RunStreamState {
    let state = this.runs.get(runId)
    if (!state) {
      state = {
        taskId,
        runId,
        eventBuffer: [],
        flushTimer: null,
        pendingFlush: Promise.resolve(),
      }
      this.runs.set(runId, state)
    } else if (taskId && !state.taskId) {
      state.taskId = taskId
    }
    return state
  }

  async createRun(input: { taskId: string; featureId: string }): Promise<string> {
    this.defaultTaskId = input.taskId
    const runId = `run_${input.taskId}`
    this.ensureRunState(input.taskId, runId)
    return runId
  }

  private async flushEvents(state: RunStreamState): Promise<void> {
    if (state.flushTimer) {
      clearTimeout(state.flushTimer)
      state.flushTimer = null
    }

    if (state.eventBuffer.length === 0 || !state.taskId || !state.runId) {
      return
    }

    const batch = [...state.eventBuffer]
    state.eventBuffer = []
    const taskId = state.taskId
    const runId = state.runId

    state.pendingFlush = state.pendingFlush
      .then(async () => {
        await this.client.sendEvents(taskId, runId, batch)
      })
      .catch((err) => {
        console.warn(`[store] sendEvents notice for task "${taskId}":`, err?.message || String(err))
      })

    await state.pendingFlush
  }

  async updateRun(runId: string, patch: Partial<RunRecord>): Promise<void> {
    const state = this.runs.get(runId)
    const taskId = state?.taskId || this.defaultTaskId

    if (state) {
      await this.flushEvents(state)
      await state.pendingFlush
      this.runs.delete(runId)
    }

    const status = patch.status === 'completed' ? 'completed' : 'failed'
    if (taskId) {
      await this.client.finishTask(taskId, {
        run_id: runId,
        status,
        output: patch.output,
        error: patch.error,
        input_tokens: patch.inputTokens ?? (patch as any).input_tokens,
        output_tokens: patch.outputTokens ?? (patch as any).output_tokens,
        cost_usd: patch.costUsd ?? (patch as any).cost_usd,
      }).catch((err) => {
        console.warn(`[store] finishTask notice for task "${taskId}":`, err?.message || String(err))
      })
    }
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

    let state = this.runs.get(runId)
    if (!state) {
      const inferredTaskId = runId.startsWith('run_') ? runId.slice(4) : this.defaultTaskId
      state = this.ensureRunState(inferredTaskId, runId)
    }

    state.eventBuffer.push({ sequence, type, payload })

    // High-priority events flush immediately; text and reasoning batch up with 75ms debounce
    if (
      state.eventBuffer.length >= 15 ||
      type === 'tool_call' ||
      type === 'tool_result' ||
      type === 'error'
    ) {
      await this.flushEvents(state)
    } else if (!state.flushTimer) {
      state.flushTimer = setTimeout(() => {
        this.flushEvents(state).catch((err) => {
          console.warn('[store] flushEvents notice:', err?.message || String(err))
        })
      }, 75)
    }
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
  output?: unknown
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
      output: undefined,
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
    if (patch.output !== undefined) run.output = patch.output
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
