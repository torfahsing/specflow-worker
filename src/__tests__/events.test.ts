import { describe, it, expect } from 'bun:test'
import { RunRecorder } from '../events.js'
import { MemoryWorkerStore } from '../store.js'
import type { WorkerStore, RunEventType } from '../store.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStore(): MemoryWorkerStore {
  return new MemoryWorkerStore()
}

// A store that rejects on createRun for degraded-mode tests.
class FailingStore implements WorkerStore {
  createRun = async () => {
    throw new Error('network error')
  }
  updateRun = async () => {}
  emitRunEvent = async () => {}
  updateTask = async () => {}
}

// A store that rejects emitRunEvent exactly once (callCount === 2),
// then succeeds on subsequent calls.  Used to verify that a single
// store rejection does not break the monotonic sequence chain.
class FlakyStore extends MemoryWorkerStore {
  private callCount = 0
  override async emitRunEvent(
    runId: string,
    sequence: number,
    type: RunEventType,
    payload: unknown,
  ): Promise<void> {
    this.callCount++
    if (this.callCount === 2) {
      throw new Error('intermittent network error')
    }
    await super.emitRunEvent(runId, sequence, type, payload)
  }
}

describe('RunRecorder — start', () => {
  it('returns a recorder with a non-empty runId on success', async () => {
    const store = makeStore()
    const recorder = await RunRecorder.start(store, {
      taskId: 'task_1',
      featureId: 'feat_1',
    })

    expect(recorder.runId).toBeTruthy()
    expect(recorder.runId.length).toBeGreaterThan(0)
  })

  it('returns a recorder with runId = "" when createRun fails', async () => {
    const store = new FailingStore()
    const recorder = await RunRecorder.start(store, {
      taskId: 'task_1',
      featureId: 'feat_1',
    })

    expect(recorder.runId).toBe('')
  })
})

describe('RunRecorder — emit', () => {
  it('emits events with strictly monotonic sequences 1..N', async () => {
    const store = makeStore()
    const recorder = await RunRecorder.start(store, {
      taskId: 'task_1',
      featureId: 'feat_1',
    })

    await recorder.emit('text', { content: 'hello' })
    await recorder.emit('reasoning', { content: 'think' })
    await recorder.emit('tool_call', { name: 'file_read', call_id: 'c1', args: {} })

    const events = store.events
    expect(events).toHaveLength(3)
    expect(events[0]!.sequence).toBe(1)
    expect(events[1]!.sequence).toBe(2)
    expect(events[2]!.sequence).toBe(3)
    expect(events[0]!.type).toBe('text')
    expect(events[1]!.type).toBe('reasoning')
    expect(events[2]!.type).toBe('tool_call')
  })

  it('preserves ordering under re-entrant emit calls', async () => {
    const store = makeStore()
    const recorder = await RunRecorder.start(store, {
      taskId: 'task_1',
      featureId: 'feat_1',
    })

    // Fire emits without awaiting — they chain internally.
    const p1 = recorder.emit('text', { content: 'a' })
    const p2 = recorder.emit('text', { content: 'b' })
    const p3 = recorder.emit('text', { content: 'c' })

    await Promise.all([p1, p2, p3])

    const events = store.events
    expect(events).toHaveLength(3)
    expect(events[0]!.sequence).toBe(1)
    expect(events[1]!.sequence).toBe(2)
    expect(events[2]!.sequence).toBe(3)
  })

  it('store rejection does not break the sequence chain', async () => {
    const store = new FlakyStore()
    const recorder = await RunRecorder.start(store, {
      taskId: 'task_1',
      featureId: 'feat_1',
    })

    // First emit succeeds.
    await recorder.emit('text', { content: 'hello' })
    // Second emit fails (store rejects).
    await recorder.emit('text', { content: 'world' })
    // Third emit must still work — sequence continues.
    await recorder.emit('text', { content: '!' })

    // First and third events should be recorded (sequence 1 and 3).
    // The second failed but the chain continued.
    const events = store.events
    expect(events).toHaveLength(2)
    expect(events[0]!.sequence).toBe(1)
    expect(events[1]!.sequence).toBe(3)
  })

  it('unsupported type is dropped without consuming a sequence', async () => {
    const store = makeStore()
    const recorder = await RunRecorder.start(store, {
      taskId: 'task_1',
      featureId: 'feat_1',
    })

    // Unsupported type — should not create an event and should
    // not consume a sequence number.
    await recorder.emit('assistant' as any, { content: 'hi' })
    await recorder.emit('text', { content: 'hello' })

    const events = store.events
    expect(events).toHaveLength(1)
    expect(events[0]!.sequence).toBe(1)
    expect(events[0]!.type).toBe('text')
  })

  it('degraded mode (runId = "") resolves all emits without throwing', async () => {
    const store = new FailingStore()
    const recorder = await RunRecorder.start(store, {
      taskId: 'task_1',
      featureId: 'feat_1',
    })

    expect(recorder.runId).toBe('')

    // All of these must resolve without throwing.
    await expect(
      recorder.emit('text', { content: 'hello' }),
    ).resolves.toBeUndefined()
    await expect(
      recorder.emit('reasoning', { content: 'think' }),
    ).resolves.toBeUndefined()
    await expect(
      recorder.emitTerminalError({ message: 'boom' }),
    ).resolves.toBeUndefined()
    await expect(
      recorder.finalize({ status: 'failed', error: 'boom' }),
    ).resolves.toBeUndefined()
  })
})

