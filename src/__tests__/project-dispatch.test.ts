/**
 * Dispatch-level integration tests for the `project:inspect_codebase` control action.
 *
 * src/__tests__/project.test.ts covers inspectCodebase() in isolation. The
 * dispatcher itself (`handleControl` in src/cli.ts) is a closure created inside
 * runDaemon() and is not exported, so it cannot be imported by a unit test.
 * These tests therefore drive the real daemon entrypoint as a subprocess
 * against a hermetic fake orchestrator (Bun.serve on port 0) that speaks only
 * the three endpoints the daemon uses:
 *   POST /api/worker/heartbeat       -> registration / presence
 *   GET  /api/worker/stream          -> SSE `worker_control` events
 *   POST /api/worker/query-response  -> captured answers
 *
 * This closes the gap for spec acceptance criteria 4 (structured briefing in
 * exactly one query-response), 6 (unknown project:* action answered, missing
 * queryId silently dropped), and the observable half of criterion 7: the
 * daemon's only side effects are HTTP calls to the fake orchestrator, so the
 * request log plus stdout prove that no provider process was spawned and no git
 * command ran.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

interface CapturedQueryResponse {
  queryId?: string
  result?: unknown
  error?: string | null
}

const READY_TIMEOUT_MS = 25_000
const RESPONSE_TIMEOUT_MS = 15_000

const ALLOWED_PATHS = new Set(['/api/worker/heartbeat', '/api/worker/stream', '/api/worker/query-response'])

let server: any = null
let proc: any = null
let baseUrl = ''
let sandboxDir = ''
let repoDir = ''
let sseController: ReadableStreamDefaultController<Uint8Array> | null = null
let markSseConnected: () => void = () => {}
const sseConnected: Promise<void> = new Promise((resolve) => { markSseConnected = resolve })

const stdoutChunks: string[] = []
const stderrChunks: string[] = []
const queryResponses: CapturedQueryResponse[] = []
const requestPaths: string[] = []

function stdoutText(): string {
  return stdoutChunks.join('')
}

function stderrText(): string {
  return stderrChunks.join('')
}

function diagnostics(label: string): string {
  return `--- ${label} ---\nstdout:\n${stdoutText()}\nstderr:\n${stderrText()}\nrequests:\n${requestPaths.join('\n')}`
}

async function drain(stream: ReadableStream<Uint8Array>, sink: string[]): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    sink.push(decoder.decode(value, { stream: true }))
  }
}

async function waitFor(condition: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const startedAt = Date.now()
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}.${diagnostics(label)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** Emit one `worker_control` event on the live SSE stream, exactly as the orchestrator would. */
function sendControl(payload: Record<string, unknown>): void {
  if (!sseController) throw new Error('SSE stream is not connected yet')
  const frame = `event: worker_control\ndata: ${JSON.stringify(payload)}\n\n`
  sseController.enqueue(new TextEncoder().encode(frame))
}

/** Await the next query-response captured for a specific queryId. */
async function askAndCapture(queryId: string, payload: Record<string, unknown>): Promise<CapturedQueryResponse> {
  const before = queryResponses.length
  sendControl({ queryId, ...payload })
  await waitFor(() => queryResponses.length > before, RESPONSE_TIMEOUT_MS, `query-response for ${queryId}`)
  return queryResponses[before] as CapturedQueryResponse
}

function responsesFor(queryId: string): CapturedQueryResponse[] {
  return queryResponses.filter((r) => r?.queryId === queryId)
}

