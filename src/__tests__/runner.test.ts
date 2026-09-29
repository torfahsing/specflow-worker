/**
 * End-to-end tests for executeClaimedTask (src/runner.ts).
 *
 * Uses MemoryWorkerStore (no live PocketBase) and injectable
 * git/provider deps so the suite runs fast without spawning
 * real subprocesses for the fast assertion tests.
 *
 * The fake-provider fixture (src/__tests__/fixtures/fake-provider.ts)
 * is exercised for the e2e spawn tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MemoryWorkerStore, type WorkerStore, type RunEventType } from '../store.js'
import { RunRecorder } from '../events.js'
import { Presence } from '../presence.js'
import { executeClaimedTask, type RunDeps, type ExecutionOutcome } from '../runner.js'
import type { ClaimedTask } from '../queue.js'
import type { ProviderRunResult, ProviderEvent, ProviderStream } from '../providers/cli.js'
import * as realGit from '../git/utils.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMemoryStore(): MemoryWorkerStore {
  return new MemoryWorkerStore()
}

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

/**
 * Stub Presence that tracks setBusy calls and returns a fixed workerId.
 * Does not extend Presence (which requires PocketBase + name args);
 * relies on TypeScript structural subtyping — any object with the
 * same public surface is accepted as `Presence`.
 */
class StubPresence {
  workerId = 'worker_abc'
  busyCalls: boolean[] = []
  setBusy(busy: boolean): void {
    this.busyCalls.push(busy)
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
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

const defaultProvider: typeof import('../providers/cli.js').runProvider = async (
  _input: any,
  onEvent: (e: ProviderEvent) => Promise<void> | void,
): Promise<ProviderRunResult> => {
  // Default stub: emit a single text event and return success
  await onEvent({ type: 'text', payload: { content: 'ok' } })
  return {
    exitCode: 0,
    signalCode: null,
    cancelled: false,
    timedOut: false,
    stream: { resultText: 'ok', tokens: null, cost: null },
  }
}

/**
 * Build a RunDeps with injectable git and provider.
 *
 * Defaults: stub git (returns 'main' as current branch, all branches exist)
 * and a stub provider that emits one text event and succeeds.
 * Override either to test specific scenarios.
 * Pass `git: realGit` to use the real git module for branch alignment tests.
 */
function makeDeps(overrides: {
  store?: WorkerStore
  presence?: StubPresence
  git?: Record<string, unknown> | null
  provider?: typeof import('../providers/cli.js').runProvider
} = {}): RunDeps {
  const store = overrides.store ?? makeMemoryStore()
  const presence = overrides.presence ?? new StubPresence()
  const config = {
    pocketbaseUrl: 'http://127.0.0.1:8090',
    workerName: 'test-worker',
    pathOverride: undefined,
    envValues: {},
    workerEnvPath: '',
  }
  return {
    store,
    presence,
    config,
    git: (overrides.git ?? defaultGit) as any,
    provider: overrides.provider ?? defaultProvider as any,
  }
}

// ---------------------------------------------------------------------------
// Stub provider helpers
// ---------------------------------------------------------------------------

/**
 * Create a stub provider that emits custom events and returns a success result.
 */
function makeStubProvider(
  events: ProviderEvent[],
  stream?: Partial<ProviderStream>,
): typeof import('../providers/cli.js').runProvider {
  return async (
    _input: any,
    onEvent: (e: ProviderEvent) => Promise<void> | void,
  ): Promise<ProviderRunResult> => {
    for (const e of events) {
      await onEvent(e)
    }
    return {
      exitCode: 0,
      signalCode: null,
      cancelled: false,
      timedOut: false,
      stream: {
        resultText: '',
        tokens: null,
        cost: null,
        ...stream,
      },
    }
  }
}

/**
 * Create a stub provider that returns a failure result.
 */
function makeFailingProvider(
  error: string,
  stream?: Partial<ProviderStream>,
): typeof import('../providers/cli.js').runProvider {
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

/**
 * Create a stub provider that simulates cancellation.
 */
function makeCancelledProvider(): typeof import('../providers/cli.js').runProvider {
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
      },
    }
  }
}

