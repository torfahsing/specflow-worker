/**
 * Risk R15 — Every timer disposed so shutdown exits promptly.
 *
 * Tests that periodic timers are properly managed and disposed:
 *   1. Presence heartbeat starts/stops cleanly.
 *   2. Auth watchdog disposes correctly.
 */

import { describe, it, expect } from 'bun:test'
import { Presence } from '../presence'

type PocketBase = any

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStubPbForPresence() {
  const records = new Map<string, any>()
  let getFirstThrows = false
  let createThrows = false
  const pb = {
    collection(_name: string) {
      return {
        getFirstListItem(_filter: string) {
          if (getFirstThrows) throw new Error('not found')
          return Promise.resolve(null)
        },
        update(id: string, data: any) {
          const existing = records.get(id)
          if (!existing) {
            const err = new Error('not found') as any
            err.status = 404
            throw err
          }
          records.set(id, { ...existing, ...data, id })
          return Promise.resolve(records.get(id))
        },
        create(data: any) {
          if (createThrows) throw new Error('network error')
          const id = `pw_${records.size + 1}`
          const record = { id, ...data }
          records.set(id, record)
          return Promise.resolve(record)
        },
      }
    },
  } as unknown as PocketBase

  return {
    pb,
    setGetFirstThrows(v: boolean) { getFirstThrows = v },
    setCreateThrows(v: boolean) { createThrows = v },
    getRecords() { return records },
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// ===========================================================================
// R15 — Presence timer disposal
// ===========================================================================

describe('R15 — Presence timer disposal', () => {
  it('ensure + start + stop manages lifecycle cleanly', async () => {
    const s = makeStubPbForPresence()
    s.setGetFirstThrows(true) // force creation path on ensure()
    const presence = new Presence(s.pb, 'test-worker', ['git'], 50)

    const id = await presence.ensure()
    expect(id).toBeTruthy()

    presence.start()

    // Allow one heartbeat tick
    await sleep(60)
    const recBeforeStop = s.getRecords().get(id)
    expect(recBeforeStop?.status).toBe('online')

    await presence.stop()

    // After stop, status should be offline
    const recAfterStop = s.getRecords().get(id)
    expect(recAfterStop?.status).toBe('offline')
  })

  it('calling start() twice does not crash', async () => {
    const s = makeStubPbForPresence()
    s.setGetFirstThrows(true)
    const presence = new Presence(s.pb, 'test-worker', ['git'], 50)

    const id = await presence.ensure()

    presence.start()
    presence.start() // second call should be a no-op

    await sleep(80)
    const rec = s.getRecords().get(id)!
    expect(rec?.status).toBe('online')

    await presence.stop()
    expect(true).toBe(true) // no exception
  })

  it('stop() before start() does not throw', async () => {
    const s = makeStubPbForPresence()
    s.setGetFirstThrows(true)
    const presence = new Presence(s.pb, 'test-worker', ['git'], 50)

    await expect(presence.stop()).resolves.toBeUndefined()
  })

  it('tick after stop() does not overwrite offline status', async () => {
    const s = makeStubPbForPresence()
    s.setGetFirstThrows(true)
    const presence = new Presence(s.pb, 'test-worker', ['git'], 50)

    const id = await presence.ensure()
    presence.setBusy(true)
    await presence.stop()

    // tick() should short-circuit because stopped flag is true
    await presence.tick()

    const rec = s.getRecords().get(id)!
    // Status remains 'offline' — tick didn't re-apply 'busy'
    expect(rec.status).toBe('offline')
  })

  it('.unref() is called on the heartbeat timer', async () => {
    const s = makeStubPbForPresence()
    s.setGetFirstThrows(true)
    const presence = new Presence(s.pb, 'test-worker', ['git'], 30_000)

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
      const id = await presence.ensure()
      presence.start()
      await sleep(10)
      expect(unrefCalled).toBe(true)
    } finally {
      global.setInterval = origSetInterval
      await presence.stop()
    }
  })
})
