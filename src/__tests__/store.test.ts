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
    await store.emitRunEvent('run_task_1', 1, 'tool_call', { name: 'file_read' })

    expect(calls.sendEvents).toBe(1)
    expect(sentEvents[0]).toEqual({
      taskId: 'task_1',
      runId: 'run_task_1',
      events: [{ sequence: 1, type: 'tool_call', payload: { name: 'file_read' } }],
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

  it('batches text/reasoning events and flushes before finishTask', async () => {
    const { client, calls, sentEvents, finishedPayloads } = makeStubClient()
    const store = new HttpWorkerStore(client)

    await store.createRun({ taskId: 't_stream', featureId: 'f1' })
    await store.emitRunEvent('run_t_stream', 1, 'text', { content: 'hello ' })
    await store.emitRunEvent('run_t_stream', 2, 'text', { content: 'world' })

    // Events are buffered in memory and not yet sent immediately
    expect(calls.sendEvents).toBe(0)

    // Finalizing run flushes buffered events before finishTask
    await store.updateRun('run_t_stream', { status: 'completed', output: 'hello world' })

    expect(calls.sendEvents).toBe(1)
    expect(sentEvents[0].events).toHaveLength(2)
    expect(sentEvents[0].events[0].payload).toEqual({ content: 'hello ' })
    expect(sentEvents[0].events[1].payload).toEqual({ content: 'world' })

    expect(calls.finishTask).toBe(1)
    expect(finishedPayloads[0].output).toBe('hello world')
  })

  it('isolates events and finishes between concurrent runs without crosstalk', async () => {
    const { client, sentEvents, finishedPayloads } = makeStubClient()
    const store = new HttpWorkerStore(client)

    // Two tasks run concurrently
    const run1 = await store.createRun({ taskId: 'task_feature_spec', featureId: 'feat_spec' })
    const run2 = await store.createRun({ taskId: 'task_chat_step', featureId: 'feat_chat' })

    // Task 1 emits spec events
    await store.emitRunEvent(run1, 1, 'text', { content: 'Specifying selector-width' })

    // Task 2 emits chat events
    await store.emitRunEvent(run2, 1, 'reasoning', { thought: 'Researching menu floor' })
    await store.emitRunEvent(run2, 2, 'text', { content: 'Menu floor research findings' })

    // Task 1 emits another spec event
    await store.emitRunEvent(run1, 2, 'text', { content: 'Additional spec content' })

    // Finish task 2 (chat)
    await store.updateRun(run2, { status: 'completed', output: 'Chat output' })

    // Task 2 finish must be for task_chat_step, NOT task_feature_spec
    expect(finishedPayloads).toHaveLength(1)
    expect(finishedPayloads[0].taskId).toBe('task_chat_step')
    expect(finishedPayloads[0].output).toBe('Chat output')

    // Finish task 1 (spec)
    await store.updateRun(run1, { status: 'completed', output: 'Spec output' })

    expect(finishedPayloads).toHaveLength(2)
    expect(finishedPayloads[1].taskId).toBe('task_feature_spec')
    expect(finishedPayloads[1].output).toBe('Spec output')

    // Events for task_feature_spec must ONLY contain spec events
    const specEventsBatch = sentEvents.filter((s: any) => s.taskId === 'task_feature_spec')
    const allSpecPayloads = specEventsBatch.flatMap((s: any) => s.events.map((e: any) => e.payload.content))
    expect(allSpecPayloads).toContain('Specifying selector-width')
    expect(allSpecPayloads).toContain('Additional spec content')
    expect(allSpecPayloads).not.toContain('Menu floor research findings')

    // Events for task_chat_step must ONLY contain chat events
    const chatEventsBatch = sentEvents.filter((s: any) => s.taskId === 'task_chat_step')
    const allChatPayloads = chatEventsBatch.flatMap((s: any) => s.events.map((e: any) => e.payload.content || e.payload.thought))
    expect(allChatPayloads).toContain('Researching menu floor')
    expect(allChatPayloads).toContain('Menu floor research findings')
    expect(allChatPayloads).not.toContain('Specifying selector-width')
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
