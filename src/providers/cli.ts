/**
 * CLI provider execution — pure parsing layer (no process/FS/PB access).
 *
 * Ports the openrouter-agent NDJSON branch of
 * specflow/packages/orchestrator/src/providers/cli.ts (lines 329-435),
 * restricted to the standard protocol vocabulary (spec §4).
 *
 * The Claude (assistant/result), agy (step_update), and other
 * provider-specific branches are deliberately absent — no competing
 * parsing paradigm, no format sniffing, no hardcoded provider names.
 */

export const DEFAULT_TIMEOUT_MS = 1_800_000

export type RunEventType =
  | 'text'
  | 'reasoning'
  | 'tool_call'
  | 'tool_result'
  | 'error'

export interface ProviderEvent {
  type: RunEventType
  payload: Record<string, unknown>
}

export interface ProviderStream {
  resultText: string
  resultError?: string
  tokens: { input: number; output: number } | null
  cost: number | null
}

/**
 * Build the argv array for spawning a CLI provider.
 *
 * Flag order mirrors specflow/packages/orchestrator/src/providers/cli.ts
 * lines 186-196.  No --prompt/-p flag is ever added — the prompt is
 * piped through stdin.
 */
export function buildProviderCmd(input: {
  command: string
  model?: string
  allowedTools?: string[]
}): string[] {
  const tools = input.allowedTools ?? []
  return [
    input.command,
    ...(input.model ? ['--model', input.model] : []),
    '--allowedTools',
    ...(tools.length > 0 ? tools : ['none']),
    '-j',
    '--no-session',
  ]
}

/**
 * Normalise a raw timeout value to milliseconds.
 *
 * - Falsy (undefined / null) → DEFAULT_TIMEOUT_MS
 * - A number < 10 000 is treated as seconds and multiplied by 1 000
 * - A number >= 10 000 is used as-is (already in ms)
 * - A numeric string is coerced via Number() first
 */
export function normalizeTimeout(
  raw?: number | string | null,
): number {
  if (raw === undefined || raw === null || raw === '') {
    return DEFAULT_TIMEOUT_MS
  }
  const n = typeof raw === 'string' ? Number(raw) : raw
  if (Number.isNaN(n) || n === 0) return DEFAULT_TIMEOUT_MS
  return n < 10_000 ? n * 1_000 : n
}

/**
 * Return a line-processing closure that parses NDJSON events from a
 * CLI provider's stdout and feeds them through `emit`.
 *
 * The closure maintains internal state (lastReasoningText) for
 * cumulative-delta reasoning dedup and lastReasoning resets across
 * type boundaries.  Unparseable lines and blank lines are skipped
 * silently (try/catch).
 */
export function createNdjsonParser(
  stream: ProviderStream,
  emit: (e: ProviderEvent) => void,
): (line: string) => void {
  let lastReasoningText = ''

  return function parseLine(line: string): void {
    if (!line.trim()) return

    try {
      const obj = JSON.parse(line)

      if (obj.type === 'text' && typeof obj.delta === 'string') {
        lastReasoningText = ''
        stream.resultText += obj.delta
        emit({ type: 'text', payload: { content: obj.delta } })
      } else if (obj.type === 'reasoning' && typeof obj.delta === 'string') {
        let out = obj.delta
        if (lastReasoningText && obj.delta.startsWith(lastReasoningText)) {
          out = obj.delta.slice(lastReasoningText.length)
        }
        lastReasoningText = obj.delta
        if (!out) return
        emit({ type: 'reasoning', payload: { content: out } })
      } else if (obj.type === 'tool_call') {
        lastReasoningText = ''
        emit({
          type: 'tool_call',
          payload: {
            name: obj.name,
            call_id: obj.callId,
            args: obj.args,
          },
        })
      } else if (obj.type === 'tool_result') {
        lastReasoningText = ''
        emit({
          type: 'tool_result',
          payload: {
            name: obj.name,
            call_id: obj.callId,
            output: obj.output,
          },
        })
      } else if (obj.type === 'error') {
        stream.resultError =
          obj.message ?? obj.error ?? 'CLI error'
      } else if (obj.type === 'done' && obj.usage) {
        lastReasoningText = ''
        stream.tokens = {
          input:
            obj.usage.inputTokens ??
            obj.usage.input_tokens ??
            0,
          output:
            obj.usage.outputTokens ??
            obj.usage.output_tokens ??
            0,
        }
        if (typeof obj.usage.cost === 'number') {
          stream.cost = (stream.cost ?? 0) + obj.usage.cost
        }
      } else if (obj.type === 'agent_end') {
        lastReasoningText = ''
        // usage-neutral terminal marker — no emit
      }
      // turn_end / unknown types → silent no-op
    } catch {
      // skip unparseable lines
    }
  }
}
