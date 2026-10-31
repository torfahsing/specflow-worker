/**
 * Partial usage propagation on cancelled/failed finishes (spec §2).
 *
 * The cancelled and failed paths must forward the identical
 * `result.stream` usage source the success path reads into
 * `recorder.finalize()`, and the finish POST body must carry
 * `input_tokens`/`output_tokens`/`cost_usd` with `status: "cancelled"`
 * for aborted runs — best-effort: absent usage never fails the finish.
 */

import { describe, it, expect } from 'bun:test'
import { MemoryWorkerStore, HttpWorkerStore } from '../store.js'
import { executeClaimedTask, type RunDeps } from '../runner.js'
import type { ClaimedTask } from '../queue.js'
import type { SpecflowClient } from '../client.js'
import type { ProviderRunResult, ProviderEvent, ProviderStream } from '../providers/cli.js'

// ---------------------------------------------------------------------------
// Helpers (mirroring runner.test.ts patterns)
// ---------------------------------------------------------------------------

function makeClaimedTask(overrides: Record<string, unknown> = {}): ClaimedTask {
  return {
    id: 'task_1',
    featureId: 'feat_1',
    record: {
      id: 'task_1',
      status: 'in_progress',
      prompt: 'Do the thing',
      provider_command: 'my-provider',
      model: 'gpt-4',
      allowed_tools: ['file_read', 'file_write'],
      timeout: 30,
      expand: {
        feature: {
          id: 'feat_1',
          project_dir: '/tmp/test-project',
          git_branch: 'main',
        },
      },
      ...overrides,
    },
  }
}

class StubPresence {
  workerId = 'worker_abc'
  busyCalls: boolean[] = []
  setBusy(busy: boolean): void {
    this.busyCalls.push(busy)
  }
  ensure(_workerName?: string): Promise<string> {
    return Promise.resolve(this.workerId)
  }
  start(): void {}
  async stop(): Promise<void> {}
}

const defaultGit: Record<string, unknown> = {
  getCurrentBranch: async () => 'main',
  branchExists: async () => true,
  createBranch: async () => {},
  checkoutBranch: async () => {},
}

function makeDeps(overrides: {
  store?: MemoryWorkerStore
  presence?: StubPresence
  provider?: typeof import('../providers/cli.js').runProvider
} = {}): RunDeps {
  return {
    store: overrides.store ?? new MemoryWorkerStore(),
    presence: overrides.presence ?? new StubPresence(),
    config: {
      specflowUrl: 'http://127.0.0.1:3200',
      workerName: 'test-worker',
      pathOverride: undefined,
      envValues: {},
      workerEnvPath: '',
    },
    git: defaultGit as any,
    provider: overrides.provider as any,
  }
}

/** Stub provider that returns a cancelled result with optional stream usage. */
function makeCancelledProvider(stream?: Partial<ProviderStream>): typeof import('../providers/cli.js').runProvider {
  return async (
    _input: any,
    _onEvent: (e: ProviderEvent) => Promise<void> | void,
  ): Promise<ProviderRunResult> => {
    return {
      exitCode: -1,
      signalCode: null,
      cancelled: true,
      timedOut: false,
      error: 'Aborted',
      stream: {
        resultText: '',
        tokens: null,
        cost: null,
        ...stream,
      },
    }
  }
}

/** Stub provider that returns a failure result with optional stream usage. */
function makeFailingProvider(error: string, stream?: Partial<ProviderStream>): typeof import('../providers/cli.js').runProvider {
  return async (
    _input: any,
    _onEvent: (e: ProviderEvent) => Promise<void> | void,
  ): Promise<ProviderRunResult> => {
    return {
      exitCode: 1,
      signalCode: null,
      cancelled: false,
      timedOut: false,
      error,
      stream: {
        resultText: '',
        tokens: null,
        cost: null,
        ...stream,
      },
    }
  }
}