beforeAll(async () => {
  sandboxDir = await mkdtemp(path.join(tmpdir(), 'specflow-worker-project-dispatch-'))
  repoDir = path.join(sandboxDir, 'repo')
  await mkdir(path.join(repoDir, 'src'), { recursive: true })
  await writeFile(path.join(repoDir, 'package.json'), '{"name":"demo","version":"1.0.0"}', 'utf8')
  await writeFile(path.join(repoDir, 'tsconfig.json'), '{\n  "compilerOptions": {\n    "strict": true\n  }\n}\n', 'utf8')
  await writeFile(path.join(repoDir, 'src/index.ts'), 'export const greeting = "hi"\n', 'utf8')

  server = Bun.serve({
    port: 0,
    async fetch(req: Request) {
      const url = new URL(req.url)
      requestPaths.push(url.pathname)

      if (url.pathname === '/api/worker/heartbeat') {
        return Response.json({ status: 'ok', worker_id: 'wrk_project_dispatch_test' })
      }

      if (url.pathname === '/api/worker/stream') {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            sseController = controller
            markSseConnected()
          },
        })
        return new Response(stream, {
          headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
        })
      }

      if (url.pathname === '/api/worker/query-response') {
        let body: CapturedQueryResponse | null = null
        try {
          body = (await req.json()) as CapturedQueryResponse
        } catch {
          body = null
        }
        queryResponses.push(body as CapturedQueryResponse)
        return Response.json({ status: 'ok' })
      }

      return new Response('not found', { status: 404 })
    },
  })
  baseUrl = `http://127.0.0.1:${(server as any).port}`

  // HOME/SPECFLOW_DIR/cwd are redirected into the sandbox so the daemon can
  // never read or write the developer's real ~/.specflow/worker.env.
  const cliPath = path.join(import.meta.dir, '..', 'cli.ts')
  proc = Bun.spawn([process.execPath, cliPath, 'start'], {
    cwd: sandboxDir,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      SPECFLOW_URL: baseUrl,
      SPECFLOW_TOKEN: 'sfw_live_dispatchtesttoken',
      SPECFLOW_DIR: sandboxDir,
      HOME: sandboxDir,
    },
  })

  const drainStdout = drain(proc.stdout as ReadableStream<Uint8Array>, stdoutChunks)
  const drainStderr = drain(proc.stderr as ReadableStream<Uint8Array>, stderrChunks)

  await waitFor(() => stdoutText().includes('[worker] registered'), READY_TIMEOUT_MS, 'daemon registration')
  await sseConnected
  await waitFor(
    () => stdoutText().includes('SSE subscription established'),
    READY_TIMEOUT_MS,
    'daemon SSE subscription',
  )

  void drainStdout
  void drainStderr
}, READY_TIMEOUT_MS + 10_000)

afterAll(async () => {
  if (proc) {
    try {
      proc.kill()
    } catch {}
    await Promise.race([proc.exited, new Promise((resolve) => setTimeout(resolve, 3_000))])
  }
  if (sseController) {
    try {
      sseController.close()
    } catch {}
  }
  if (server) server.stop(true)
  if (sandboxDir) await rm(sandboxDir, { recursive: true, force: true })
})