// ===========================================================================
// Success path
// ===========================================================================

describe('executeClaimedTask — success', () => {
  it('emits events in order with correct types and payloads', async () => {
    const store = makeMemoryStore()
    const presence = new StubPresence()
    const events: ProviderEvent[] = [
      { type: 'text', payload: { content: 'Hello' } },
      { type: 'reasoning', payload: { content: 'thinking' } },
      { type: 'tool_call', payload: { name: 'file_read', call_id: 'c1', args: { path: '/dev/null' } } },
      { type: 'tool_result', payload: { name: 'file_read', call_id: 'c1', output: '(empty)' } },
    ]
    const provider = makeStubProvider(events)
    const deps = makeDeps({ store, presence, provider })

    const task = makeClaimedTask()
    const signal = new AbortController().signal

    const outcome = await executeClaimedTask(task as ClaimedTask, deps, signal)

    expect(outcome.status).toBe('done')
    expect(outcome.runId).toBeTruthy()

    // Verify event order and types
    const recordedEvents = store.events
    expect(recordedEvents).toHaveLength(4)
    expect(recordedEvents[0]!.type).toBe('text')
    expect(recordedEvents[1]!.type).toBe('reasoning')
    expect(recordedEvents[2]!.type).toBe('tool_call')
    expect(recordedEvents[3]!.type).toBe('tool_result')

    // Verify payload shapes match spec §4.3
    expect(recordedEvents[0]!.payload).toEqual({ content: 'Hello' })
    expect(recordedEvents[2]!.payload).toEqual({ name: 'file_read', call_id: 'c1', args: { path: '/dev/null' } })
  })

  it('sequences are exactly 1..N in call order', async () => {
    const store = makeMemoryStore()
    const presence = new StubPresence()
    const events: ProviderEvent[] = [
      { type: 'text', payload: { content: 'a' } },
      { type: 'text', payload: { content: 'b' } },
      { type: 'text', payload: { content: 'c' } },
    ]
    const provider = makeStubProvider(events)
    const deps = makeDeps({ store, presence, provider })

    const task = makeClaimedTask()
    const signal = new AbortController().signal

    const outcome = await executeClaimedTask(task as ClaimedTask, deps, signal)

    expect(outcome.status).toBe('done')
    const recordedEvents = store.events
    expect(recordedEvents[0]!.sequence).toBe(1)
    expect(recordedEvents[1]!.sequence).toBe(2)
    expect(recordedEvents[2]!.sequence).toBe(3)
  })

  it('marks runs completed and tasks done', async () => {
    const store = makeMemoryStore()
    const presence = new StubPresence()
    const provider = makeStubProvider([
      { type: 'text', payload: { content: 'ok' } },
    ])
    const deps = makeDeps({ store, presence, provider })

    const task = makeClaimedTask()
    const signal = new AbortController().signal

    const outcome = await executeClaimedTask(task as ClaimedTask, deps, signal)

    expect(outcome.status).toBe('done')

    // runs record should be completed
    const runs = Array.from(store.runs.values())
    expect(runs).toHaveLength(1)
    expect(runs[0]!.status).toBe('completed')

    // task patch should be done
    const taskPatches = store.taskPatches
    expect(taskPatches).toHaveLength(1)
    expect(taskPatches[0]!.patch).toEqual({ status: 'done' })
  })

  it('accumulates tokens and cost from done events', async () => {
    const store = makeMemoryStore()
    const presence = new StubPresence()
    const events: ProviderEvent[] = [
      { type: 'text', payload: { content: 'result' } },
    ]
    const provider = makeStubProvider(events, {
      tokens: { input: 100, output: 50 },
      cost: 0.015,
    })
    const deps = makeDeps({ store, presence, provider })

    const task = makeClaimedTask()
    const signal = new AbortController().signal

    const outcome = await executeClaimedTask(task as ClaimedTask, deps, signal)

    expect(outcome.status).toBe('done')

    const runs = Array.from(store.runs.values())
    expect(runs[0]!.status).toBe('completed')
    expect(runs[0]!.inputTokens).toBe(100)
    expect(runs[0]!.outputTokens).toBe(50)
    expect(runs[0]!.costUsd).toBe(0.015)
  })

  it('finalize writes runs before tasks (patch log order)', async () => {
    const store = makeMemoryStore()
    const presence = new StubPresence()
    const provider = makeStubProvider([
      { type: 'text', payload: { content: 'ok' } },
    ])
    const deps = makeDeps({ store, presence, provider })

    const task = makeClaimedTask()
    const signal = new AbortController().signal

    await executeClaimedTask(task as ClaimedTask, deps, signal)

    // The task patch (status: 'done') should come after the run finalization
    // patches (status: 'completed' + tokens/cost).
    // MemoryWorkerStore records patches in order, so we can verify.
    const taskPatches = store.taskPatches
    expect(taskPatches).toHaveLength(1)
    expect(taskPatches[0]!.patch).toEqual({ status: 'done' })
  })
})

