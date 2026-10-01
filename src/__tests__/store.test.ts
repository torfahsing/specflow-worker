import { describe, it, expect, beforeEach } from 'bun:test'
import {
  HttpWorkerStore,
  MemoryWorkerStore,
  RUN_EVENT_TYPES,
  type WorkerStore,
  type RunEventType,
} from '../store'
import type { SpecflowClient } from '../client'

// ---------------------------------------------------------------------------
// HttpWorkerStore tests with mock SpecflowClient
// ---------------------------------------------------------------------------

function makeStubClient() {
  const calls = {
    finishTask: 0,
    sendEvents: 0,
  }
  const finishedPayloads: any[] = []
  const sentEvents: any[] = []

  const client = {
    async finishTask(taskId: string, payload: any) {
      calls.finishTask++
      finishedPayloads.push({ taskId, ...payload })
      return { status: 'ok' }
    },
    async sendEvents(taskId: string, runId: string, events: any[]) {
      calls.sendEvents++
      sentEvents.push({ taskId, runId, events })
      return { status: 'ok', count: events.length }
    },
  } as unknown as SpecflowClient

  return { client, calls, finishedPayloads, sentEvents }
}

describe('HttpWorkerStore — HTTP API delegation', () => {
  it('createRun sets active task and returns a run ID', async () => {
    const { client } = makeStubClient()
    const store = new HttpWorkerStore(client)

    const runId = await store.createRun({ taskId: 't1', featureId: 'f1' })

    expect(runId).toBe('run_t1')
  })

  it('updateRun delegates to client.finishTask with mapped status', async () => {
    const { client, calls, finishedPayloads } = makeStubClient()
    const store = new HttpWorkerStore(client)

    await store.createRun({ taskId: 'task_abc', featureId: 'feat_1' })
    await store.updateRun('run_task_abc', {
      status: 'completed',
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.002,
    })

    expect(calls.finishTask).toBe(1)
    expect(finishedPayloads[0]).toEqual({
      taskId: 'task_abc',
      run_id: 'run_task_abc',
      status: 'completed',
      error: undefined,
      input_tokens: 100,
      output_tokens: 50,
      cost_usd: 0.002,
    })
  })

  it('emitRunEvent forwards valid event types to client.sendEvents', async () => {
    const { client, calls, sentEvents } = makeStubClient()
    const store = new HttpWorkerStore(client)

    await store.createRun({ taskId: 'task_1', featureId: 'feat_1' })
    await store.emitRunEvent('run_task_1', 1, 'text', { content: 'hello' })

    expect(calls.sendEvents).toBe(1)
    expect(sentEvents[0]).toEqual({
      taskId: 'task_1',
      runId: 'run_task_1',
      events: [{ sequence: 1, type: 'text', payload: { content: 'hello' } }],
    })
  })

  it('emitRunEvent drops unsupported types with a warning', async () => {
    const { client, calls } = makeStubClient()
    const store = new HttpWorkerStore(client)

    await store.createRun({ taskId: 'task_1', featureId: 'feat_1' })
    await store.emitRunEvent('run_task_1', 1, 'unsupported_type' as RunEventType, {})

    expect(calls.sendEvents).toBe(0)
  })

  it('updateRun catches network errors gracefully without crashing', async () => {
    const failingClient = {
      async finishTask() {
        throw new Error('network down')
      },
    } as unknown as SpecflowClient

    const store = new HttpWorkerStore(failingClient)
    await store.createRun({ taskId: 't1', featureId: 'f1' })

    await expect(
      store.updateRun('run_t1', { status: 'failed', error: 'some error' }),
    ).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// MemoryWorkerStore
// ---------------------------------------------------------------------------

describe('MemoryWorkerStore', () => {
  let store: MemoryWorkerStore

  beforeEach(() => {
    store = new MemoryWorkerStore()
  })

  it('createRun returns a string id and records the run', async () => {
    const id = await store.createRun({ taskId: 't1', featureId: 'f1' })

    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
    expect(store.runs.has(id)).toBe(true)
    expect(store.runs.get(id)!.taskId).toBe('t1')
    expect(store.runs.get(id)!.featureId).toBe('f1')
    expect(store.runs.get(id)!.status).toBe('running')
  })

  it('updateRun patches only provided keys', async () => {
    const id = await store.createRun({ taskId: 't1', featureId: 'f1' })
    await store.updateRun(id, { status: 'completed', inputTokens: 100 })

    const run = store.runs.get(id)!
    expect(run.status).toBe('completed')
    expect(run.inputTokens).toBe(100)
    expect(run.outputTokens).toBeUndefined()
    expect(run.costUsd).toBeUndefined()
  })

  it('emitRunEvent records events with monotonic sequences', async () => {
    const id = await store.createRun({ taskId: 't1', featureId: 'f1' })
    await store.emitRunEvent(id, 1, 'text', { content: 'hello' })
    await store.emitRunEvent(id, 2, 'reasoning', { content: 'think' })
    await store.emitRunEvent(id, 3, 'tool_call', { name: 'file_read', call_id: 'c1', args: {} })

    expect(store.events).toHaveLength(3)
    expect(store.events[0]!.sequence).toBe(1)
    expect(store.events[1]!.sequence).toBe(2)
    expect(store.events[2]!.sequence).toBe(3)
    expect(store.events[0]!.type).toBe('text')
    expect(store.events[1]!.type).toBe('reasoning')
    expect(store.events[2]!.type).toBe('tool_call')
  })

  it('updateTask records patches', async () => {
    await store.updateTask('task_1', { status: 'done', assigned_worker: null })

    expect(store.taskPatches).toHaveLength(1)
    expect(store.taskPatches[0]!.taskId).toBe('task_1')
    expect(store.taskPatches[0]!.patch).toEqual({ status: 'done', assigned_worker: null })
  })

  it('multiple runs and events are isolated by run id', async () => {
    const id1 = await store.createRun({ taskId: 't1', featureId: 'f1' })
    const id2 = await store.createRun({ taskId: 't2', featureId: 'f2' })

    await store.emitRunEvent(id1, 1, 'text', { content: 'run1' })
    await store.emitRunEvent(id2, 1, 'text', { content: 'run2' })

    expect(store.events).toHaveLength(2)
    expect(store.events[0]!.runId).toBe(id1)
    expect(store.events[1]!.runId).toBe(id2)
  })
})

// ---------------------------------------------------------------------------
// RUN_EVENT_TYPES — single source of truth
// ---------------------------------------------------------------------------

describe('RUN_EVENT_TYPES', () => {
  it('contains exactly the five standard event types', () => {
    expect(RUN_EVENT_TYPES.has('text')).toBe(true)
    expect(RUN_EVENT_TYPES.has('reasoning')).toBe(true)
    expect(RUN_EVENT_TYPES.has('tool_call')).toBe(true)
    expect(RUN_EVENT_TYPES.has('tool_result')).toBe(true)
    expect(RUN_EVENT_TYPES.has('error')).toBe(true)
  })

  it('does not contain non-standard types', () => {
    expect(RUN_EVENT_TYPES.has('assistant')).toBe(false)
    expect(RUN_EVENT_TYPES.has('result')).toBe(false)
    expect(RUN_EVENT_TYPES.has('step_update')).toBe(false)
    expect(RUN_EVENT_TYPES.has('turn_end')).toBe(false)
    expect(RUN_EVENT_TYPES.has('agent_end')).toBe(false)
  })

  it('is a ReadonlySet', () => {
    expect(RUN_EVENT_TYPES).toBeInstanceOf(Set)
  })
})
