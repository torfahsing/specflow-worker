/**
 * Risk R15 — Every timer disposed so shutdown exits promptly.
 *
 * Tests that periodic timers are properly managed and disposed:
 *   1. Presence heartbeat starts/stops cleanly.
 *   2. Timer .unref() is called.
 */

import { describe, it, expect } from 'bun:test'
import { Presence } from '../presence'
import type { SpecflowClient } from '../client'

function makeStubClient() {
  const heartbeats: any[] = []
  const client = {
    async heartbeat(payload: any) {
      heartbeats.push(payload)
      return { status: 'ok', worker_id: 'pw_1' }
    },
  } as unknown as SpecflowClient

  return { client, heartbeats }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('R15 — Presence timer disposal', () => {
  it('ensure + start + stop manages lifecycle cleanly', async () => {
    const s = makeStubClient()
    const presence = new Presence(s.client, 'test-worker', ['git'], 50)

    const id = await presence.ensure()
    expect(id).toBe('pw_1')

    presence.start()
    await sleep(60)

    await presence.stop()

    // Stop should have sent offline heartbeat
    const last = s.heartbeats[s.heartbeats.length - 1]
    expect(last.status).toBe('offline')
  })

  it('calling start() twice does not crash', async () => {
    const s = makeStubClient()
    const presence = new Presence(s.client, 'test-worker', ['git'], 50)

    await presence.ensure()
    presence.start()
    presence.start() // no-op

    await sleep(60)
    await presence.stop()
    expect(true).toBe(true)
  })

  it('stop() before start() does not throw', async () => {
    const s = makeStubClient()
    const presence = new Presence(s.client, 'test-worker', ['git'], 50)

    await expect(presence.stop()).resolves.toBeUndefined()
  })

  it('tick after stop() does not overwrite offline status', async () => {
    const s = makeStubClient()
    const presence = new Presence(s.client, 'test-worker', ['git'], 50)

    await presence.ensure()
    presence.setBusy(true)
    await presence.stop()

    const countAtStop = s.heartbeats.length
    await presence.tick()
    // No new tick emitted
    expect(s.heartbeats.length).toBe(countAtStop)
  })

  it('.unref() is called on the heartbeat timer', async () => {
    const s = makeStubClient()
    const presence = new Presence(s.client, 'test-worker', ['git'], 30_000)

    let unrefCalled = false
    const origSetInterval = global.setInterval
    global.setInterval = (...args: any[]) => {
      const timer = (origSetInterval as any).apply(null, args)
      const origUnref = timer.unref.bind(timer)
      timer.unref = () => {
        unrefCalled = true
        return origUnref()
      }
      return timer
    }

    try {
      await presence.ensure()
      presence.start()
      await sleep(10)
      expect(unrefCalled).toBe(true)
    } finally {
      global.setInterval = origSetInterval
      await presence.stop()
    }
  })
})