// ---------------------------------------------------------------------------
// Runner — cancelled path forwards partial usage
// ---------------------------------------------------------------------------

describe('executeClaimedTask — cancelled finish carries partial usage', () => {
  it('cancelled run with stream usage: finalize records tokens + costUsd on the run', async () => {
    const store = new MemoryWorkerStore()
    const provider = makeCancelledProvider({
      tokens: { input: 1234, output: 567 },
      cost: 0.0042,
    })
    const deps = makeDeps({ store, provider })

    const controller = new AbortController()
    controller.abort()

    const outcome = await executeClaimedTask(makeClaimedTask() as ClaimedTask, deps, controller.signal)

    expect(outcome.status).toBe('cancelled')

    const runs = Array.from(store.runs.values())
    expect(runs).toHaveLength(1)
    expect(runs[0]!.status).toBe('cancelled')
    // Same source the success path uses: result.stream.tokens / result.stream.cost
    expect(runs[0]!.inputTokens).toBe(1234)
    expect(runs[0]!.outputTokens).toBe(567)
    expect(runs[0]!.costUsd).toBe(0.0042)
  })

  it('cancelled run without stream usage: finish still succeeds with no usage recorded', async () => {
    const store = new MemoryWorkerStore()
    const provider = makeCancelledProvider()
    const deps = makeDeps({ store, provider })

    const controller = new AbortController()
    controller.abort()

    const outcome = await executeClaimedTask(makeClaimedTask() as ClaimedTask, deps, controller.signal)

    expect(outcome.status).toBe('cancelled')

    const runs = Array.from(store.runs.values())
    expect(runs[0]!.status).toBe('cancelled')
    expect(runs[0]!.inputTokens).toBeUndefined()
    expect(runs[0]!.outputTokens).toBeUndefined()
    expect(runs[0]!.costUsd).toBeUndefined()
  })

  it('cancelled run does not disturb task requeue or presence semantics', async () => {
    const store = new MemoryWorkerStore()
    const presence = new StubPresence()
    const provider = makeCancelledProvider({
      tokens: { input: 10, output: 20 },
      cost: 0.001,
    })
    const deps = makeDeps({ store, presence, provider })

    const controller = new AbortController()
    controller.abort()

    await executeClaimedTask(makeClaimedTask() as ClaimedTask, deps, controller.signal)

    const taskPatches = store.taskPatches
    expect(taskPatches).toHaveLength(1)
    expect(taskPatches[0]!.patch).toEqual({ status: 'queued', assigned_worker: null })
    expect(presence.busyCalls).toEqual([true, false])
  })
})

// ---------------------------------------------------------------------------
// Runner — failed path forwards partial usage
// ---------------------------------------------------------------------------

