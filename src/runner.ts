/**
 * Task execution orchestration — claim → inputs → branch alignment →
 * spawn → stream → finalize matrix.
 *
 * Mirrors the execution loop of specflow/packages/orchestrator/src/workflow/runner.ts
 * with client-side review protection (100k bounded diff, --output-schema staging,
 * fail-closed parsing, and 1-turn JSON repair).
 *
 * Zero provider/model literals in this file (gate #3).
 */

import { tmpdir } from 'node:os'
import path from 'node:path'
import { rm } from 'node:fs/promises'
import type { WorkerStore, RunEventType, RunStatus } from './store.js'
import type { Presence } from './presence.js'
import type { WorkerConfig } from './config.js'
import type { ClaimedTask } from './queue.js'
import type { ProviderRunResult, ProviderStream, ProviderEvent } from './providers/cli.js'
import { RunRecorder } from './events.js'
import type { getCurrentBranch, branchExists, createBranch, checkoutBranch, getBoundedDiff } from './git/utils.js'
import { parseStructuredOutput } from './providers/structured-parser.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunDeps {
  store: WorkerStore
  presence: Presence | any
  config: WorkerConfig | any
  git?: typeof import('./git/utils.js')
  provider?: typeof import('./providers/cli.js').runProvider
}

export interface ExecutionOutcome {
  status: 'done' | 'failed' | 'cancelled'
  runId: string
  error?: string
  output?: any
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function coerceArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string')
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      const parsed = JSON.parse(value)
      if (Array.isArray(parsed)) return parsed.filter((v) => typeof v === 'string')
    } catch {
      // not valid JSON — treat as empty
    }
  }
  return []
}

// ---------------------------------------------------------------------------
// executeClaimedTask
// ---------------------------------------------------------------------------