describe('project:inspect_codebase dispatch (real handleControl over SSE)', () => {
  it('answers an inspect_codebase query with manifests, configs and snippets in ONE query-response', async () => {
    const captured = await askAndCapture('q_inspect_basic', {
      action: 'project:inspect_codebase',
      dir: repoDir,
    })

    expect(captured.queryId).toBe('q_inspect_basic')
    expect(captured.error ?? null).toBeFalsy()

    const result = captured.result as any
    expect(result).toBeObject()
    expect(result.dir).toBe(repoDir)

    // Spec §6.4 — the three sections, each with relative paths and raw content.
    expect(result.manifests).toEqual([
      { path: 'package.json', content: '{"name":"demo","version":"1.0.0"}', truncated: false },
    ])
    expect(result.configs).toEqual([
      {
        path: 'tsconfig.json',
        content: '{\n  "compilerOptions": {\n    "strict": true\n  }\n}\n',
        truncated: false,
      },
    ])
    expect(result.snippets).toEqual([
      {
        path: 'src/index.ts',
        language: 'typescript',
        content: 'export const greeting = "hi"\n',
        truncated: false,
      },
    ])

    // Exactly one round trip — one POST per queryId, no partial/streamed answers.
    expect(responsesFor('q_inspect_basic').length).toBe(1)
  }, RESPONSE_TIMEOUT_MS + 5_000)

  it('forwards maxBytes and maxSnippets from the wire through to the result bounds', async () => {
    const captured = await askAndCapture('q_inspect_bounds', {
      action: 'project:inspect_codebase',
      dir: repoDir,
      maxBytes: 12,
      maxSnippets: 1,
    })

    const result = captured.result as any
    expect(result).toBeObject()

    for (const file of [
      ...(result.manifests as any[]),
      ...(result.configs as any[]),
      ...(result.snippets as any[]),
    ]) {
      expect(file.content.length).toBeLessThanOrEqual(12)
      expect(file.truncated).toBeTrue()
    }
    expect(result.snippets.length).toBe(1)
    expect(result.snippets[0].path).toBe('src/index.ts')
  }, RESPONSE_TIMEOUT_MS + 5_000)

  it('answers an unknown project:* action instead of hanging', async () => {
    const captured = await askAndCapture('q_unknown', {
      action: 'project:bogus',
      dir: repoDir,
    })

    expect(captured.queryId).toBe('q_unknown')
    expect(captured.result).toBeNull()
    expect(captured.error).toBe('Unknown project action: project:bogus')
    expect(responsesFor('q_unknown').length).toBe(1)
  }, RESPONSE_TIMEOUT_MS + 5_000)

  it('silently drops a project: action with no queryId, without blocking the stream', async () => {
    const before = queryResponses.length

    // No queryId: the guard must return without answering...
    sendControl({ action: 'project:inspect_codebase', dir: repoDir })
    // ...so this sentinel on the same live stream must be the ONLY new response.
    const sentinel = await askAndCapture('q_sentinel_after_drop', {
      action: 'project:inspect_codebase',
      dir: repoDir,
    })

    expect(sentinel.queryId).toBe('q_sentinel_after_drop')
    const newOnes = queryResponses.slice(before)
    expect(newOnes.length).toBe(1)
    expect(newOnes.every((r) => r?.queryId === 'q_sentinel_after_drop')).toBeTrue()
    expect(queryResponses.some((r) => r && r.queryId === undefined)).toBeFalse()
  }, RESPONSE_TIMEOUT_MS + 5_000)

  it('reads a real non-git directory without any git command or provider run', async () => {
    // repoDir is a plain temp directory: not a git repo, no provider configured.
    const captured = await askAndCapture('q_no_side_effects', {
      action: 'project:inspect_codebase',
      dir: repoDir,
    })
    expect((captured.result as any).manifests.length).toBe(1)

    // Only the three protocol endpoints were ever contacted — in particular no
    // /api/worker/tasks/* run or event ingestion calls.
    const unexpected = requestPaths.filter((p) => !ALLOWED_PATHS.has(p))
    expect(unexpected).toEqual([])

    // A task execution would log [runner]/run_task lines; an inspection must not.
    const logs = stdoutText() + stderrText()
    expect(logs.includes('[runner]')).toBeFalse()
    expect(logs.includes('run_task')).toBeFalse()
    expect(logs.includes('chat_step')).toBeFalse()
  }, RESPONSE_TIMEOUT_MS + 5_000)

  it('reports the contract failure shape for an unknown action and keeps answering later queries', async () => {
    const bogus = await askAndCapture('q_bogus_two', { action: 'project:nope', dir: repoDir })
    expect(bogus.error).toBe('Unknown project action: project:nope')

    // The namespace branch must not swallow the stream: a follow-up still works.
    const followUp = await askAndCapture('q_follow_up', { action: 'project:inspect_codebase', dir: repoDir })
    expect((followUp.result as any).snippets[0].language).toBe('typescript')
  }, (RESPONSE_TIMEOUT_MS + 5_000) * 2)

  it('returns empty sections for a nonexistent dir over the wire, as a success (not an error)', async () => {
    const captured = await askAndCapture('q_missing_dir', {
      action: 'project:inspect_codebase',
      dir: path.join(sandboxDir, 'does-not-exist'),
    })

    expect(captured.error ?? null).toBeFalsy()
    expect(captured.result).toEqual({
      dir: path.join(sandboxDir, 'does-not-exist'),
      manifests: [],
      configs: [],
      snippets: [],
    })
  }, RESPONSE_TIMEOUT_MS + 5_000)
})
