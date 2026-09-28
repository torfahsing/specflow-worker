import { describe, it, expect } from 'bun:test'
import {
  createNdjsonParser,
  DEFAULT_TIMEOUT_MS,
  buildProviderCmd,
  normalizeTimeout,
} from '../providers/cli'
import type { ProviderStream } from '../providers/cli'

function makeStream(): ProviderStream {
  return {
    resultText: '',
    tokens: null,
    cost: null,
  }
}

describe('createNdjsonParser — text events', () => {
  it('emits text events with {content} payload', () => {
    const stream = makeStream()
    const events: unknown[] = []
    const parse = createNdjsonParser(stream, (e) => events.push(e))

    parse('{"type":"text","delta":"hello world"}')

    expect(events).toEqual([
      { type: 'text', payload: { content: 'hello world' } },
    ])
    expect(stream.resultText).toBe('hello world')
  })

  it('appends multiple text deltas to resultText', () => {
    const stream = makeStream()
    const parse = createNdjsonParser(stream, () => {})

    parse('{"type":"text","delta":"hello "}')
    parse('{"type":"text","delta":"world"}')

    expect(stream.resultText).toBe('hello world')
  })

  it('resets lastReasoningText on text', () => {
    const stream = makeStream()
    const events: unknown[] = []
    const parse = createNdjsonParser(stream, (e) => events.push(e))

    parse('{"type":"reasoning","delta":"think step 1"}')
    parse('{"type":"text","delta":"response"}')
    parse('{"type":"reasoning","delta":"think step 2"}')

    // First reasoning emits (no prior lastReasoningText)
    // Text resets lastReasoningText
    // Second reasoning emits full delta (no prefix to dedup against)
    expect(events).toHaveLength(3)
    expect((events[2] as any).payload.content).toBe('think step 2')
  })
})

describe('createNdjsonParser — reasoning events', () => {
  it('emits reasoning with cumulative-delta dedup', () => {
    const stream = makeStream()
    const events: unknown[] = []
    const parse = createNdjsonParser(stream, (e) => events.push(e))

    parse('{"type":"reasoning","delta":"A"}')
    parse('{"type":"reasoning","delta":"AB"}')

    expect(events).toHaveLength(2)
    expect((events[0] as any).payload.content).toBe('A')
    expect((events[1] as any).payload.content).toBe('B')
  })

  it('skips emit when delta is fully contained (identical repeat)', () => {
    const stream = makeStream()
    const events: unknown[] = []
    const parse = createNdjsonParser(stream, (e) => events.push(e))

    parse('{"type":"reasoning","delta":"same"}')
    parse('{"type":"reasoning","delta":"same"}')

    expect(events).toHaveLength(1)
  })

  it('resets lastReasoningText on tool_call boundary', () => {
    const stream = makeStream()
    const events: unknown[] = []
    const parse = createNdjsonParser(stream, (e) => events.push(e))

    parse('{"type":"reasoning","delta":"A"}')
    parse('{"type":"tool_call","name":"file_read","callId":"c1","args":{}}')
    parse('{"type":"reasoning","delta":"A"}')

    // After tool_call resets lastReasoningText, the second "A" is a full
    // reasoning delta (no prefix match), so it emits.
    expect(events).toHaveLength(3)
    expect((events[2] as any).payload.content).toBe('A')
  })
})

describe('createNdjsonParser — tool_call / tool_result', () => {
  it('emits tool_call with name, call_id, args', () => {
    const stream = makeStream()
    const events: unknown[] = []
    const parse = createNdjsonParser(stream, (e) => events.push(e))

    parse(
      '{"type":"tool_call","name":"file_read","callId":"call_1","args":{"path":"package.json"}}',
    )

    expect(events).toEqual([
      {
        type: 'tool_call',
        payload: {
          name: 'file_read',
          call_id: 'call_1',
          args: { path: 'package.json' },
        },
      },
    ])
  })

  it('emits tool_result with name, call_id, output', () => {
    const stream = makeStream()
    const events: unknown[] = []
    const parse = createNdjsonParser(stream, (e) => events.push(e))

    parse(
      '{"type":"tool_result","name":"file_read","callId":"call_1","output":"file contents"}',
    )

    expect(events).toEqual([
      {
        type: 'tool_result',
        payload: {
          name: 'file_read',
          call_id: 'call_1',
          output: 'file contents',
        },
      },
    ])
  })

  it('resets lastReasoningText on tool_call and tool_result', () => {
    const stream = makeStream()
    const events: unknown[] = []
    const parse = createNdjsonParser(stream, (e) => events.push(e))

    parse('{"type":"reasoning","delta":"think"}')
    parse('{"type":"tool_call","name":"x","callId":"c","args":{}}')
    // reasoning after tool_call should emit full delta (reset)
    parse('{"type":"reasoning","delta":"think again"}')

    expect(events).toHaveLength(3)
    expect((events[2] as any).payload.content).toBe('think again')
  })
})

describe('createNdjsonParser — error events', () => {
  it('sets resultError from message field', () => {
    const stream = makeStream()
    const events: unknown[] = []
    const parse = createNdjsonParser(stream, (e) => events.push(e))

    parse('{"type":"error","message":"API key invalid"}')

    expect(stream.resultError).toBe('API key invalid')
    expect(events).toHaveLength(0)
  })

  it('sets resultError from error field when message is absent', () => {
    const stream = makeStream()
    const parse = createNdjsonParser(stream, () => {})

    parse('{"type":"error","error":"something broke"}')

    expect(stream.resultError).toBe('something broke')
  })

  it('falls back to "CLI error" when neither message nor error is present', () => {
    const stream = makeStream()
    const parse = createNdjsonParser(stream, () => {})

    parse('{"type":"error"}')

    expect(stream.resultError).toBe('CLI error')
  })
})

