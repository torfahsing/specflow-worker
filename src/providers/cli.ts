/**
 * CLI provider execution — parsing layer + spawn layer (no process/FS/PB
 * access beyond Bun.spawn, which is Bun-native and not an external dependency).
 *
 * Ports the openrouter-agent NDJSON branch of
 * specflow/packages/orchestrator/src/providers/cli.ts (lines 329-435),
 * restricted to the standard protocol vocabulary (spec §4).
 *
 * The spawn layer (resolveProviderCommand + runProvider) replaces
 * node:child_process with Bun.spawn (signal/timeout/stdin pipes).
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
  outputSchemaPath?: string
  args?: string[]
}): string[] {
  const tools = input.allowedTools ?? []
  return [
    input.command,
    ...(input.args ?? []),
    ...(input.model ? ['--model', input.model] : []),
    '--allowedTools',
    ...(tools.length > 0 ? tools : ['none']),
    ...(input.outputSchemaPath ? ['--output-schema', input.outputSchemaPath] : []),
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
        const costVal = obj.usage.cost ?? obj.usage.cost_usd ?? obj.cost ?? obj.cost_usd
        if (typeof costVal === 'number') {
          stream.cost = (stream.cost ?? 0) + costVal
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

// ---------------------------------------------------------------------------
// Spawn layer (Bun.spawn — replaces node:child_process)
// ---------------------------------------------------------------------------

export interface ProviderRunInput {
  command: string
  model?: string
  allowedTools?: string[]
  prompt: string
  cwd: string
  timeoutMs: number
  signal: AbortSignal
  pathOverride?: string
  extraEnv?: Record<string, string>
  outputSchemaPath?: string
  args?: string[]
}

export interface ProviderRunResult {
  exitCode: number
  signalCode: string | null
  cancelled: boolean
  timedOut: boolean
  error?: string
  stream: ProviderStream
}

/**
 * Resolve a provider executable via Bun.which.
 *
 * Absolute paths pass through unchanged (Bun.which treats them as
 * direct paths rather than PATH lookups).  Returns null when the
 * command cannot be resolved, so callers can fail fast before
 * any spawn attempt.
 */
export function resolveProviderCommand(
  command: string,
  pathOverride?: string,
): string | null {
  return Bun.which(command, pathOverride ? { PATH: pathOverride } : undefined)
}

/**
 * Spawn a CLI provider, pipe the prompt through stdin, stream NDJSON
 * events from stdout through `onEvent`, buffer stderr, and classify
 * the exit.
 *
 * The caller owns the AbortController (passed as `input.signal`).
 * This module never creates an AbortController — it only consumes
 * the signal it receives.
 *
 * Exit classification follows the exact order from the spec:
 *   1. cancelled (signal aborted, not a timeout)
 *   2. Error:-prefixed resultText promotion
 *   3. stream.resultError (from NDJSON error event)
 *   4. non-zero exit / signal → timeout or stderr-tail error
 *   5. success (exitCode 0, no error)
 */