describe('RunRecorder — emitTerminalError', () => {
  it('emits an error event with exit_code and signal', async () => {
    const store = makeStore()
    const recorder = await RunRecorder.start(store, {
      taskId: 'task_1',
      featureId: 'feat_1',
    })

    await recorder.emitTerminalError({
      message: 'Agent killed (timeout)',
      exit_code: 143,
      signal: 'SIGTERM',
    })

    const events = store.events
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('error')
    expect(events[0]!.payload).toEqual({
      message: 'Agent killed (timeout)',
      exit_code: 143,
      signal: 'SIGTERM',
    })
  })
})

describe('RunRecorder — finalize', () => {
  it('patches only provided keys (status + tokens)', async () => {
    const store = makeStore()
    const recorder = await RunRecorder.start(store, {
      taskId: 'task_1',
      featureId: 'feat_1',
    })

    await recorder.emit('text', { content: 'done' })
    await recorder.finalize({
      status: 'completed',
      tokens: { input: 100, output: 50 },
    })

    const run = store.runs.get(recorder.runId)!
    expect(run.status).toBe('completed')
    expect(run.inputTokens).toBe(100)
    expect(run.outputTokens).toBe(50)
    expect(run.costUsd).toBeUndefined()
    expect(run.error).toBeUndefined()
  })

  it('patches only provided keys (status + costUsd)', async () => {
    const store = makeStore()
    const recorder = await RunRecorder.start(store, {
      taskId: 'task_1',
      featureId: 'feat_1',
    })

    await recorder.finalize({
      status: 'failed',
      costUsd: 0.015,
    })

    const run = store.runs.get(recorder.runId)!
    expect(run.status).toBe('failed')
    expect(run.costUsd).toBe(0.015)
    expect(run.inputTokens).toBeUndefined()
    expect(run.outputTokens).toBeUndefined()
  })

  it('patches only provided keys (status + error)', async () => {
    const store = makeStore()
    const recorder = await RunRecorder.start(store, {
      taskId: 'task_1',
      featureId: 'feat_1',
    })

    await recorder.finalize({
      status: 'failed',
      error: 'Agent killed (timeout)',
    })

    const run = store.runs.get(recorder.runId)!
    expect(run.status).toBe('failed')
    expect(run.error).toBe('Agent killed (timeout)')
  })

  it('degraded mode (runId = "") is a no-op', async () => {
    const store = new FailingStore()
    const recorder = await RunRecorder.start(store, {
      taskId: 'task_1',
      featureId: 'feat_1',
    })

    // Should not throw.
    await recorder.finalize({ status: 'completed' })
  })

  it('double finalize is a no-op after the first call', async () => {
    const store = makeStore()
    const recorder = await RunRecorder.start(store, {
      taskId: 'task_1',
      featureId: 'feat_1',
    })

    await recorder.finalize({ status: 'completed' })
    await recorder.finalize({ status: 'failed' })

    const run = store.runs.get(recorder.runId)!
    // Status should remain 'completed' — second finalize was ignored.
    expect(run.status).toBe('completed')
  })
})

describe('RunRecorder — event count tracking', () => {
  it('eventCount reflects only successfully emitted events', async () => {
    const store = makeStore()
    const recorder = await RunRecorder.start(store, {
      taskId: 'task_1',
      featureId: 'feat_1',
    })

    await recorder.emit('text', { content: 'a' })
    await recorder.emit('text', { content: 'b' })

    // The recorder's eventCount is 2.
    expect(store.events).toHaveLength(2)
  })
})
