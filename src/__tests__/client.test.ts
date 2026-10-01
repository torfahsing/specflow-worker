import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { SpecflowClient } from '../client'

describe('SpecflowClient', () => {
  let server: any
  let baseUrl: string
  const validToken = 'sfw_live_test123456789'
  const recordedRequests: Array<{ method: string; url: string; headers: Record<string, string>; body?: any }> = []

  beforeEach(() => {
    recordedRequests.length = 0
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        const auth = req.headers.get('authorization')
        const headers: Record<string, string> = {}
        req.headers.forEach((v, k) => { headers[k] = v })

        if (url.pathname === '/api/worker/stream') {
          return new Response('event: connected\ndata: {"status":"connected"}\n\n', {
            headers: { 'Content-Type': 'text/event-stream' },
          })
        }

        let body: any
        try {
          body = await req.json()
        } catch {}

        recordedRequests.push({
          method: req.method,
          url: url.pathname,
          headers,
          body,
        })

        if (url.pathname === '/api/worker/heartbeat') {
          return Response.json({ status: 'ok', worker_id: 'wrk_123' })
        }
        if (url.pathname === '/api/worker/tasks/pending') {
          return Response.json({ tasks: [{ id: 'task-1', title: 'Test Task', feature: 'auth' }] })
        }
        if (url.pathname === '/api/worker/tasks/task-1/claim') {
          return Response.json({
            task: { id: 'task-1', title: 'Test Task', feature: 'auth', prompt: 'Do work' },
            run_id: 'run_456',
          })
        }
        if (url.pathname === '/api/worker/tasks/task-1/events') {
          return Response.json({ status: 'ok', count: body?.events?.length || 0 })
        }
        if (url.pathname === '/api/worker/tasks/task-1/finish') {
          return Response.json({ status: 'ok' })
        }

        return new Response('Not found', { status: 404 })
      },
    })
    baseUrl = `http://127.0.0.1:${server.port}`
  })

  afterEach(() => {
    server.stop(true)
  })

  it('sends heartbeat with Bearer token', async () => {
    const client = new SpecflowClient({ baseUrl, token: validToken })
    const res = await client.heartbeat({ worker_name: 'test-node', status: 'online' })

    expect(res.status).toBe('ok')
    expect(res.worker_id).toBe('wrk_123')
    expect(recordedRequests).toHaveLength(1)
    expect(recordedRequests[0]!.headers['authorization']).toBe(`Bearer ${validToken}`)
    expect(recordedRequests[0]!.body.worker_name).toBe('test-node')
  })

  it('fetches pending tasks', async () => {
    const client = new SpecflowClient({ baseUrl, token: validToken })
    const tasks = await client.getPendingTasks()

    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.id).toBe('task-1')
    expect(recordedRequests[0]!.url).toBe('/api/worker/tasks/pending')
  })

  it('claims a task atomically', async () => {
    const client = new SpecflowClient({ baseUrl, token: validToken })
    const res = await client.claimTask('task-1', 'wrk_123')

    expect(res.run_id).toBe('run_456')
    expect(res.task.id).toBe('task-1')
    expect(recordedRequests[0]!.url).toBe('/api/worker/tasks/task-1/claim')
    expect(recordedRequests[0]!.body.worker_id).toBe('wrk_123')
  })

  it('ingests execution stream events', async () => {
    const client = new SpecflowClient({ baseUrl, token: validToken })
    const count = await client.sendEvents('task-1', 'run_456', [
      { sequence: 1, type: 'text', payload: { delta: 'hello' } },
    ])

    expect(count).toBe(1)
    expect(recordedRequests[0]!.url).toBe('/api/worker/tasks/task-1/events')
    expect(recordedRequests[0]!.body.run_id).toBe('run_456')
  })

  it('finalizes a task', async () => {
    const client = new SpecflowClient({ baseUrl, token: validToken })
    await client.finishTask('task-1', {
      run_id: 'run_456',
      status: 'completed',
      output: { ok: true },
    })

    expect(recordedRequests[0]!.url).toBe('/api/worker/tasks/task-1/finish')
    expect(recordedRequests[0]!.body.status).toBe('completed')
  })
})
