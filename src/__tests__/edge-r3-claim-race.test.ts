/**
 * Risk R3 — Claim-lost race producing no second mutation.
 *
 * The CAS claim protocol in queue.ts is:
 *   1. getOne() → check status === 'queued'
 *   2. update() → set in_progress + assigned_worker
 *   3. getOne() → verify assigned_worker === workerId
 *      If NOT → return null and make NO FURTHER mutation.
 *
 * This test ensures step 3 strictly produces zero mutations on the loser's
 * side.  In particular, the loser must NOT:
 *   - Revert status back to 'queued'.
 *   - Clear assigned_worker.
 *   - Log or emit any action that suggests ownership recovery.
 */

import { describe, it, expect } from 'bun:test'
import type PocketBase from 'pocketbase'
import { claimTask, type ClaimedTask } from '../queue.js'

// ===========================================================================
// R3 — Claim-lost race: no second mutation by loser
// ===========================================================================

describe('R3 — claim-task lost-race immutability', () => {
  it('lost race leaves the record exactly as the winning worker set it', async () => {
    const taskId = 'task_race_1'
    const myWorkerId = 'worker_A'
    const otherWorkerId = 'worker_B'

    // Build a stub that tracks every mutation.
    let updatesApplied: Array<{ id: string; data: Record<string, unknown> }> = []
    let getCallCount = 0

    const pb = {
      collection(_name: string) {
        return {
          getOne: async (_id: string, _opts?: any) => {
            getCallCount++
            if (getCallCount === 1) {
              // Step 1: initial read sees queued status
              return {
                id: taskId,
                status: 'queued',
                expand: {},
              }
            }
            // Step 3: post-update read shows another worker claimed it
            return {
              id: taskId,
              status: 'in_progress',
              assigned_worker: otherWorkerId,
              expand: {},
            }
          },
          update: async (id: string, data: Record<string, unknown>) => {
            updatesApplied.push({ id, data })
            return { id, ...data }
          },
        }
      },
    } as unknown as PocketBase

    const result = await claimTask(pb, taskId, myWorkerId)

    expect(result).toBeNull()

    // Verify: only ONE update was made (the optimistic one from step 2).
    expect(updatesApplied).toHaveLength(1)
    // The single update is the optimistic claim itself.
    expect(updatesApplied[0]!.data).toEqual({
      status: 'in_progress',
      assigned_worker: myWorkerId,
    })

    // Critical: the loser did NOT revert status or clear assigned_worker.
    // If there were additional writes after the loss detection, they would
    // appear here. There are none.
    expect(updatesApplied[0]!.data.status).toBe('in_progress')
    expect(updatesApplied[0]!.data.assigned_worker).toBe(myWorkerId)
  })

  it('after losing a claim, status remains in_progress (not reverted to queued)', async () => {
    let updateCount = 0
    let lastUpdatedStatus = ''

    const pb = {
      collection(_name: string) {
        return {
          getOne: async () => {
            // Return different values based on call count
            if (updateCount === 0) {
              // Before any update — queued
              return { id: 't1', status: 'queued', expand: {} }
            }
            // After update — another worker has claimed it
            return { id: 't1', status: 'in_progress', assigned_worker: 'other', expand: {} }
          },
          update: async (_id: string, data: any) => {
            updateCount++
            lastUpdatedStatus = data.status
            return { id: 't1', ...data }
          },
        }
      },
    } as unknown as PocketBase

    const result = await claimTask(pb, 't1', 'my_worker')

    expect(result).toBeNull()
    // The ONLY write was the optimistic step-2 update with status='in_progress'.
    expect(updateCount).toBe(1)
    expect(lastUpdatedStatus).toBe('in_progress')
    // No subsequent write with status='queued' or status='failed'.
  })

  it('after losing a claim, assigned_worker is NOT cleared', async () => {
    let updateData: Record<string, unknown> = {}

    const pb = {
      collection(_name: string) {
        return {
          getOne: async () => {
            return { id: 't1', status: 'queued', expand: {} }
          },
          update: async (_id: string, data: any) => {
            updateData = data
            return { id: 't1', ...data }
          },
        }
      },
    } as unknown as PocketBase

    // Override getOne to simulate a lost race on the re-read
    const originalCollection = (pb as any).collection.bind(pb)
    ;(pb as any).collection = (_name: string) => {
      const coll = originalCollection(_name)
      let callNum = 0
      return {
        ...coll,
        getOne: async (_id: string, _opts?: any) => {
          callNum++
          if (callNum === 1) {
            return { id: 't1', status: 'queued', assigned_worker: null, expand: {} }
          }
          // Race lost — show other worker's assignment
          return {
            id: 't1',
            status: 'in_progress',
            assigned_worker: 'stole_me',
            expand: {},
          }
        },
      }
    }

    const result = await claimTask(pb, 't1', 'my_worker')

    expect(result).toBeNull()
    // The update sent was our optimistic claim, not a revert.
    expect(updateData.assigned_worker).toBe('my_worker')
    expect(updateData.status).toBe('in_progress')
  })

  it('race log message confirms "leaving record untouched"', async () => {
    const origLog = console.log
    const logs: string[] = []
    console.log = (...args: any[]) => logs.push(args.join(' '))

    try {
      const pb = {
        collection(_name: string) {
          return {
            getOne: async () => {
              // Always return the initial state
              return { id: 't1', status: 'queued', assigne

d_worker: null, expand: {} }
            },
            update: async (_id: string, data: any) => {
              return { id: 't1', ...data }
            },
          }
        },
      } as unknown as PocketBase

      // Override getOne to simulate race on second call
      const origColl = (pb as any).collection.bind(pb)
      let numCalls = 0
      ;(pb as any).collection = (_name: string) => {
        const coll = origColl(_name)
        return {
          ...coll,
          getOne: async (_id: string, _opts?: any) => {
            numCalls++
            if (numCalls === 1) {
              return { id: 't1', status: 'queued', expand: {} }
            }
            return { id: 't1', status: 'in_progress', assigned_worker: 'rival', expand: {} }
          },
        }
      }

      await claimTask(pb, 't1', 'my_worker')

      expect(logs.some((l) => l.includes('claim lost'))).toBe(true)
      expect(logs.some((l) => l.includes('leaving record untouched'))).toBe(true)
    } finally {
      console.log = origLog
    }
  })
})