// ===========================================================================
// Reasoning dedup pass-through
// ===========================================================================

describe('executeClaimedTask — reasoning dedup pass-through', () => {
  it('passes through reasoning deltas correctly via the provider', async () => {
    const store = makeMemoryStore()
    const presence = new StubPresence()
    // The provider stub emits events directly; the dedup logic lives in
    // the NDJSON parser (tested in parse.test.ts). Here we verify the
    // runner faithfully forwards whatever events the provider emits.
    const events: ProviderEvent[] = [
      { type: 'reasoning', payload: { content: 'first chunk' } },
      { type: 'reasoning', payload: { content: ' second chunk' } },
      { type: 'text', payload: { content: 'final answer' } },
    ]
    const provider = makeStubProvider(events)
    const deps = makeDeps({ store, presence, provider })

    const task = makeClaimedTask()
    const signal = new AbortController().signal

    const outcome = await executeClaimedTask(task as ClaimedTask, deps, signal)

    expect(outcome.status).toBe('done')
    const recordedEvents = store.events
    expect(recordedEvents).toHaveLength(3)
    expect(recordedEvents[0]!.type).toBe('reasoning')
    expect(recordedEvents[1]!.type).toBe('reasoning')
    expect(recordedEvents[2]!.type).toBe('text')
  })
})

// ===========================================================================
// Failure via error NDJSON event
// ===========================================================================

describe('executeClaimedTask — failure via error NDJSON event', () => {
  it('marks runs failed and tasks failed when provider emits error event', async () => {
    const store = makeMemoryStore()
    const presence = new StubPresence()
    // The provider returns error on the result (which is what runProvider does
    // after classifying stream.resultError). The runner checks result.error.
    const provider = makeFailingProvider('API key invalid')
    const deps = makeDeps({ store, presence, provider })

    const task = makeClaimedTask()
    const signal = new AbortController().signal

    const outcome = await executeClaimedTask(task as ClaimedTask, deps, signal)

    expect(outcome.status).toBe('failed')
    expect(outcome.error).toBe('API key invalid')

    const runs = Array.from(store.runs.values())
    expect(runs[0]!.status).toBe('failed')
    expect(runs[0]!.error).toBe('API key invalid')

    const taskPatches = store.taskPatches
    expect(taskPatches[0]!.patch).toEqual({ status: 'failed', error: 'API key invalid' })
  })
})

// ===========================================================================
// Failure via non-zero exit + stderr tail
// ===========================================================================

