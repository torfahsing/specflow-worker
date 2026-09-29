/**
 * Spec §4.3 / §4.5 — Payload shape and finalization-matrix verification.
 *
 * Verbatim assertions that:
 *   • Every emitted event's payload matches the exact shape from spec §4.3.
 *   • Every finalization outcome maps to the correct runs.status + tasks.status
 *     pair from the §4.5 table, including all rows: completed, failed, timeout,
 *     missing-executable, cancelled.
 */

import { describe, it, expect } from 'bun:test'
import { MemoryWorkerStore } from '../store.js'
import type { WorkerStore } from '../store.js'
import type { ClaimedTask } from '../queue.js'
import { executeClaimedTask, type RunDeps } from '../runner.js'
import type { ProviderEvent, ProviderRunResult, ProviderStream } from '../providers/cli'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class StubPresence {
  workerId = 'w1'
  busyCalls: boolean[] = []
  setBusy(b: boolean): void { this.busyCalls.push(b) }
}

function makeClaimed(overrides: Record<string, unknown> = {}): ClaimedTask {
  return {
    id: 'task_x',
    featureId: 'feat_x',
    record: {
      id: 'task_x',
      status: 'in_progress',
      prompt: 'Do it',
      provider_command: 'my-provider',
      model: 'gpt-4',
      allowed_tools: ['file_read'],
      timeout: 30,
      expand: {
        feature: {
          id: 'feat_x',
          project_dir: '/tmp/t',
          git_branch: 'main',
        },
      },
      ...overrides,
    },
  }
}

function makeStubProvider(
  events: ProviderEvent[],
  stream?: Partial<ProviderStream>,
  extra?: Partial<ProviderRunResult>,
): typeof import('../providers/cli').runProvider {
  return async (_input: any, onEvent: (e: ProviderEvent) => Promise<void> | void): Promise<ProviderRunResult> => {
    for (const e of events) await onEvent(e)
    return {
      exitCode: 0, signalCode: null, cancelled: false, timedOut: false,
      stream: { resultText: '', tokens: null, cost: null, ...stream },
      ...extra,
    } as ProviderRunResult
  }
}

function makeDeps(store: WorkerStore, overrides: { provider?: any; git?: any } = {}): RunDeps {
  const presence = new StubPresence()
  const config = { pocketbaseUrl: 'http://localhost:8090', workerName: 't', pathOverride: undefined, envValues: {}, workerEnvPath: '' }
  const git = overrides.git ?? {
    getCurrentBranch: async () => 'main',
    branchExists: async () => true,
    createBranch: async () => {},
    checkoutBranch: async () => {},
  }
  return {
    store,
    presence,
    config,
    git,
    provider: overrides.provider as any,
  }
}

// ===========================================================================
// §4.3 Payload shapes
// ===========================================================================

describe('§4.3 — verbatim event payload shapes', () => {
  it('text event has { content: string } payload', async () => {
    const store = new MemoryWorkerStore()
    const deps = makeDeps(store, {
      provider: makeStubProvider([
        { type: 'text', payload: { content: 'the answer is 42' } },
      ]),
    })

    await executeClaimedTask(makeClaimed(), deps, new AbortController().signal)

    const evt = store.events[0]!
    expect(evt.type).toBe('text')
    expect(evt.payload).toEqual({ content: 'the answer is 42' })
  })

  it('reasoning event has { content: string } payload', async () => {
    const store = new MemoryWorkerStore()
    const deps = makeDeps(store, {
      provider: makeStubProvider([
        { type: 'reasoning', payload: { content: 'deduped remainder' } },
      ]),
    })

    await executeClaimedTask(makeClaimed(), deps, new AbortController().signal)

    expect(store.events[0]!.payload).toEqual({ content: 'deduped remainder' })
  })

  it('tool_call event has { name, call_id, args } payload', async () => {
    const store = new MemoryWorkerStore()
    const deps = makeDeps(store, {
      provider: makeStubProvider([
        { type: 'tool_call', payload: { name: 'file_read', call_id: 'c1', args: { path: '/x', mode: 'r' } } },
      ]),
    })

    await executeClaimedTask(makeClaimed(), deps, new AbortController().signal)

    const p = store.events[0]!.payload as Record<string, unknown>
    expect(p.name).toBe('file_read')
    expect(p.call_id).toBe('c1')
    expect(p.args).toEqual({ path: '/x', mode: 'r' })
  })

  it('tool_result event has { name, call_id, output } payload', async () => {
    const store = new MemoryWorkerStore()
    const deps = makeDeps(store, {
      provider: makeStubProvider([
        { type: 'tool_result', payload: { name: 'file_read', call_id: 'c1', output: '#!/usr/bin/env node\\nconsole.log(1)' } },
      ]),
    })

    await executeClaimedTask(makeClaimed(), deps, new AbortController().signal)

    const p = store.events[0]!.payload as Record<string, unknown>
    expect(p.name).toBe('file_read')
    expect(p.call_id).toBe('c1')
    expect(p.output).toBeDefined()
  })

  it('error event carries exit_code and signal in its payload (via failing provider)', async () => {
    const store = new MemoryWorkerStore()
    // Use a provider that returns an error result — this triggers the terminal
    // error event path (emitTerminalError → emit("error", ...))
    const deps = makeDeps(store, {
      provider: makeStubProvider([], {}, { error: 'provider crashed', exitCode: 137, signalCode: 'SIGTERM' }),
    })

    await executeClaimedTask(makeClaimed(), deps, new AbortController().signal)

    const errorEvents = store.events.filter((e) => e.type === 'error')
    expect(errorEvents).toHaveLength(1)
    const p = errorEvents[0]!.payload as Record<string, unknown>
    expect(p.message).toBe('provider crashed')
    expect(p.exit_code).toBe(137)
    expect(p.signal).toBe('SIGTERM')
  })
})

