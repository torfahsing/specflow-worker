import { describe, it, expect } from 'bun:test'
import type PocketBase from 'pocketbase'
import {
  QUEUED_FILTER,
  claimTask,
  drainQueued,
  subscribeToQueued,
  type ClaimedTask,
} from '../queue'

// ---------------------------------------------------------------------------
// Stub helpers — shared collection object with closure-variable state
// ---------------------------------------------------------------------------

function makeStubPb() {
  const calls = {
    getOne: 0,
    update: 0,
    getFullList: 0,
    subscribe: 0,
    unsubscribe: 0,
  }

  // Mutable state for getOne
  let getOneResult: any = null
  let getOneThrows = false

  // Mutable state for update
  let updateThrows = false

  // Mutable state for getFullList
  let getFullListResult: any[] = []
  let getFullListThrows = false
  let capturedGetFullListOpts: any = null

  // Mutable state for subscribe
  let subscribeResult: (() => Promise<void>) | null = null
  let subscribeThrows = false

  // Shared collection object — returned by every collection() call
  const taskCollection = {
    getOne(_id: string, _opts?: any) {
      calls.getOne++
      if (getOneThrows) throw new Error('network error')
      return Promise.resolve(getOneResult ?? null)
    },
    update(_id: string, _data: any) {
      calls.update++
      if (updateThrows) throw new Error('network error')
      return Promise.resolve({})
    },
    getFullList(opts?: any) {
      calls.getFullList++
      capturedGetFullListOpts = opts
      if (getFullListThrows) throw new Error('network error')
      return Promise.resolve(getFullListResult)
    },
    subscribe(_topic: string, _cb: any, _opts?: any) {
      calls.subscribe++
      if (subscribeThrows) throw new Error('network error')
      return Promise.resolve(subscribeResult ?? (async () => {}))
    },
    unsubscribe() {
      calls.unsubscribe++
      return Promise.resolve()
    },
  }

  const pb = {
    collection(_name: string) {
      return taskCollection
    },
  }

  return {
    pb: pb as unknown as PocketBase,
    calls,
    get capturedGetFullListOpts() { return capturedGetFullListOpts },
    setGetOneResult(v: any) { getOneResult = v },
    setGetOneThrows(v: boolean) { getOneThrows = v },
    setUpdateThrows(v: boolean) { updateThrows = v },
    setGetFullListResult(v: any[]) { getFullListResult = v },
    setGetFullListThrows(v: boolean) { getFullListThrows = v },
    setSubscribeResult(v: (() => Promise<void>) | null) { subscribeResult = v },
    setSubscribeThrows(v: boolean) { subscribeThrows = v },
  }
}

// ---------------------------------------------------------------------------
// QUEUED_FILTER
// ---------------------------------------------------------------------------

describe('QUEUED_FILTER', () => {
  it('is the exact filter string used by the SDK', () => {
    expect(QUEUED_FILTER).toBe('status = "queued"')
  })
})

// ---------------------------------------------------------------------------
// subscribeToQueued
// ---------------------------------------------------------------------------