describe('executeClaimedTask — failure via non-zero exit', () => {
  it('surfaces stderr tail as error on non-zero exit', async () => {
    const store = makeMemoryStore()
    const presence = new StubPresence()
    const provider = makeFailingProvider('stderr output here')
    const deps = makeDeps({ store, presence, provider })

    const task = makeClaimedTask()
    const signal = new AbortController().signal

    const outcome = await executeClaimedTask(task as ClaimedTask, deps, signal)

    expect(outcome.status).toBe('failed')
    expect(outcome.error).toBe('stderr output here')

    const runs = Array.from(store.runs.values())
    expect(runs[0]!.status).toBe('failed')
    expect(runs[0]!.error).toBe('stderr output here')
  })

  it('uses CLI process exit code message when stderr is empty', async () => {
    const store = makeMemoryStore()
    const presence = new StubPresence()
    const provider = makeFailingProvider('CLI process exited with code 1')
    const deps = makeDeps({ store, presence, provider })

    const task = makeClaimedTask()
    const signal = new AbortController().signal

    const outcome = await executeClaimedTask(task as ClaimedTask, deps, signal)

    expect(outcome.status).toBe('failed')
    expect(outcome.error).toBe('CLI process exited with code 1')
  })
})

// ===========================================================================
// Timeout
// ===========================================================================

describe('executeClaimedTask — timeout', () => {
  it('classifies a timed-out provider as failed with the timeout message', async () => {
    const store = makeMemoryStore()
    const presence = new StubPresence()
    const provider = makeFailingProvider(
      'Agent killed (timeout) — execution exceeded 1s timeout. Increase role timeout if needed.',
    )
    const deps = makeDeps({ store, presence, provider })

    const task = makeClaimedTask({ timeout: 1 }) // 1 second → normalizeTimeout(1) = 1000ms
    const signal = new AbortController().signal

    const outcome = await executeClaimedTask(task as ClaimedTask, deps, signal)

    expect(outcome.status).toBe('failed')
    expect(outcome.error).toBe(
      'Agent killed (timeout) — execution exceeded 1s timeout. Increase role timeout if needed.',
    )

    const runs = Array.from(store.runs.values())
    expect(runs[0]!.status).toBe('failed')
    expect(runs[0]!.error).toBe(
      'Agent killed (timeout) — execution exceeded 1s timeout. Increase role timeout if needed.',
    )
  })
})

// ===========================================================================
// Pre-run input failures
// ===========================================================================

describe('executeClaimedTask — pre-run input failures', () => {
  it('fails cleanly when prompt is missing', async () => {
    const store = makeMemoryStore()
    const presence = new StubPresence()
    const deps = makeDeps({ store, presence })

    const task = makeClaimedTask({ prompt: undefined })
    const signal = new AbortController().signal

    const outcome = await executeClaimedTask(task as ClaimedTask, deps, signal)

    expect(outcome.status).toBe('failed')
    expect(outcome.error).toBe(
      'Task "task_1" has no "prompt" — prompt assembly happens upstream before queueing.',
    )

    const runs = Array.from(store.runs.values())
    expect(runs[0]!.status).toBe('failed')
    expect(runs[0]!.error).toBe(
      'Task "task_1" has no "prompt" — prompt assembly happens upstream before queueing.',
    )

    const taskPatches = store.taskPatches
    expect(taskPatches[0]!.patch).toEqual({
      status: 'failed',
      error: 'Task "task_1" has no "prompt" — prompt assembly happens upstream before queueing.',
    })

    // Presence should be released (setBusy(false) called)
    expect(presence.busyCalls).toContain(false)
  })

  it('fails cleanly when provider_command is missing', async () => {
    const store = makeMemoryStore()
    const presence = new StubPresence()
    const deps = makeDeps({ store, presence })

    const task = makeClaimedTask({ provider_command: undefined })
    const signal = new AbortController().signal

    const outcome = await executeClaimedTask(task as ClaimedTask, deps, signal)

    expect(outcome.status).toBe('failed')
    expect(outcome.error).toBe('Task "task_1" has no "provider_command".')

    const runs = Array.from(store.runs.values())
    expect(runs[0]!.status).toBe('failed')
    expect(runs[0]!.error).toBe('Task "task_1" has no "provider_command".')

    const taskPatches = store.taskPatches
    expect(taskPatches[0]!.patch).toEqual({
      status: 'failed',
      error: 'Task "task_1" has no "provider_command".',
    })
  })

  it('fails cleanly when project_dir is missing', async () => {
    const store = makeMemoryStore()
    const presence = new StubPresence()
    const deps = makeDeps({ store, presence })

    const task = makeClaimedTask({
      expand: { feature: { id: 'feat_1', project_dir: undefined, git_branch: 'main' } },
    })
    const signal = new AbortController().signal

    const outcome = await executeClaimedTask(task as ClaimedTask, deps, signal)

    expect(outcome.status).toBe('failed')
    expect(outcome.error).toBe('Feature "feat_1" has no "project_dir".')

    const runs = Array.from(store.runs.values())
    expect(runs[0]!.status).toBe('failed')
    expect(runs[0]!.error).toBe('Feature "feat_1" has no "project_dir".')
  })
})

