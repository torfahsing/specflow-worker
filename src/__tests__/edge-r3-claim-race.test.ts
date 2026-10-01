/**
 * Risk R3 — Claim-lost race handling.
 *
 * In the HTTP architecture, atomic claiming is enforced server-side.
 * When a worker loses a race, the server rejects the claim (409 or error),
 * and the worker's claimTask() returns null cleanly without making further mutations.
 */

import { describe, it, expect } from 'bun:test'
import { claimTask, type ClaimedTask } from '../queue.js'
import type { SpecflowClient } from '../client.js'

describe('R3 — claim-task lost-race handling', () => {
  it('returns null when server rejects claim due to race condition', async () => {
    const client = {
      async claimTask() {
        throw new Error('Task already claimed by another worker')
      },
    } as unknown as SpecflowClient

    const result = await claimTask(client, 't1', 'my_worker')
    expect(result).toBeNull()
  })

  it('returns ClaimedTask when claim succeeds', async () => {
    const client = {
      async claimTask(taskId: string, workerId: string) {
        return {
          task: {
            id: taskId,
            feature: 'feat_1',
            title: 'Task 1',
          },
          run_id: 'run_123',
        }
      },
    } as unknown as SpecflowClient

    const result = await claimTask(client, 't1', 'my_worker')
    expect(result).not.toBeNull()
    expect(result!.id).toBe('t1')
    expect(result!.runId).toBe('run_123')
  })
})
