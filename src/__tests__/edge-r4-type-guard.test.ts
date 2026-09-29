/**
 * Risk R4 — run_events.type outside RUN_EVENT_TYPES is dropped by the guard.
 *
 * Extends the existing store.test.ts + events.test.ts coverage with edge-case
 * type values that could arise from:
 *   - A buggy provider emitting unexpected NDJSON types.
 *   - Manual PocketBase mutations introducing non-standard types.
 *   - Proto-typing contamination (`Object.prototype`).
 *
 * The guard exists in both RunRecorder.emit() and PocketBaseStore.emitRunEvent()
 * to prevent a silent PB `select` validation rejection from crashing the loop
 * or inserting corrupt data.
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import { RunRecorder } from '../events.js'
import { MemoryWorkerStore, RUN_EVENT_TYPES } from '../store.js'
import type { WorkerStore, RunEventType } from '../store.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStore(): MemoryWorkerStore {
  return new MemoryWorkerStore()
}

class FailingCreateStore implements WorkerStore {
  createRun = async () => { throw new Error('network error') }
  updateRun = async () => {}
  emitRunEvent = async () => {}
  updateTask = async () => {}
}

// ===========================================================================
// RUN_EVENT_TYPES completeness checks
// ===========================================================================

describe('R4 — RUN_EVENT_TYPES completeness', () => {
  it('contains exactly 5 members', () => {
    expect(RUN_EVENT_TYPES.size).toBe(5)
  })

  it('has only the five standard types — no accidental additions', () => {
    const expected = new Set(['text', 'reasoning', 'tool_call', 'tool_result', 'error'])
    // Compare Sets for equality regardless of iteration order
    for (const t of expected) {
      expect(RUN_EVENT_TYPES.has(t)).toBe(true)
    }
    expect(RUN_EVENT_TYPES.size).toBe(expected.size)
  })

  it('excludes all known non-standard protocol types', () => {
    const exclusions = [
      'assistant',       // Claude format (intentionally not ported)
      'result',          // Claude format
      'step_update',     // agy format
      'turn_end',        // OpenRouter spec but no event emitted
      'agent_end',       // OpenRouter spec but usage-neutral
      'unknown_event',   // arbitrary unknown
      '',                // empty string
      '0',               // numeric string disguised as type
      'TEXT',            // wrong case
      'Text',            // PascalCase variant
      'run_event',       // collection name confusion
      'completed',       // runs.status value leaked into type space
      'failed',          // runs.status value
      'queued',          // tasks.status value
    ]
    for (const t of exclusions) {
      expect(RUN_EVENT_TYPES.has(t)).toBe(false)
    }
  })

  it('does not accept Object.prototype-bypassed keys', () => {
    // Ensure has() works even if someone sets prototype pollution.
    // Use String.raw to create the key without TS index-sigil errors.
    const protoKey = '__proto__'
    ;(Object as Record<string, unknown>)['prototype'] = {
      ...((Object as Record<string, unknown>)['prototype'] as Record<string, unknown>),
      [protoKey]: null,
    }
    try {
      expect(RUN_EVENT_TYPES.has(protoKey)).toBe(false)
    } finally {
      delete ((Object as Record<string, unknown>)['prototype'] as Record<string, unknown>)[protoKey]
    }
  }),
})

// ===========================================================================
// RunRecorder guard: invalid types are dropped without side effects
// ===========================================================================

describe('R4 — RunRecorder drops invalid types', () => {
  let store: MemoryWorkerStore
  let recorder: Awaited<ReturnType<typeof RunRecorder.start>>

  beforeEach(async () => {
    store = makeStore()
    recorder = await RunRecorder.start(store, { taskId: 'task_1', featureId: 'feat_1' })
  })

  it('null type is dropped without consuming a sequence number', async () => {
    await (recorder as any).emit(null as any, { content: 'x' })
    await recorder.emit('text', { content: 'hello' })

    expect(store.events).toHaveLength(1)
    expect(store.events[0]!.sequence).toBe(1)
    expect(store.events[0]!.type).toBe('text')
  })

  it('numeric type (from JSON.parse coercion) is dropped', async () => {
    await (recorder as any).emit(42 as any, { content: 'x' })
    await recorder.emit('text', { content: 'hello' })

    expect(store.events).toHaveLength(1)
    expect(store.events[0]!.sequence).toBe(1)
  })

  it('empty string type is dropped', async () => {
    await (recorder as any).emit('' as any, { content: 'x' })
    await recorder.emit('text', { content: 'hello' })

    expect(store.events).toHaveLength(1)
  })

  it('deeply nested object used as type is dropped', async () => {
    await (recorder as any).emit({ toString: () => 'tool_call' } as any, { content: 'x' })
    await recorder.emit('text', { content: 'hello' })

    expect(store.events).toHaveLength(1)
    expect(store.events[0]!.sequence).toBe(1)
  })

  it('array used as type is dropped', async () => {
    await (recorder as any).emit(['text'] as any, { content: 'x' })
    await recorder.emit('text', { content: 'hello' })

    expect(store.events).toHaveLength(1)
  })

  it('undefined type is dropped', async () => {
    await (recorder as any).emit(undefined as any, { content: 'x' })
    await recorder.emit('text', { content: 'hello' })

    expect(store.events).toHaveLength(1)
    expect(store.events[0]!.sequence).toBe(1)
  })

  it('mixed valid and invalid types: sequences remain contiguous', async () => {
    await (recorder as any).emit('assistant' as any, {})
    await recorder.emit('text', { content: 'a' })
    await (recorder as any).emit('claude_format' as any, {})
    await recorder.emit('text', { content: 'b' })
    await (recorder as any).emit(99 as any, {})
    await recorder.emit('reasoning', { content: 'c' })

    expect(store.events).toHaveLength(3)
    // Sequences are 1, 2, 3 — invalid types never consume a sequence.
    expect(store.events.map((e) => e.sequence)).toEqual([1, 2, 3])
  })

  it('invalid type does not break the pending-chain on subsequent emits', async () => {
    await (recorder as any).emit('invalid_type_xyz' as any, {})
    // These should still chain correctly.
    await recorder.emit('text', { content: 'after-invalid-1' })
    await recorder.emit('text', { content: 'after-invalid-2' })

    expect(store.events).toHaveLength(2)
    expect(store.events[0]!.payload.content).toBe('after-invalid-1')
    expect(store.events[1]!.payload.content).toBe('after-invalid-2')
  })
})