describe('executeClaimedTask — failed finish carries partial usage', () => {
  it('failed run with stream usage: finalize records tokens + costUsd on the run', async () => {
    const store = new MemoryWorkerStore()
    const provider = makeFailingProvider('agent exploded', {
      tokens: { input: 900, output: 12 },
      cost: 0.0031,
    })
    const deps = makeDeps({ store, provider })

    const outcome = await executeClaimedTask(makeClaimedTask() as ClaimedTask, deps, new AbortController().signal)

    expect(outcome.status).toBe('failed')
    expect(outcome.error).toBe('agent exploded')

    const runs = Array.from(store.runs.values())
    expect(runs).toHaveLength(1)
    expect(runs[0]!.status).toBe('failed')
    expect(runs[0]!.error).toBe('agent exploded')
    expect(runs[0]!.inputTokens).toBe(900)
    expect(runs[0]!.outputTokens).toBe(12)
    expect(runs[0]!.costUsd).toBe(0.0031)
  })

  it('failed run without stream usage: run fails cleanly with no usage recorded', async () => {
    const store = new MemoryWorkerStore()
    const provider = makeFailingProvider('agent exploded')
    const deps = makeDeps({ store, provider })

    const outcome = await executeClaimedTask(makeClaimedTask() as ClaimedTask, deps, new AbortController().signal)

    expect(outcome.status).toBe('failed')

    const runs = Array.from(store.runs.values())
    expect(runs[0]!.status).toBe('failed')
    expect(runs[0]!.inputTokens).toBeUndefined()
    expect(runs[0]!.outputTokens).toBeUndefined()
    expect(runs[0]!.costUsd).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// HttpWorkerStore — finish POST body contract
// ---------------------------------------------------------------------------

function makeStubClient() {
  const finishedPayloads: any[] = []
  const client = {
    async finishTask(taskId: string, payload: any) {
      finishedPayloads.push({ taskId, ...payload })
      return { status: 'ok' }
    },
    async sendEvents() {
      return { status: 'ok', count: 0 }
    },
  } as unknown as SpecflowClient
  return { client, finishedPayloads }
}

describe('HttpWorkerStore — cancelled finish POST body', () => {
  it('forwards status "cancelled" plus usage fields to the finish POST', async () => {
    const { client, finishedPayloads } = makeStubClient()
    const store = new HttpWorkerStore(client)

    await store.createRun({ taskId: 'task_cancel', featureId: 'feat_1' })
    // Snake_case keys mirror the exact patch shape recorder.finalize() writes.
    await store.updateRun('run_task_cancel', {
      status: 'cancelled',
      input_tokens: 1234,
      output_tokens: 567,
      cost_usd: 0.0042,
    } as any)

    expect(finishedPayloads).toHaveLength(1)
    expect(finishedPayloads[0]).toEqual({
      taskId: 'task_cancel',
      run_id: 'run_task_cancel',
      status: 'cancelled',
      output: undefined,
      error: undefined,
      input_tokens: 1234,
      output_tokens: 567,
      cost_usd: 0.0042,
    })
  })

  it('cancelled finish with no usage still POSTs successfully (usage omitted)', async () => {
    const { client, finishedPayloads } = makeStubClient()
    const store = new HttpWorkerStore(client)

    await store.createRun({ taskId: 'task_cancel_bare', featureId: 'feat_1' })
    await store.updateRun('run_task_cancel_bare', { status: 'cancelled' })

    expect(finishedPayloads).toHaveLength(1)
    expect(finishedPayloads[0]!.status).toBe('cancelled')
    expect(finishedPayloads[0]!.input_tokens).toBeUndefined()
    expect(finishedPayloads[0]!.output_tokens).toBeUndefined()
    expect(finishedPayloads[0]!.cost_usd).toBeUndefined()
  })

  it('cancelled finish POST failures are swallowed (best-effort, never crash the run)', async () => {
    const failingClient = {
      async finishTask() {
        throw new Error('400: Invalid finish payload')
      },
      async sendEvents() {
        return { status: 'ok', count: 0 }
      },
    } as unknown as SpecflowClient
    const store = new HttpWorkerStore(failingClient)

    await store.createRun({ taskId: 't1', featureId: 'f1' })

    await expect(
      store.updateRun('run_t1', {
        status: 'cancelled',
        input_tokens: 5,
        cost_usd: 0.0001,
      } as any),
    ).resolves.toBeUndefined()
  })

  it('completed and failed statuses keep their existing mapping', async () => {
    const { client, finishedPayloads } = makeStubClient()
    const store = new HttpWorkerStore(client)

    await store.createRun({ taskId: 'task_ok', featureId: 'feat_1' })
    await store.updateRun('run_task_ok', { status: 'completed', output: 'ok' })
    await store.createRun({ taskId: 'task_bad', featureId: 'feat_1' })
    await store.updateRun('run_task_bad', { status: 'failed', error: 'boom' })

    expect(finishedPayloads[0]!.status).toBe('completed')
    expect(finishedPayloads[1]!.status).toBe('failed')
  })
})