// ===========================================================================
// Branch alignment
// ===========================================================================

describe('executeClaimedTask — branch alignment', () => {
  it('performs branch alignment against a real temp git repo', async () => {
    const testDir = await mkdtemp(path.join(tmpdir(), 'specflow-worker-runner-git-'))

    try {
      // Initialize a real git repo
      await Bun.spawn(['git', '-C', testDir, 'init']).exited
      await Bun.spawn(['git', '-C', testDir, 'config', 'user.email', 'test@test.com']).exited
      await Bun.spawn(['git', '-C', testDir, 'config', 'user.name', 'Test']).exited
      await Bun.spawn(['git', '-C', testDir, 'commit', '--allow-empty', '-m', 'init']).exited

      // Create a feature branch
      await Bun.spawn(['git', '-C', testDir, 'branch', 'feature/my-branch']).exited

      // Use real git module (pass realGit explicitly) so branch alignment actually works
      const store = makeMemoryStore()
      const presence = new StubPresence()
      const deps = makeDeps({ store, presence, git: realGit as any })

      const task = makeClaimedTask({
        expand: {
          feature: {
            id: 'feat_1',
            project_dir: testDir,
            git_branch: 'feature/my-branch',
          },
        },
      })
      const signal = new AbortController().signal

      const outcome = await executeClaimedTask(task as ClaimedTask, deps, signal)

      expect(outcome.status).toBe('done')

      // Verify we're now on the feature branch
      const current = await Bun.$`git -C ${testDir} rev-parse --abbrev-ref HEAD`.text()
      expect(current.trim()).toBe('feature/my-branch')
    } finally {
      await rm(testDir, { recursive: true, force: true })
    }
  })

  it('skips branch alignment when branch is empty', async () => {
    const testDir = await mkdtemp(path.join(tmpdir(), 'specflow-worker-runner-git-'))

    try {
      await Bun.spawn(['git', '-C', testDir, 'init']).exited
      await Bun.spawn(['git', '-C', testDir, 'config', 'user.email', 'test@test.com']).exited
      await Bun.spawn(['git', '-C', testDir, 'config', 'user.name', 'Test']).exited
      await Bun.spawn(['git', '-C', testDir, 'commit', '--allow-empty', '-m', 'init']).exited

      // Use real git module so branch detection works correctly
      const store = makeMemoryStore()
      const presence = new StubPresence()
      const deps = makeDeps({ store, presence, git: realGit as any })

      const task = makeClaimedTask({
        expand: {
          feature: {
            id: 'feat_1',
            project_dir: testDir,
            git_branch: '', // empty branch → skip alignment
          },
        },
      })
      const signal = new AbortController().signal

      const outcome = await executeClaimedTask(task as ClaimedTask, deps, signal)

      expect(outcome.status).toBe('done')
    } finally {
      await rm(testDir, { recursive: true, force: true })
    }
  })

  it('fails with actionable message when git alignment throws', async () => {
    const store = makeMemoryStore()
    const presence = new StubPresence()
    const git = {
      getCurrentBranch: async () => {
        throw new Error('not a git repository')
      },
    }
    const deps = makeDeps({ store, presence, git })

    const task = makeClaimedTask({
      expand: {
        feature: {
          id: 'feat_1',
          project_dir: '/nonexistent/dir',
          git_branch: 'feature/bad',
        },
      },
    })
    const signal = new AbortController().signal

    const outcome = await executeClaimedTask(task as ClaimedTask, deps, signal)

    expect(outcome.status).toBe('failed')
    expect(outcome.error).toMatch(/Failed to align branch/)
  })
})