// ===========================================================================
// §4.5 Finalization matrix
// ===========================================================================

describe('§4.5 — finalization matrix rows', () => {
  it('[completed] clean exit → runs.completed + tasks.done', async () => {
    const store = new MemoryWorkerStore()
    const deps = makeDeps(store, {
      provider: makeStubProvider([{ type: 'text', payload: { content: 'ok' } }]),
    })

    const outcome = await executeClaimedTask(makeClaimed(), deps, new AbortController().signal)

    expect(outcome.status).toBe('done')
    const run = Array.from(store.runs.values())[0]!
    expect(run.status).toBe('completed')
    const taskPatches = store.taskPatches
    expect(taskPatches[0]!.patch).toEqual({ status: 'done' })
  })

  it('[failed] provider error → runs.failed + tasks.failed with error text', async () => {
    const store = new MemoryWorkerStore()
    const deps = makeDeps(store, {
      provider: makeStubProvider([], {}, { error: 'something broke', exitCode: 1 }),
    })

    const outcome = await executeClaimedTask(makeClaimed(), deps, new AbortController().signal)

    expect(outcome.status).toBe('failed')
    const run = Array.from(store.runs.values())[0]!
    expect(run.status).toBe('failed')
    expect(run.error).toBe('something broke')
    expect(store.taskPatches[0]!.patch).toEqual({ status: 'failed', error: 'something broke' })
  })

  it('[timeout] timed-out provider → runs.failed + tasks.failed with timeout message', async () => {
    const store = new MemoryWorkerStore()
    const expectedTimeoutMsg = 'Agent killed (timeout) — execution exceeded 1s timeout. Increase role timeout if needed.'
    const deps = makeDeps(store, {
      provider: makeStubProvider([], {}, { timedOut: true, error: expectedTimeoutMsg }),
    })

    const outcome = await executeClaimedTask(makeClaimed({ timeout: 1 }), deps, new AbortController().signal)

    expect(outcome.status).toBe('failed')
    const run = Array.from(store.runs.values())[0]!
    expect(run.status).toBe('failed')
    expect(run.error).toContain('timeout')
    expect(store.taskPatches[0]!.patch).toEqual({ status: 'failed', error: expect.stringContaining('timeout') })
  })

  it('[missing-executable] pre-spawn miss → runs.failed + tasks.failed with exact message', async () => {
    const store = new MemoryWorkerStore()
    // Inject a provider that short-circuits like resolveProviderCommand does
    const fakeMissingExec: typeof import('../providers/cli').runProvider = async (input: any) => ({
      exitCode: -1,
      signalCode: null,
      cancelled: false,
      timedOut: false,
      error: `Provider executable "${input.command}" not found in PATH.`,
      stream: { resultText: '', tokens: null, cost: null },
    })
    const deps = makeDeps(store, { provider: fakeMissingExec })

    const outcome = await executeClaimedTask(makeClaimed(), deps, new AbortController().signal)

    expect(outcome.status).toBe('failed')
    expect(outcome.error).toBe('Provider executable "my-provider" not found in PATH.')
    const run = Array.from(store.runs.values())[0]!
    expect(run.status).toBe('failed')
    expect(run.error).toBe('Provider executable "my-provider" not found in PATH.')
    expect(store.taskPatches[0]!.patch).toEqual({
      status: 'failed',
      error: 'Provider executable "my-provider" not found in PATH.',
    })
  })

  it('[cancelled] stubbed provider returns cancelled → runs.cancelled + tasks.queued + assigned_worker null', async () => {
    const store = new MemoryWorkerStore()
    // Inject a provider that reports cancellation — real Bun.spawn would need
    // an actual child process responding to signals, so we use the injection
    // seam for this test while existing runner.test.ts covers the full flow.
    const cancelProvider: typeof import('../providers/cli').runProvider = async () => ({
      exitCode: -1,
      signalCode: null,
      cancelled: true,
      timedOut: false,
      error: 'Aborted',
      stream: { resultText: '', tokens: null, cost: null },
    })
    const deps = makeDeps(store, { provider: cancelProvider })

    const outcome = await executeClaimedTask(makeClaimed(), deps, new AbortController().signal)

    expect(outcome.status).toBe('cancelled')
    const run = Array.from(store.runs.values())[0]!
    expect(run.status).toBe('cancelled')
    const tp = store.taskPatches[0]!
    expect(tp.patch).toEqual({ status: 'queued', assigned_worker: null })
  })
})