describe('subscribeToQueued', () => {
  it('fires onQueued for create actions', async () => {
    const firedIds: string[] = []
    const pb = {
      collection(_name: string) {
        return {
          subscribe(_topic: string, cb: any, _opts?: any) {
            cb({ action: 'create', record: { id: 'task_1' } })
            return Promise.resolve(async () => {})
          },
        }
      },
    } as unknown as PocketBase

    const disposer = await subscribeToQueued(pb, (id) => firedIds.push(id))

    expect(firedIds).toEqual(['task_1'])
    await disposer()
  })

  it('fires onQueued for update actions', async () => {
    const firedIds: string[] = []
    const pb = {
      collection(_name: string) {
        return {
          subscribe(_topic: string, cb: any, _opts?: any) {
            cb({ action: 'update', record: { id: 'task_2' } })
            return Promise.resolve(async () => {})
          },
        }
      },
    } as unknown as PocketBase

    const disposer = await subscribeToQueued(pb, (id) => firedIds.push(id))

    expect(firedIds).toEqual(['task_2'])
    await disposer()
  })

  it('does NOT fire onQueued for delete actions', async () => {
    const firedIds: string[] = []
    const pb = {
      collection(_name: string) {
        return {
          subscribe(_topic: string, cb: any, _opts?: any) {
            cb({ action: 'delete', record: { id: 'task_3' } })
            return Promise.resolve(async () => {})
          },
        }
      },
    } as unknown as PocketBase

    const disposer = await subscribeToQueued(pb, (id) => firedIds.push(id))

    expect(firedIds).toHaveLength(0)
    await disposer()
  })

  it('does NOT fire onQueued for patch actions', async () => {
    const firedIds: string[] = []
    const pb = {
      collection(_name: string) {
        return {
          subscribe(_topic: string, cb: any, _opts?: any) {
            cb({ action: 'patch', record: { id: 'task_4' } })
            return Promise.resolve(async () => {})
          },
        }
      },
    } as unknown as PocketBase

    const disposer = await subscribeToQueued(pb, (id) => firedIds.push(id))

    expect(firedIds).toHaveLength(0)
    await disposer()
  })

  it('passes filter and expand options to subscribe', async () => {
    let receivedOpts: any = null
    const pb = {
      collection(_name: string) {
        return {
          subscribe(_topic: string, _cb: any, opts?: any) {
            receivedOpts = opts
            return Promise.resolve(async () => {})
          },
        }
      },
    } as unknown as PocketBase

    await subscribeToQueued(pb, () => {})

    expect(receivedOpts).toEqual({
      filter: QUEUED_FILTER,
      expand: 'feature',
    })
  })

  it('returns a disposer that calls unsubscribe', async () => {
    let unsubscribed = false
    const pb = {
      collection(_name: string) {
        return {
          subscribe(_topic: string, _cb: any, _opts?: any) {
            return Promise.resolve(async () => {
              unsubscribed = true
            })
          },
          unsubscribe() {
            unsubscribed = true
            return Promise.resolve()
          },
        }
      },
    } as unknown as PocketBase

    const disposer = await subscribeToQueued(pb, () => {})
    await disposer()
    expect(unsubscribed).toBe(true)
  })

  it('never throws when subscribe rejects', async () => {
    const pb = {
      collection(_name: string) {
        return {
          subscribe() {
            throw new Error('network error')
          },
        }
      },
    } as unknown as PocketBase

    // Should not throw
    const disposer = await subscribeToQueued(pb, () => {})
    await disposer()
    expect(true).toBe(true)
  })

  it('logs [pb] prefix on subscribe failure', async () => {
    const pb = {
      collection(_name: string) {
        return {
          subscribe() {
            throw new Error('connection refused')
          },
        }
      },
    } as unknown as PocketBase

    const origWarn = console.warn
    const warns: string[] = []
    console.warn = (...args: any[]) => warns.push(args.join(' '))

    const disposer = await subscribeToQueued(pb, () => {})
    await disposer()

    console.warn = origWarn
    expect(warns.some((w) => w.includes('[pb]') && w.includes('subscribe notice'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// drainQueued
// ---------------------------------------------------------------------------

describe('drainQueued', () => {
  it('returns task ids oldest-first with the correct filter/sort/expand', async () => {
    const stub = makeStubPb()
    const { pb, calls } = stub
    const taskColl = (pb as any).collection('tasks')
    taskColl.getFullList = async (opts?: any) => {
      // Capture opts for verification
      ;(stub as any).capturedGetFullListOpts = opts
      return [
        { id: 'task_old' },
        { id: 'task_new' },
      ]
    }

    const ids = await drainQueued(pb)

    expect(ids).toEqual(['task_old', 'task_new'])
    expect(calls.getFullList).toBe(1)
    expect((stub as any).capturedGetFullListOpts).toEqual({
      filter: QUEUED_FILTER,
      sort: 'created',
      expand: 'feature',
    })
  })

  it('returns [] on rejection and logs [pb]', async () => {
    const pb = {
      collection(_name: string) {
        return {
          getFullList() {
            throw new Error('network error')
          },
        }
      },
    } as unknown as PocketBase

    const ids = await drainQueued(pb)
    expect(ids).toEqual([])
  })

  it('logs [pb] drain notice on rejection', async () => {
    const pb = {
      collection(_name: string) {
        return {
          getFullList() {
            throw new Error('network error')
          },
        }
      },
    } as unknown as PocketBase

    const origWarn = console.warn
    const warns: string[] = []
    console.warn = (...args: any[]) => warns.push(args.join(' '))

    const ids = await drainQueued(pb)

    console.warn = origWarn
    expect(ids).toEqual([])
    expect(warns.some((w) => w.includes('[pb]') && w.includes('drain notice'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// claimTask — optimistic compare-and-set
// ---------------------------------------------------------------------------

describe('claimTask', () => {
  const taskId = 'task_1'
  const workerId = 'worker_abc'

  it('not-queued ⇒ no update call, returns null', async () => {
    const { pb, calls } = makeStubPb()
    const taskColl = (pb as any).collection('tasks')
    taskColl.getOne = async () => ({
      id: taskId,
      status: 'done',
      expand: {},
    })

    const result = await claimTask(pb, taskId, workerId)

    expect(result).toBeNull()
    expect(calls.update).toBe(0)
  })

  it('logs [worker] skipped message when status is not queued', async () => {
    const { pb } = makeStubPb()
    const taskColl = (pb as any).collection('tasks')
    taskColl.getOne = async () => ({
      id: taskId,
      status: 'done',
      expand: {},
    })

    const origLog = console.log
    const logs: string[] = []
    console.log = (...args: any[]) => logs.push(args.join(' '))

    const result = await claimTask(pb, taskId, workerId)

    console.log = origLog
    expect(result).toBeNull()
    expect(logs.some((l) => l.includes('[worker]'))).toBe(true)
    expect(logs.some((l) => l.includes('skipped: status=done'))).toBe(true)
  })

  it('happy path ⇒ update payload is exactly { status: in_progress, assigned_worker }', async () => {
    const { pb, calls } = makeStubPb()
    let getOneCall = 0
    const taskColl = (pb as any).collection('tasks')
    taskColl.getOne = async (_id: string, _opts?: any) => {
      getOneCall++
      if (getOneCall === 1) {
        return { id: taskId, status: 'queued', expand: { feature: { id: 'feat_1' } } }
      }
      // Second getOne (post-update verification)
      return { id: taskId, status: 'in_progress', assigned_worker: workerId, expand: { feature: { id: 'feat_1' } } }
    }

    const result = await claimTask(pb, taskId, workerId)

    expect(result).not.toBeNull()
    expect(result!.id).toBe(taskId)
    expect(result!.featureId).toBe('feat_1')
    expect(calls.update).toBe(1)
  })

  it('happy path: returned record has expand.feature.id as featureId', async () => {
    const { pb } = makeStubPb()
    let getOneCall = 0
    const taskColl = (pb as any).collection('tasks')
    taskColl.getOne = async (_id: string, _opts?: any) => {
      getOneCall++
      if (getOneCall === 1) {
        return { id: taskId, status: 'queued', expand: { feature: { id: 'feat_xyz' } } }
      }
      return { id: taskId, status: 'in_progress', assigned_worker: workerId, expand: { feature: { id: 'feat_xyz' } } }
    }

    const result = await claimTask(pb, taskId, workerId)

    expect(result).not.toBeNull()
    expect(result!.featureId).toBe('feat_xyz')
  })

  it('lost race (post-read shows another worker) ⇒ null, no second update, no status revert', async () => {
    const { pb, calls } = makeStubPb()
    let getOneCall = 0
    const taskColl = (pb as any).collection('tasks')
    taskColl.getOne = async (_id: string, _opts?: any) => {
      getOneCall++
      if (getOneCall === 1) {
        return { id: taskId, status: 'queued', expand: {} }
      }
      // Post-update read shows another worker claimed it
      return { id: taskId, status: 'in_progress', assigned_worker: 'other_worker', expand: {} }
    }

    const result = await claimTask(pb, taskId, workerId)

    expect(result).toBeNull()
    expect(calls.update).toBe(1) // only the optimistic update, no revert
  })

  it('logs claim-lost message when another worker stole the task', async () => {
    const { pb } = makeStubPb()
    let getOneCall = 0
    const taskColl = (pb as any).collection('tasks')
    taskColl.getOne = async (_id: string, _opts?: any) => {
      getOneCall++
      if (getOneCall === 1) {
        return { id: taskId, status: 'queued', expand: {} }
      }
      return { id: taskId, status: 'in_progress', assigned_worker: 'other_worker', expand: {} }
    }

    const origLog = console.log
    const logs: string[] = []
    console.log = (...args: any[]) => logs.push(args.join(' '))

    const result = await claimTask(pb, taskId, workerId)

    console.log = origLog
    expect(result).toBeNull()
    expect(logs.some((l) => l.includes('claim lost'))).toBe(true)
    expect(logs.some((l) => l.includes('other_worker'))).toBe(true)
    expect(logs.some((l) => l.includes('leaving record untouched'))).toBe(true)
  })

  it('getOne throw on first read ⇒ null, no rethrow', async () => {
    const { pb, calls } = makeStubPb()
    const taskColl = (pb as any).collection('tasks')
    taskColl.getOne = async () => {
      throw new Error('network error')
    }

    const result = await claimTask(pb, taskId, workerId)

    expect(result).toBeNull()
    expect(calls.update).toBe(0)
  })

  it('getOne throw on post-update read ⇒ null, no rethrow', async () => {
    const { pb, calls } = makeStubPb()
    let getOneCall = 0
    const taskColl = (pb as any).collection('tasks')
    taskColl.getOne = async (_id: string, _opts?: any) => {
      getOneCall++
      if (getOneCall === 1) {
        return { id: taskId, status: 'queued', expand: {} }
      }
      throw new Error('network error on re-read')
    }

    const result = await claimTask(pb, taskId, workerId)

    expect(result).toBeNull()
    expect(calls.update).toBe(1) // the optimistic update was already sent
  })

  it('update throw ⇒ null, no rethrow', async () => {
    const { pb, calls } = makeStubPb()
    const taskColl = (pb as any).collection('tasks')
    taskColl.getOne = async () => ({
      id: taskId,
      status: 'queued',
      expand: {},
    })
    // Override update to throw, but still increment calls counter
    taskColl.update = async () => {
      calls.update++
      throw new Error('network error')
    }

    const result = await claimTask(pb, taskId, workerId)

    expect(result).toBeNull()
    expect(calls.update).toBe(1)
  })

  it('featureId is empty string when feature relation is absent', async () => {
    const { pb } = makeStubPb()
    let getOneCall = 0
    const taskColl = (pb as any).collection('tasks')
    taskColl.getOne = async (_id: string, _opts?: any) => {
      getOneCall++
      if (getOneCall === 1) {
        return { id: taskId, status: 'queued', expand: {} }
      }
      return { id: taskId, status: 'in_progress', assigned_worker: workerId, expand: {} }
    }

    const result = await claimTask(pb, taskId, workerId)

    expect(result).not.toBeNull()
    expect(result!.featureId).toBe('')
  })

  it('featureId uses after.feature (native relation) not after.expand.feature', async () => {
    const { pb } = makeStubPb()
    let getOneCall = 0
    const taskColl = (pb as any).collection('tasks')
    taskColl.getOne = async (_id: string, _opts?: any) => {
      getOneCall++
      if (getOneCall === 1) {
        return { id: taskId, status: 'queued', feature: { id: 'feat_native' }, expand: {} }
      }
      return { id: taskId, status: 'in_progress', assigned_worker: workerId, feature: { id: 'feat_native' }, expand: {} }
    }

    const result = await claimTask(pb, taskId, workerId)

    expect(result).not.toBeNull()
    expect(result!.featureId).toBe('feat_native')
  })
})