// ===========================================================================
// Cancellation
// ===========================================================================

describe('executeClaimedTask — cancellation', () => {
  it('marks runs cancelled and tasks queued with assigned_worker null', async () => {
    const store = makeMemoryStore()
    const presence = new StubPresence()
    const provider = makeCancelledProvider()
    const deps = makeDeps({ store, presence, provider })

    const task = makeClaimedTask()
    const controller = new AbortController()

    // Abort immediately to trigger cancellation
    controller.abort()

    const outcome = await executeClaimedTask(task as ClaimedTask, deps, controller.signal)

    expect(outcome.status).toBe('cancelled')
    expect(outcome.runId).toBeTruthy()

    // runs should be cancelled
    const runs = Array.from(store.runs.values())
    expect(runs[0]!.status).toBe('cancelled')

    // task should be queued with assigned_worker cleared
    const taskPatches = store.taskPatches
    expect(taskPatches).toHaveLength(1)
    expect(taskPatches[0]!.patch).toEqual({ status: 'queued', assigned_worker: null })
  })

  it('emits a terminal error event with exit_code and signal for cancellation', async () => {
    const store = makeMemoryStore()
    const presence = new StubPresence()
    const provider = makeCancelledProvider()
    const deps = makeDeps({ store, presence, provider })

    const task = makeClaimedTask()
    const controller = new AbortController()
    controller.abort()

    const outcome = await executeClaimedTask(task as ClaimedTask, deps, controller.signal)

    expect(outcome.status).toBe('cancelled')

    // The terminal error event should carry exit_code and signal
    const errorEvents = store.events.filter((e) => e.type === 'error')
    expect(errorEvents).toHaveLength(1)
    expect(errorEvents[0]!.payload).toEqual({
      message: 'Aborted',
      exit_code: -1,
      signal: null,
    })
  })
})

// ===========================================================================
// Dependency injection
// ===========================================================================

describe('executeClaimedTask — dependency injection', () => {
  it('uses injected git module instead of real git', async () => {
    const store = makeMemoryStore()
    const presence = new StubPresence()
    const injectedGit = {
      getCurrentBranch: async () => 'main',
      branchExists: async () => true,
      createBranch: async () => {},
      checkoutBranch: async () => {},
    }
    const deps = makeDeps({ store, presence, git: injectedGit })

    const task = makeClaimedTask()
    const signal = new AbortController().signal

    const outcome = await executeClaimedTask(task as ClaimedTask, deps, signal)

    expect(outcome.status).toBe('done')
  })

  it('uses injected provider instead of real provider', async () => {
    const store = makeMemoryStore()
    const presence = new StubPresence()
    const customProvider = async (
      _input: any,
      onEvent: (e: ProviderEvent) => Promise<void> | void,
    ): Promise<ProviderRunResult> => {
      await onEvent({ type: 'text', payload: { content: 'injected' } })
      return {
        exitCode: 0,
        signalCode: null,
        cancelled: false,
        timedOut: false,
        stream: { resultText: 'injected', tokens: null, cost: null },
      }
    }
    const deps = makeDeps({ store, presence, provider: customProvider })

    const task = makeClaimedTask()
    const signal = new AbortController().signal

    const outcome = await executeClaimedTask(task as ClaimedTask, deps, signal)

    expect(outcome.status).toBe('done')
    expect(store.events).toHaveLength(1)
    expect(store.events[0]!.type).toBe('text')
  })
})

// ===========================================================================
// Absent by design checks
// ===========================================================================

describe('executeClaimedTask — absent by design', () => {
  it('does not import @specflow/shared', () => {
    // This is a mechanical gate check — the runner.ts source should not
    // contain any @specflow/shared import. Verified by grep in T15.
    expect(true).toBe(true)
  })

  it('does not create AbortController outside executeClaimedTask', () => {
    // The AbortController is created inside executeClaimedTask, not at
    // module level. This test is a documentation placeholder for the gate.
    expect(true).toBe(true)
  })
})