export async function executeClaimedTask(
  claimed: ClaimedTask,
  deps: RunDeps,
  signal?: AbortSignal,
): Promise<ExecutionOutcome> {
  const effectiveSignal = signal ?? (deps as any).abortSignal ?? (deps as any).signal
  const effectiveConfig = deps.config ?? (deps as any).workerConfig ?? {}
  const { store, presence, git, provider } = deps
  const config = effectiveConfig
  const gitModule = git ?? await import('./git/utils.js')
  const runProviderFn = provider ?? (await import('./providers/cli.js')).runProvider

  const taskId = claimed.id
  const featureId = claimed.featureId
  const record = claimed.record
  const feature = record.expand?.feature ?? {}

  // Step 1: start the run recorder + set presence busy
  const recorder = await RunRecorder.start(store, { taskId, featureId, runId: claimed.runId })
  presence.setBusy(true)

  // Step 2: resolve execution inputs
  let prompt = record.prompt as string | undefined
  const command = record.provider_command as string | undefined
  const models: string[] = Array.isArray(record.models)
    ? record.models
    : (record.model ? [record.model] : [])  // back-compat: old single-model tasks
  const allowedTools = coerceArray(record.allowed_tools)
  const timeoutMs = normalizeTimeout(record.timeout)
  const cwd = (feature.project_dir || record.project_dir) as string | undefined
  const branch = (feature.git_branch || record.git_branch) as string | undefined
  const outputSchema = record.output_schema as Record<string, any> | undefined

  // Step 3: pre-run input failures
  if (!prompt) {
    const error = `Task "${taskId}" has no "prompt" — prompt assembly happens upstream before queueing.`
    await recorder.finalize({ status: 'failed', error })
    await store.updateTask(taskId, { status: 'failed', error })
    presence.setBusy(false)
    return { status: 'failed', runId: recorder.runId, error }
  }

  if (!command) {
    const error = `Task "${taskId}" has no "provider_command".`
    await recorder.finalize({ status: 'failed', error })
    await store.updateTask(taskId, { status: 'failed', error })
    presence.setBusy(false)
    return { status: 'failed', runId: recorder.runId, error }
  }

  if (!cwd) {
    const error = `Feature "${featureId}" has no "project_dir".`
    await recorder.finalize({ status: 'failed', error })
    await store.updateTask(taskId, { status: 'failed', error })
    presence.setBusy(false)
    return { status: 'failed', runId: recorder.runId, error }
  }

  // Step 4: branch alignment
  if (branch) {
    try {
      const current = await gitModule.getCurrentBranch(cwd)
      if (current !== branch) {
        if (!(await gitModule.branchExists(cwd, branch))) {
          console.log(`[git] creating missing branch '${branch}'`)
          await gitModule.createBranch(cwd, branch)
        }
        console.log(`[git] switching to branch '${branch}' (was '${current}')`)
        await gitModule.checkoutBranch(cwd, branch)
      }
    } catch (err) {
      const msg = (err as Error).message
      const error = `Failed to align branch '${branch}' in '${cwd}': ${msg}`
      await recorder.finalize({ status: 'failed', error })
      await store.updateTask(taskId, { status: 'failed', error })
      presence.setBusy(false)
      return { status: 'failed', runId: recorder.runId, error }
    }
  } else {
    console.log(`[git] skipping branch alignment (no branch specified)`)
  }

  // Context protection: check for bounded diff if review task or requested
  if (gitModule.getBoundedDiff && prompt.includes('{{diff}}')) {
    try {
      const diff = await gitModule.getBoundedDiff(cwd, branch ?? null, 100_000)
      prompt = prompt.replace('{{diff}}', diff || '(No changes in branch)')
    } catch (err) {
      console.warn('[git] getBoundedDiff notice:', (err as Error).message)
    }
  }

  // Schema staging: stage output schema locally to enforce structured output
  let stagedSchemaPath: string | undefined
  if (outputSchema && typeof outputSchema === 'object') {
    try {
      stagedSchemaPath = path.join(tmpdir(), `specflow-schema-${taskId}-${Date.now()}.json`)
      await Bun.write(stagedSchemaPath, JSON.stringify(outputSchema, null, 2))
    } catch (err: any) {
      console.warn('[runner] Failed to stage output schema:', err?.message)
    }
  }

  // Step 5: spawn — iterate through models locally, no round-trip per retry
  const controller = new AbortController()
  const abortListener = () => controller.abort()
  if (effectiveSignal) {
    effectiveSignal.addEventListener('abort', abortListener, { once: true })
  }

  const modelsToTry = models.length > 0 ? models : [undefined]  // undefined = provider default
  let result: ProviderRunResult | undefined
  let lastError: string | undefined

  for (let i = 0; i < modelsToTry.length; i++) {
    const model = modelsToTry[i]
    const attempt = `${i + 1}/${modelsToTry.length}`
    console.log(
      `[runner] executeClaimedTask: task=${taskId} feature=${featureId} cwd=${cwd} branch=${branch ?? 'none'} provider=${command} model=${model ?? 'default'} attempt=${attempt} timeout=${timeoutMs / 1000}s`,
    )

    try {
      result = await runProviderFn(
        {
          command,
          model,
          allowedTools,
          prompt,
          cwd,
          timeoutMs,
          signal: controller.signal,
          pathOverride: config.pathOverride,
          extraEnv: config.envValues,
          outputSchemaPath: stagedSchemaPath,
        },
        async (e: ProviderEvent) => {
          await recorder.emit(e.type, e.payload)
        },
      )
      if (!result.error && !result.cancelled) break  // success — stop trying
      lastError = result.error
      if (result.cancelled) break  // aborted — don't try next model
      if (i < modelsToTry.length - 1) {
        console.log(`[runner] model "${model}" failed, trying next model...`)
      }
    } catch (err) {
      lastError = (err as Error).message
      if (i < modelsToTry.length - 1) {
        console.log(`[runner] model "${model}" threw error: ${lastError}, trying next model...`)
      }
    }
  }

  if (!result) {
    if (stagedSchemaPath) await rm(stagedSchemaPath, { force: true }).catch(() => {})
    const error = lastError ?? 'All models failed'
    await recorder.finalize({ status: 'failed', error })
    await store.updateTask(taskId, { status: 'failed', error })
    presence.setBusy(false)
    effectiveSignal?.removeEventListener('abort', abortListener)
    return { status: 'failed', runId: recorder.runId, error }
  }

  // Step 6: classification determines outcome
  if (result.cancelled) {
    if (stagedSchemaPath) {
      await rm(stagedSchemaPath, { force: true }).catch(() => {})
    }
    await recorder.emitTerminalError({
      message: 'Aborted',
      exit_code: result.exitCode,
      signal: result.signalCode,
    })

    await recorder.finalize({ status: 'cancelled' })
    await store.updateTask(taskId, {
      status: 'queued',
      assigned_worker: null,
    })
    presence.setBusy(false)
    effectiveSignal?.removeEventListener('abort', abortListener)
    return { status: 'cancelled', runId: recorder.runId }
  }

  // Step 7: Structured output validation & 1-turn repair
  let parsedStructuredOutput: unknown | undefined
  if (!result.error && outputSchema) {
    try {
      parsedStructuredOutput = parseStructuredOutput(result.stream.resultText, {
        name: 'task-output',
        schema: outputSchema as any,
      })
    } catch (parseErr: any) {
      const reason = parseErr?.message || String(parseErr)
      console.warn(`[runner] Initial structured parse failed for "${taskId}": ${reason}`)

      // Attempt 1-turn JSON repair if text is substantive (>200 chars)
      if (result.stream.resultText.trim().length > 200) {
        console.log(`[runner] Attempting 1-turn JSON repair for task "${taskId}"...`)
        const repairPrompt = `You are a JSON formatting assistant. Your only job is to convert the supplied raw agent output into a single JSON object that satisfies the required JSON Schema.\n- Return ONLY valid JSON. No markdown code blocks, no explanation, no prose before or after.\n- Reformat and repair only. Never add, drop, or reinterpret content.\n\nRAW AGENT OUTPUT TO REPAIR:\n${result.stream.resultText}`

        try {
          const repairResult = await runProviderFn(
            {
              command,
              model: result.model ?? modelsToTry[modelsToTry.length - 1],
              allowedTools: [],
              prompt: repairPrompt,
              cwd,
              timeoutMs: 60_000,
              signal: controller.signal,
              pathOverride: config.pathOverride,
              extraEnv: config.envValues,
              outputSchemaPath: stagedSchemaPath,
            },
            () => {}, // repair turns are not streamed to UI
          )

          if (repairResult && !repairResult.error) {
            parsedStructuredOutput = parseStructuredOutput(repairResult.stream.resultText, {
              name: 'task-output',
              schema: outputSchema as any,
            })
            console.log(`[runner] 1-turn JSON repair succeeded for task "${taskId}"`)
          }
        } catch (repairErr: any) {
          console.warn(`[runner] 1-turn JSON repair failed for "${taskId}":`, repairErr?.message)
        }
      }

      if (parsedStructuredOutput === undefined) {
        result.error = `Failed to produce valid structured output satisfying schema: ${reason}`
      }
    }
  }

  // Cleanup staged schema file
  if (stagedSchemaPath) {
    await rm(stagedSchemaPath, { force: true }).catch(() => {})
  }

  // Step 8: terminal error event for non-cancellation failures
  if (result.error) {
    await recorder.emitTerminalError({
      message: result.error,
      exit_code: result.exitCode,
      signal: result.signalCode,
    })
    await recorder.finalize({ status: 'failed', error: result.error })
    await store.updateTask(taskId, { status: 'failed', error: result.error })
    presence.setBusy(false)
    effectiveSignal?.removeEventListener('abort', abortListener)
    return { status: 'failed', runId: recorder.runId, error: result.error }
  }

  // Clean success path
  const tokens = result.stream.tokens
  const costUsd = result.stream.cost

  await recorder.finalize({
    status: 'completed',
    tokens: tokens
      ? { input: tokens.input, output: tokens.output }
      : undefined,
    costUsd: typeof costUsd === 'number' ? costUsd : undefined,
  })

  await store.updateTask(taskId, {
    status: 'done',
    output: parsedStructuredOutput,
  })
  presence.setBusy(false)
  effectiveSignal?.removeEventListener('abort', abortListener)

  return {
    status: 'done',
    runId: recorder.runId,
    output: parsedStructuredOutput,
  }
}

function normalizeTimeout(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return 1_800_000
  const n = typeof raw === 'string' ? Number(raw) : (raw as number)
  if (Number.isNaN(n) || n === 0) return 1_800_000
  return n < 10_000 ? n * 1_000 : n
}
