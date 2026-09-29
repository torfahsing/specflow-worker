/**
 * Risk R11 — NDJSON lines split across chunk boundaries.
 *
 * Tests the stdout drain logic in src/providers/cli.ts: TextDecoder →
 * append to lineBuffer → split('\n') → pop() remainder → feed complete
 * lines through parser.  Specifically exercises:
 *   • A full line emitted as a single chunk → parsed cleanly.
 *   • A partial line split across two chunks → remainder held, re-assembled
 *     on the next iteration of the async loop.
 *   • Multiple lines in one chunk → all fed sequentially.
 *   • A process killed mid-line → remaining buffer is flushed and parsed
 *     after proc.exited resolves (decoder.decode() flush + trailing
 *     partial-parse).
 */

import { describe, it, expect } from 'bun:test'
import {
  createNdjsonParser,
  type ProviderStream,
} from '../providers/cli'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStream(): ProviderStream {
  return { resultText: '', tokens: null, cost: null }
}

/**
 * Re-implement the exact drain logic from providers/cli.ts (lines ~448-460)
 * so we can assert on individual chunk feeds.
 */
async function feedChunks(
  rawChunks: string[],
): Promise<{ events: unknown[]; stream: ProviderStream }> {
  const stream = makeStream()
  const events: unknown[] = []
  const parser = createNdjsonParser(stream, (e) => events.push(e))

  const decoder = new TextDecoder({ stream: true })
  let lineBuffer = ''

  for (const raw of rawChunks) {
    const buf = Buffer.from(raw)
    lineBuffer += decoder.decode(buf, { stream: true })
    const lines = lineBuffer.split('\n')
    lineBuffer = lines.pop() ?? ''
    for (const line of lines) {
      parser(line)
    }
  }

  // Final flush (same as providers/cli.ts: flush + partial)
  const remaining = decoder.decode()
  lineBuffer += remaining
  if (lineBuffer.trim()) {
    parser(lineBuffer)
  }

  return { events, stream }
}

// ===========================================================================
// Chunk boundary tests
// ===========================================================================

describe('R11 — NDJSON chunk boundary', () => {
  it('full line in a single chunk parses cleanly', async () => {
    const { events } = await feedChunks(['{"type":"text","delta":"hello"}\n'])

    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({ type: 'text', payload: { content: 'hello' } })
  })

  it('partial line split across two chunks reassembles correctly', async () => {
    // First chunk: half the JSON
    // Second chunk: the rest
    const { events } = await feedChunks([
      '{"type":"text","de',
      lta":"hello"}\n',
    ])

    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({ type: 'text', payload: { content: 'hello' } })
  })

  it('multiple lines in one chunk all parsed', async () => {
    const { events } = await feedChunks([
      '{"type":"text","delta":"a"}\n{"type":"text","delta":"b"}\n',
    ])

    expect(events).toHaveLength(2)
    expect((events[0] as any).payload.content).toBe('a')
    expect((events[1] as any).payload.content).toBe('b')
  })

  it('partial line followed by a complete line in the same chunk', async () => {
    const { events } = await feedChunks([
      '{"type":"text","delta":"partial-',
      '"}\n{"type":"text","delta":"next"}\n',
    ])

    // First complete line: text "partial-"
    // Second complete line: text "next"
    expect(events).toHaveLength(2)
    expect((events[0] as any).payload.content).toBe('partial-')
    expect((events[1] as any).payload.content).toBe('next')
  })

  it('process killed mid-line: remaining buffer is flushed and parsed', async () => {
    // Simulate a provider that wrote an incomplete JSON line and then exited.
    // The flush path (decoder.decode() + lineBuffer.trim check) must still
    // attempt to parse whatever remains, which will fail silently (try/catch
    // inside createNdjsonParser).
    const { events } = await feedChunks(['{"type":"te'])

    // No valid event emitted — the truncated JSON was rejected by the parser's
    // try/catch block. This is the expected behaviour (spec: "skip unparseable
    // lines").
    expect(events).toHaveLength(0)
  })

  it('trailing partial line after all chunks: no crash on flush', async () => {
    // Two complete lines and a partial third
    const { events, stream } = await feedChunks([
      '{"type":"text","delta":"first"}\n',
      '{"type":"text","delta":"sec",',
      'ond","delta":""}',
    ])

    // The last chunk completes the second line.
    expect(events).toHaveLength(2)
    expect((events[0] as any).payload.content).toBe('first')
    expect((events[1] as any).payload.content).toBe('second')
    expect(stream.resultText).toBe('firstsecond')
  })

  it('empty chunks do not produce spurious parser calls', async () => {
    const { events } = await feedChunks(['', '', '\n', '{"type":"text","delta":"ok"}\n', ''])

    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({ type: 'text', payload: { content: 'ok' } })
  })

  it('binary data in chunks does not crash the drain', async () => {
    // Non-UTF8 bytes fed through TextDecoder
    const { events } = await feedChunks([
      Buffer.from([0x00, 0xff, 0xfe]).toString('binary'),
      '{"type":"text","delta":"after binary"}\n',
    ])

    // The binary portion is invalid JSON → silently skipped.
    // The valid JSON line is parsed.
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      type: 'text',
      payload: { content: 'after binary' },
    })
  })

  it('newline embedded inside a token: stays on the wrong side of the split', async () => {
    // Line buffer: '{"type":"reasoning","delta":"ab"}\n{...}'
    // The \n after "ab" splits the first reasoning event cleanly;
    // the second starts fresh.
    const { events } = await feedChunks([
      '{"type":"reasoning","delta":"step ',
      'one"}\n{"type":"reasoning","delta":"ste',
      'p ",\n',
      'other":1}',
    ])

    // step one emits; the truncated line {"type":"reasoning","delta":"step 
    // doesn't complete until the next iteration — but there is none left.
    // Actually, "step \n" creates two segments: "step " (complete line? no, not valid JSON) 
    // and "" and the partial '{"type":"reasoning"...' waits.
    // Since nothing else comes, the flush tries to parse the partial and fails silently.
    expect(events).toHaveLength(1)
    expect((events[0] as any).payload.content).toBe('step one')
  })
})