export async function runProvider(
  input: ProviderRunInput,
  onEvent: (e: ProviderEvent) => Promise<void> | void,
): Promise<ProviderRunResult> {
  const command = input.command
  const model = input.model
  const allowedTools = input.allowedTools ?? []
  const prompt = input.prompt
  const cwd = input.cwd
  const timeoutMs = input.timeoutMs
  const signal = input.signal
  const pathOverride = input.pathOverride
  const extraEnv = input.extraEnv ?? {}

  // --- Command resolution (fail fast, no spawn) ---
  const resolved = resolveProviderCommand(command, pathOverride)
  if (resolved === null) {
    return {
      exitCode: -1,
      signalCode: null,
      cancelled: false,
      timedOut: false,
      error: `Provider executable "${command}" not found in PATH.`,
      stream: {
        resultText: '',
        tokens: null,
        cost: null,
      },
    }
  }

  // --- Build argv ---
  const cmd = buildProviderCmd({
    command: resolved,
    model,
    allowedTools,
    outputSchemaPath: input.outputSchemaPath,
    args: input.args,
  })

  // --- Spawn ---
  const proc = Bun.spawn({
    cmd,
    cwd,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      ...extraEnv,
      ...(pathOverride ? { PATH: pathOverride } : {}),
    },
    signal,
    timeout: timeoutMs,
  })

  let killEscalationTimer: any = null
  const onAbort = () => {
    try {
      console.log(`[cli] abort signal triggered — terminating child process (SIGTERM)`)
      proc.kill('SIGTERM')
      killEscalationTimer = setTimeout(() => {
        try {
          console.log(`[cli] child process still alive after 1.5s — escalating to SIGKILL`)
          proc.kill('SIGKILL')
        } catch {}
      }, 1500)
      killEscalationTimer.unref?.()
    } catch {}
  }
  if (signal.aborted) {
    onAbort()
  } else {
    signal.addEventListener('abort', onAbort, { once: true })
  }

  // --- Write prompt to stdin (EPIPE-safe) ---
  try {
    proc.stdin.write(prompt)
    proc.stdin.end()
  } catch {
    // child died before we could write — proceed to wait for exit
  }

  // --- Pre-armed timeout timer (mirrors cli.ts:235-238) ---
  let didTimeout = false
  const timeoutTimer = setTimeout(() => {
    didTimeout = true
  }, Math.max(0, timeoutMs - 500))

  // --- Diagnostics: spawn line ---
  const redactedArgs = cmd
    .map((a) => (a.length > 500 ? '<prompt>' : a))
    .join(' ')
  console.log(
    `[cli] spawning: ${command} ${redactedArgs} <${prompt.length} chars> (via stdin) timeout=${timeoutMs / 1000}s cwd=${cwd}`,
  )

  // --- Stream stdout through NDJSON parser ---
  const stream: ProviderStream = {
    resultText: '',
    tokens: null,
    cost: null,
  }
  const parser = createNdjsonParser(stream, onEvent)
  const decoder = new TextDecoder('utf-8')
  let lineBuffer = ''

  // Drain stdout chunk-by-chunk
  const stdoutDrain = (async () => {
    try {
      for await (const chunk of proc.stdout) {
        lineBuffer += decoder.decode(chunk, { stream: true })
        const lines = lineBuffer.split('\n')
        lineBuffer = lines.pop() ?? ''
        for (const line of lines) {
          parser(line)
        }
      }
    } catch {
      // stdout stream ended or was aborted — nothing more to read
    }
  })()

  // --- Drain stderr concurrently ---
  let stderr = ''
  const stderrDecoder = new TextDecoder('utf-8')
  const stderrDrain = (async () => {
    try {
      for await (const chunk of proc.stderr) {
        stderr += stderrDecoder.decode(chunk, { stream: true })
      }
      stderr += stderrDecoder.decode()
    } catch {
      // stderr stream ended or was aborted
    }
  })()

  // --- Wait for process exit and streams to drain ---
  const [exitCode] = await Promise.all([proc.exited, stdoutDrain, stderrDrain])
  const signalCode = proc.signalCode

  // --- Flush any remaining partial line ---
  const remaining = decoder.decode()
  lineBuffer += remaining
  if (lineBuffer.trim()) {
    parser(lineBuffer)
  }

  // --- Clear timeout timer and abort handlers ---
  clearTimeout(timeoutTimer)
  signal.removeEventListener('abort', onAbort)
  if (killEscalationTimer) clearTimeout(killEscalationTimer)

  // --- Diagnostics: exit line ---
  const resultChars = stream.resultText.length
  const stderrChars = stderr.length
  console.log(
    `[cli] process exited: code=${exitCode} signal=${signalCode ?? 'none'} result=${resultChars}chars stderr=${stderrChars}chars`,
  )

  // --- Classification (exact order from spec) ---
  // 1. Cancelled: signal aborted but NOT a timeout
  const cancelled = signal.aborted && !didTimeout
  if (cancelled) {
    return {
      exitCode,
      signalCode,
      cancelled: true,
      timedOut: false,
      error: 'Aborted',
      stream,
    }
  }

  // 2. Error:-prefixed resultText promotion
  if (stream.resultText.trim().startsWith('Error:')) {
    stream.resultError = stream.resultText.trim()
  }

  // 3. stream.resultError wins
  if (stream.resultError) {
    return {
      exitCode,
      signalCode,
      cancelled: false,
      timedOut: false,
      error: stream.resultError,
      stream,
    }
  }

  // 4. Non-zero exit or signal
  if (exitCode !== 0 || signalCode !== null) {
    const timedOut =
      didTimeout || exitCode === 143 || signalCode === 'SIGTERM'
    if (timedOut) {
      const seconds = Math.round(timeoutMs / 1000)
      return {
        exitCode,
        signalCode,
        cancelled: false,
        timedOut: true,
        error: `Agent killed (timeout) — execution exceeded ${seconds}s timeout. Increase role timeout if needed.`,
        stream,
      }
    }
    const tail = stderr.length > 2000 ? stderr.slice(-2000) : stderr
    if (stderr.trim()) {
      console.error('[cli] stderr (tail): ' + tail)
    }
    const errorMsg = stderr.trim()
      ? tail.trim()
      : `CLI process exited with code ${exitCode}`
    return {
      exitCode,
      signalCode,
      cancelled: false,
      timedOut: false,
      error: errorMsg,
      stream,
    }
  }

  // 5. Success
  return {
    exitCode,
    signalCode,
    cancelled: false,
    timedOut: false,
    stream,
  }
}