describe('createNdjsonParser — done events', () => {
  it('extracts tokens from camelCase usage keys', () => {
    const stream = makeStream()
    const parse = createNdjsonParser(stream, () => {})

    parse(
      '{"type":"done","usage":{"inputTokens":100,"outputTokens":50,"cost":0.01}}',
    )

    expect(stream.tokens).toEqual({ input: 100, output: 50 })
    expect(stream.cost).toBe(0.01)
  })

  it('extracts tokens from snake_case usage keys', () => {
    const stream = makeStream()
    const parse = createNdjsonParser(stream, () => {})

    parse(
      '{"type":"done","usage":{"input_tokens":200,"output_tokens":30}}',
    )

    expect(stream.tokens).toEqual({ input: 200, output: 30 })
  })

  it('accumulates cost across multiple done events', () => {
    const stream = makeStream()
    const parse = createNdjsonParser(stream, () => {})

    parse(
      '{"type":"done","usage":{"inputTokens":10,"outputTokens":5,"cost":0.01}}',
    )
    parse(
      '{"type":"done","usage":{"inputTokens":20,"outputTokens":10,"cost":0.02}}',
    )

    expect(stream.cost).toBe(0.03)
    // tokens take the last done event
    expect(stream.tokens).toEqual({ input: 20, output: 10 })
  })

  it('agent_end after done does not double-count cost', () => {
    const stream = makeStream()
    const parse = createNdjsonParser(stream, () => {})

    parse(
      '{"type":"done","usage":{"inputTokens":10,"outputTokens":5,"cost":0.01}}',
    )
    parse('{"type":"agent_end"}')
    // agent_end should not change cost or tokens
    expect(stream.cost).toBe(0.01)
    expect(stream.tokens).toEqual({ input: 10, output: 5 })
  })
})

describe('createNdjsonParser — agent_end', () => {
  it('is usage-neutral and resets lastReasoningText', () => {
    const stream = makeStream()
    const events: unknown[] = []
    const parse = createNdjsonParser(stream, (e) => events.push(e))

    parse('{"type":"reasoning","delta":"think"}')
    parse('{"type":"agent_end"}')
    parse('{"type":"reasoning","delta":"think again"}')

    // agent_end resets lastReasoningText, so the second reasoning
    // is a full delta (not a prefix of the first) and emits.
    // agent_end itself emits nothing (usage-neutral).
    expect(events).toHaveLength(2)
    expect((events[1] as any).payload.content).toBe('think again')
  })
})

describe('createNdjsonParser — turn_end / unknown / malformed', () => {
  it('ignores turn_end (no emit, no state change)', () => {
    const stream = makeStream()
    const events: unknown[] = []
    const parse = createNdjsonParser(stream, (e) => events.push(e))

    parse('{"type":"turn_end"}')

    expect(events).toHaveLength(0)
    expect(stream.resultText).toBe('')
  })

  it('skips unknown types silently', () => {
    const stream = makeStream()
    const events: unknown[] = []
    const parse = createNdjsonParser(stream, (e) => events.push(e))

    parse('{"type":"unknown_event","foo":"bar"}')

    expect(events).toHaveLength(0)
  })

  it('skips malformed JSON silently (no throw)', () => {
    const stream = makeStream()
    const parse = createNdjsonParser(stream, () => {})

    expect(() => parse('not json')).not.toThrow()
  })

  it('skips empty lines silently', () => {
    const stream = makeStream()
    const events: unknown[] = []
    const parse = createNdjsonParser(stream, (e) => events.push(e))

    parse('')
    parse('   ')

    expect(events).toHaveLength(0)
  })
})

describe('createNdjsonParser — integration: full sequence', () => {
  it('processes a realistic event sequence correctly', () => {
    const stream = makeStream()
    const events: unknown[] = []
    const parse = createNdjsonParser(stream, (e) => events.push(e))

    parse('{"type":"reasoning","delta":"Let me check"}')
    parse('{"type":"text","delta":"Here is the result."}')
    parse(
      '{"type":"tool_call","name":"file_read","callId":"c1","args":{"path":"/dev/null"}}',
    )
    parse(
      '{"type":"tool_result","name":"file_read","callId":"c1","output":"(empty)"}',
    )
    parse(
      '{"type":"done","usage":{"inputTokens":10,"outputTokens":20,"cost":0.005}}',
    )

    // done events update stream.tokens/stream.cost but do NOT emit ProviderEvents
    expect(events).toHaveLength(4)
    expect(events[0]).toEqual({
      type: 'reasoning',
      payload: { content: 'Let me check' },
    })
    expect(events[1]).toEqual({
      type: 'text',
      payload: { content: 'Here is the result.' },
    })
    expect(events[2]).toEqual({
      type: 'tool_call',
      payload: {
        name: 'file_read',
        call_id: 'c1',
        args: { path: '/dev/null' },
      },
    })
    expect(events[3]).toEqual({
      type: 'tool_result',
      payload: {
        name: 'file_read',
        call_id: 'c1',
        output: '(empty)',
      },
    })
    expect(stream.tokens).toEqual({ input: 10, output: 20 })
    expect(stream.cost).toBe(0.005)
  })
})
