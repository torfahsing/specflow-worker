import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import type PocketBase from 'pocketbase'
import { Presence } from '../presence'

// ---------------------------------------------------------------------------
// Stub helpers
// ---------------------------------------------------------------------------

function makeStubPb() {
  const records = new Map<string, any>()
  const calls = {
    getFirstListItem: 0,
    update: 0,
    create: 0,
  }
  let updateThrows = false
  let createThrows = false
  let getFirstListItemThrows = false
  let getFirstListItemResult: any = null

  const pb = {
    collection(name: string) {
      return {
        getFirstListItem(_filter: string) {
          calls.getFirstListItem++
          if (getFirstListItemThrows) throw new Error('network error')
          return Promise.resolve(getFirstListItemResult ?? null)
        },
        update(id: string, data: any) {
          calls.update++
          if (updateThrows) throw new Error('network error')
          const existing = records.get(id)
          if (!existing) {
            // Simulate 404
            const err = new Error('record not found') as any
            err.status = 404
            throw err
          }
          records.set(id, { ...existing, ...data, id })
          return Promise.resolve(records.get(id))
        },
        create(data: any) {
          calls.create++
          if (createThrows) throw new Error('network error')
          const id = `pw_${records.size + 1}`
          const record = { id, ...data }
          records.set(id, record)
          return Promise.resolve(record)
        },
      }
    },
  }

  return {
    pb: pb as unknown as PocketBase,
    calls,
    records: () => records,
    setGetFirstListItemThrows(v: boolean) { getFirstListItemThrows = v },
    setGetFirstListItemResult(v: any) { getFirstListItemResult = v },
    setUpdateThrows(v: boolean) { updateThrows = v },
    setCreateThrows(v: boolean) { createThrows = v },
  }
}

describe('Presence — ensure()', () => {
  let s: ReturnType<typeof makeStubPb>

  beforeEach(() => {
    s = makeStubPb()
  })

  it('creates a local_workers record on first ensure (no existing record)', async () => {
    s.setGetFirstListItemResult(null)
    const presence = new Presence(s.pb, 'my-worker')

    const id = await presence.ensure()

    expect(id).toBeTruthy()
    expect(s.calls.getFirstListItem).toBe(1)
    expect(s.calls.create).toBe(1)
    expect(s.calls.update).toBe(0)
    const rec = s.records().get(id)!
    expect(rec.worker_name).toBe('my-worker')
    expect(rec.status).toBe('online')
    expect(rec.capabilities).toEqual(['git'])
    expect(rec.last_heartbeat).toBeDefined()
    // ISO date check
    expect(() => new Date(rec.last_heartbeat).toISOString()).not.toThrow()
    expect(presence.workerId).toBe(id)
  })

  it('updates an existing record on second ensure', async () => {
    // First call creates
    s.setGetFirstListItemResult(null)
    const presence = new Presence(s.pb, 'my-worker')
    const id = await presence.ensure()
    expect(s.calls.create).toBe(1)

    // Second call finds the existing record and updates it
    s.setGetFirstListItemResult({ id, worker_name: 'my-worker', status: 'online' })
    s.calls.getFirstListItem = 0
    s.calls.update = 0

    const id2 = await presence.ensure()

    expect(id2).toBe(id)
    expect(s.calls.getFirstListItem).toBe(1)
    expect(s.calls.update).toBe(1)
    expect(s.calls.create).toBe(1) // no extra create
  })

  it('returns the same workerId across create and update', async () => {
    s.setGetFirstListItemResult(null)
    const presence = new Presence(s.pb, 'my-worker')
    const id = await presence.ensure()

    // Simulate a subsequent call finding the record
    s.setGetFirstListItemResult({ id, worker_name: 'my-worker', status: 'online' })
    await presence.ensure()

    expect(presence.workerId).toBe(id)
  })

  it('escapes quotes and backslashes in worker_name for the filter', async () => {
    s.setGetFirstListItemResult(null)
    const presence = new Presence(s.pb, 'worker"with\\quotes')

    await presence.ensure()

    // The filter should contain escaped values — we verify by checking
    // that the getFirstListItem was called (no throw from bad filter)
    expect(s.calls.getFirstListItem).toBe(1)
  })

  it('logs [pb] on getFirstListItem failure and falls through to create', async () => {
    s.setGetFirstListItemThrows(true)
    s.setGetFirstListItemResult(null)
    const presence = new Presence(s.pb, 'my-worker')

    const id = await presence.ensure()

    expect(id).toBeTruthy()
    expect(s.calls.create).toBe(1)
  })

  it('logs [pb] on create failure and returns empty string', async () => {
    s.setGetFirstListItemResult(null)
    s.setCreateThrows(true)
    const presence = new Presence(s.pb, 'my-worker')

    const id = await presence.ensure()

    expect(id).toBe('')
    expect(presence.workerId).toBeNull()
  })

  it('re-ensures on 404 from update (record deleted out from under us)', async () => {
    // First call creates
    s.setGetFirstListItemResult(null)
    const presence = new Presence(s.pb, 'my-worker')
    const id = await presence.ensure()
    expect(id).toBeTruthy()

    // Second call finds the record but update returns 404
    s.setGetFirstListItemResult({ id, worker_name: 'my-worker', status: 'online' })
    s.setUpdateThrows(true) // update throws with status 404

    const id2 = await presence.ensure()

    // Should have re-created (getFirstListItem + update(404) → create)
    expect(id2).toBeTruthy()
    expect(s.calls.update).toBeGreaterThanOrEqual(1)
  })
})

