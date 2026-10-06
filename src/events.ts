/**
 * RunRecorder — monotonic-sequence event writer and run finalizer.
 *
 * Wraps a `WorkerStore` so that no module outside this file ever
 * writes directly to run events. The recorder is the single
 * writer of run events.
 *
 * Event sequencing is strictly monotonic (`1,2,3,…`) via a chained
 * promise so that re-entrant `emit` calls never interleave and
 * ordering survives failures. Each `emit` is awaited so callers
 * can observe completion.
 *
 * Store rejections are caught within the chain so that a single
 * failure does not break subsequent emits.
 *
 * When `createRun` fails the recorder degrades to a no-op mode
 * (`runId = ''`) so the task still executes (graceful-degradation
 * contract).
 */

import type { WorkerStore, RunEventType, RunStatus } from './store.js'
import { RUN_EVENT_TYPES } from './store.js'

export class RunRecorder {
  private sequence = 0
  private pending = Promise.resolve()
  private eventCount = 0
  private finalized = false

  private constructor(
    private _runId: string,
    private store: WorkerStore,
  ) {}

  /**
   * Start a run by creating the run record.
   * On failure the recorder degrades to no-op mode
   * (`runId = ''`) so execution continues without run tracking.
   */
  static async start(
    store: WorkerStore,
    input: { taskId: string; featureId: string; runId?: string },
  ): Promise<RunRecorder> {
    if (input.runId) {
      if ((store as any).setActiveTask) {
        (store as any).setActiveTask(input.taskId, input.runId)
      }
      return new RunRecorder(input.runId, store)
    }
    try {
      const runId = await store.createRun(input)
      return new RunRecorder(runId, store)
    } catch (err) {
      console.warn('[events] createRun notice:', (err as Error).message)
      return new RunRecorder('', store)
    }
  }

  /** The run id, or `''` when the recorder is in degraded mode. */
  get runId(): string {
    return this._runId
  }

  /**
   * Emit a run event with a strictly monotonic sequence number.
   *
   * Calls are chained via a private `pending` promise so that
   * even re-entrant `emit` calls produce `1,2,3,…` in call order
   * with no interleaving. Each write is awaited.
   *
   * Store rejections are caught within the chain so that a single
   * failure does not break subsequent emits (graceful degradation).
   *
   * Unsupported types are dropped with a warning and do
   * not consume a sequence number. In degraded mode (`runId === ''`)
   * every call resolves immediately as a no-op.
   */
  async emit(type: RunEventType, payload: unknown): Promise<void> {
    if (!this._runId) return

    if (!RUN_EVENT_TYPES.has(type)) {
      console.warn(`[events] skipping unsupported run_event type "${type}"`)
      return
    }

    this.pending = this.pending
      .then(async () => {
        if (!this._runId) return
        await this.store.emitRunEvent(
          this._runId,
          ++this.sequence,
          type,
          payload,
        )
        this.eventCount++
      })
      .catch((err) => {
        console.warn('[events] emitRunEvent notice:', (err as Error).message)
      })

    await this.pending
  }

  /**
   * Emit a terminal `error` event carrying `exit_code` and/or
   * `signal` so the final event documents how the run ended.
   */
  async emitTerminalError(
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.emit('error', payload)
  }

  /**
   * Finalize the run by updating the run outcome.
   *
   * In degraded mode (runId = '') or when already finalized,
   * this is a no-op.
   */
  async finalize(outcome: {
    status: RunStatus
    output?: unknown
    tokens?: { input: number; output: number }
    costUsd?: number
    error?: string
  }): Promise<void> {
    if (!this._runId) return
    if (this.finalized) return
    this.finalized = true

    const patch: Record<string, unknown> = { status: outcome.status }
    if (outcome.output !== undefined) {
      patch.output = outcome.output
    }
    if (outcome.tokens) {
      patch.input_tokens = outcome.tokens.input
      patch.output_tokens = outcome.tokens.output
    }
    if (typeof outcome.costUsd === 'number') {
      patch.cost_usd = outcome.costUsd
    }
    if (outcome.error) {
      patch.error = outcome.error
    }

    await this.pending
    await this.store.updateRun(this._runId, patch)
    console.log(
      `[runner] run ${this._runId} finalized: ${outcome.status} (${this.eventCount} events)`,
    )
  }
}
