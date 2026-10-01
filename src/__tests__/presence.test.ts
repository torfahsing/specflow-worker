import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { Presence } from '../presence'
import type { SpecflowClient } from '../client'

function makeStubClient() {
  const calls = {
    heartbeat: 0,
  }
  const heartbeats: any[] = []
  let heartbeatThrows = false

  const client = {
    async heartbeat(payload: any) {
      calls.heartbeat++
      if (heartbeatThrows) throw new Error('network down')
      heartbeats.push(payload)
      return { status: 'ok', worker_id: 'worker_123' }
    },
  } as unknown as SpecflowClient

  return {
    client,
    calls,
    heartbeats,
    setHeartbeatThrows(v: boolean) { heartbeatThrows = v },
  }
}

describe('Presence — ensure()', () => {
  it('calls heartbeat with worker_name and online status', async () => {
    const s = makeStubClient()
    const presence = new Presence(s.client, 'my-worker', { git: true })

    const id = await presence.ensure()

    expect(id).toBe('worker_123')
    expect(s.calls.heartbeat).toBe(1)
    expect(s.heartbeats[0]).toEqual({
      worker_name: 'my-worker',
      status: 'online',
      capabilities: { git: true },
    })
    expect(presence.workerId).toBe('worker_123')
  })

  it('handles network error gracefully and returns empty string', async () => {
    const s = makeStubClient()
    s.setHeartbeatThrows(true)
    const presence = new Presence(s.client, 'my-worker')

    const id = await presence.ensure()

    expect(id).toBe('')
    expect(presence.workerId).toBeNull()
  })
})

describe('Presence — setBusy()', () => {
  it('sends busy status via heartbeat', async () => {
    const s = makeStubClient()
    const presence = new Presence(s.client, 'my-worker')
    await presence.ensure()

    presence.setBusy(true)
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(s.calls.heartbeat).toBe(2)
    expect(s.heartbeats[1].status).toBe('busy')
  })

  it('resets to online after setBusy(false)', async () => {
    const s = makeStubClient()
    const presence = new Presence(s.client, 'my-worker')
    await presence.ensure()

    presence.setBusy(true)
    await new Promise((resolve) => setTimeout(resolve, 10))

    presence.setBusy(false)
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(s.calls.heartbeat).toBe(3)
    expect(s.heartbeats[2].status).toBe('online')
  })
})

describe('Presence — start() / tick()', () => {
  it('tick sends heartbeat with current status', async () => {
    const s = makeStubClient()
    const presence = new Presence(s.client, 'my-worker')
    await presence.ensure()

    await presence.tick()

    expect(s.calls.heartbeat).toBe(2)
  })

  it('tick is a no-op after stop', async () => {
    const s = makeStubClient()
    const presence = new Presence(s.client, 'my-worker')
    await presence.ensure()

    await presence.stop()
    expect(s.calls.heartbeat).toBe(2) // ensure + stop(offline)

    await presence.tick()
    expect(s.calls.heartbeat).toBe(2) // no new heartbeat
  })
})

describe('Presence — stop()', () => {
  it('sends offline status and stops timer', async () => {
    const s = makeStubClient()
    const presence = new Presence(s.client, 'my-worker')
    await presence.ensure()

    presence.start()
    await presence.stop()

    expect(s.heartbeats[1].status).toBe('offline')
  })

  it('is idempotent — calling stop twice does not throw', async () => {
    const s = makeStubClient()
    const presence = new Presence(s.client, 'my-worker')
    await presence.ensure()

    await presence.stop()
    await presence.stop()

    expect(true).toBe(true)
  })
})

describe('Presence — capabilities', () => {
  it('forwards custom capabilities to heartbeat', async () => {
    const s = makeStubClient()
    const caps = { git: true, models: [{ id: 'gemini' }] }
    const presence = new Presence(s.client, 'my-worker', caps)
    await presence.ensure()

    expect(s.heartbeats[0].capabilities).toEqual(caps)
  })
})