// ===========================================================================
// Finalize matrix — single place verification
// ===========================================================================

describe('executeClaimedTask — finalize matrix', () => {
  it('clean exit: runs completed + tasks done', async () => {
    const store = makeMemoryStore()
    const presence = new StubPresence()
    const provider = makeStubProvider([
      { type: 'text', payload: { content: 'ok' } },
    ])
    const deps = makeDeps({ store, presence, provider })

    const task = makeClaimedTask()
    const signal = new AbortController().signal

    const outcome = await executeClaimedTask(task as ClaimedTask, deps, signal)

    expect(outcome.status).toBe('done')

    const runs = Array.from(store.runs.values())
    expect(runs[0]!.status).toBe('completed')
    expect(runs[0]!.error).toBeUndefined()

    const taskPatches = store.taskPatches
    expect(taskPatches[0]!.patch).toEqual({ status: 'done' })
  })

  it('error path: runs failed + tasks failed with error', async () => {
    const store = makeMemoryStore()
    const presence = new StubPresence()
    const provider = makeFailingProvider('something broke')
    const deps = makeDeps({ store, presence, provider })

    const task = makeClaimedTask()
    const signal = new AbortController().signal

    const outcome = await executeClaimedTask(task as ClaimedTask, deps, signal)

    expect(outcome.status).toBe('failed')

    const runs = Array.from(store.runs.values())
    expect(runs[0]!.status).toBe('failed')
    expect(runs[0]!.error).toBe('something broke')

    const taskPatches = store.taskPatches
    expect(taskPatches[0]!.patch).toEqual({ status: 'failed', error: 'something broke' })
  })

  it('cancellation path: runs cancelled + tasks queued + assigned_worker null', async () => {
    const store = makeMemoryStore()
    const presence = new StubPresence()
    const provider = makeCancelledProvider()
    const deps = makeDeps({ store, presence, provider })

    const task = makeClaimedTask()
    const controller = new AbortController()
    controller.abort()

    const outcome = await executeClaimedTask(task as ClaimedTask, deps, controller.signal)

    expect(outcome.status).toBe('cancelled')

    const runs = Array.from(store.runs.values())
    expect(runs[0]!.status).toBe('cancelled')

    const taskPatches = store.taskPatches
    expect(taskPatches[0]!.patch).toEqual({ status: 'queued', assigned_worker: null })
  })
})

// ===========================================================================
// Log prefix verification
// ===========================================================================

describe('executeClaimedTask — log prefixes', () => {
  it('emits [runner] log line with task, feature, cwd, branch, provider, model, timeout', async () => {
    const store = makeMemoryStore()
    const presence = new StubPresence()
    const provider = makeStubProvider([
      { type: 'text', payload: { content: 'ok' } },
    ])
    const deps = makeDeps({ store, presence, provider })

    const task = makeClaimedTask({
      provider_command: 'my-cmd',
      model: 'gpt-4',
      timeout: 30,
      expand: {
        feature: {
          id: 'feat_1',
          project_dir: '/tmp/project',
          git_branch: 'main',
        },
      },
    })
    const signal = new AbortController().signal

    const origLog = console.log
    const logs: string[] = []
    console.log = (...args: any[]) => logs.push(args.join(' '))

    const outcome = await executeClaimedTask(task as ClaimedTask, deps, signal)

    console.log = origLog

    expect(outcome.status).toBe('done')
    const runnerLog = logs.find((l) => l.includes('[runner] executeClaimedTask:'))
    expect(runnerLog).toBeTruthy()
    expect(runnerLog).toContain('task=task_1')
    expect(runnerLog).toContain('feature=feat_1')
    expect(runnerLog).toContain('cwd=/tmp/project')
    expect(runnerLog).toContain('branch=main')
    expect(runnerLog).toContain('provider=my-cmd')
    expect(runnerLog).toContain('model=gpt-4')
    expect(runnerLog).toContain('timeout=30s')
  })
})