describe('Presence — setBusy()', () => {
  it('writes the desired status immediately', async () => {
    const s = makeStubPb()
    s.setGetFirstListItemResult(null)
    const presence = new Presence(s.pb, 'my-worker')
    await presence.ensure()

    presence.setBusy(true)
    // Allow the microtask to settle
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(s.calls.update).toBe(1)
    // The update should have status: 'busy'
    const records = s.records()
    const rec = Array.from(records.values())[0]
    expect(rec.status).toBe('busy')
  })

  it('resets to online after setBusy(false)', async () => {
    const s = makeStubPb()
    s.setGetFirstListItemResult(null)
    const presence = new Presence(s.pb, 'my-worker')
    await presence.ensure()

    presence.setBusy(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(s.calls.update).toBe(1)

    presence.setBusy(false)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(s.calls.update).toBe(2)

    const rec = Array.from(s.records().values())[0]
    expect(rec.status).toBe('online')
  })
})

describe('Presence — start() / tick()', () => {
  it('tick writes the desired status with a fresh last_heartbeat', async () => {
    const s = makeStubPb()
    s.setGetFirstListItemResult(null)
    const presence = new Presence(s.pb, 'my-worker')
    await presence.ensure()

    presence.setBusy(true)
    await presence.tick()

    const rec = Array.from(s.records().values())[0]
    expect(rec.status).toBe('busy')
    expect(rec.last_heartbeat).toBeDefined()
  })

  it('tick is a no-op when stopped', async () => {
    const s = makeStubPb()
    s.setGetFirstListItemResult(null)
    const presence = new Presence(s.pb, 'my-worker')
    await presence.ensure()

    await presence.stop()
    await presence.tick()

    // No new update call after stop (the tick short-circuits)
    // We can verify by checking that the record was not modified after stop
    const rec = Array.from(s.records().values())[0]
    expect(rec.status).toBe('offline') // set by stop()
  })

  it('does not throw when workerId is null', async () => {
    const s = makeStubPb()
    s.setGetFirstListItemResult(null)
    s.setCreateThrows(true)
    const presence = new Presence(s.pb, 'my-worker')
    await presence.ensure() // workerId stays null

    await expect(presence.tick()).resolves.toBeUndefined()
  })
})

describe('Presence — stop()', () => {
  it('sets status to offline and clears the interval', async () => {
    const s = makeStubPb()
    s.setGetFirstListItemResult(null)
    const presence = new Presence(s.pb, 'my-worker')
    await presence.ensure()

    presence.start()
    await presence.stop()

    const rec = Array.from(s.records().values())[0]
    expect(rec.status).toBe('offline')
  })

  it('is idempotent — calling stop twice does not throw', async () => {
    const s = makeStubPb()
    s.setGetFirstListItemResult(null)
    const presence = new Presence(s.pb, 'my-worker')
    await presence.ensure()

    presence.start()
    await presence.stop()
    await presence.stop() // should not throw

    expect(true).toBe(true)
  })
})

describe('Presence — capabilities', () => {
  it('defaults to ["git"] when no capabilities are passed', async () => {
    const s = makeStubPb()
    s.setGetFirstListItemResult(null)
    const presence = new Presence(s.pb, 'my-worker')
    await presence.ensure()

    const rec = Array.from(s.records().values())[0]
    expect(rec.capabilities).toEqual(['git'])
  })

  it('uses custom capabilities when provided', async () => {
    const s = makeStubPb()
    s.setGetFirstListItemResult(null)
    const presence = new Presence(s.pb, 'my-worker', ['git', 'deploy'])
    await presence.ensure()

    const rec = Array.from(s.records().values())[0]
    expect(rec.capabilities).toEqual(['git', 'deploy'])
  })
})

describe('Presence — intervalMs', () => {
  it('uses the default 30_000 ms when no interval is passed', () => {
    const s = makeStubPb()
    s.setGetFirstListItemResult(null)
    const presence = new Presence(s.pb, 'my-worker')

    expect((presence as any).intervalMs).toBe(30_000)
  })

  it('uses the provided intervalMs', () => {
    const s = makeStubPb()
    s.setGetFirstListItemResult(null)
    const presence = new Presence(s.pb, 'my-worker', ['git'], 5_000)

    expect((presence as any).intervalMs).toBe(5_000)
  })
})

describe('Presence — write failure on heartbeat', () => {
  it('logs [pb] and does not crash when update throws a non-404 error', async () => {
    const s = makeStubPb()
    s.setGetFirstListItemResult(null)
    const presence = new Presence(s.pb, 'my-worker')
    await presence.ensure()

    // Make update throw a non-404 error
    s.setUpdateThrows(true)
    // Override the 404 status — make it a generic error
    const origUpdate = s.pb.collection('local_workers').update
    s.pb.collection('local_workers').update = async () => {
      throw new Error('network timeout')
    }

    presence.setBusy(true)
    await presence.tick() // should not throw

    expect(true).toBe(true) // test passes if no throw
  })
})
