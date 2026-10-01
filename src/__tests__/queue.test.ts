import { describe, it, expect } from 'bun:test'
import {
  claimTask,
  drainQueued,
  subscribeToQueued,
  type ClaimedTask,
} from '../queue'
import type { SpecflowClient } from '../client'

function makeStubClient() {
  const calls = {
    connectStream: 0,
    getPendingTasks: 0,
    claimTask: 0,
  }

  let claimThrows = false
  let pendingTasksResult: any[] = []
  let claimTaskResult: any = null

  const client = {
    connectStream(onData: (d: any) => void, onError: (e: any) => void) {
      calls.connectStream++
      return () => {}
    },
    async getPendingTasks() {
      calls.getPendingTasks++
      return pendingTasksResult
    },
    async claimTask(taskId: string, workerId: string) {
      calls.claimTask++
      if (claimThrows) throw new Error('claim failed')
      return claimTaskResult
    },
  } as unknown as SpecflowClient

  return {
    client,
    calls,
    setClaimThrows(v: boolean) { claimThrows = v },
    setPendingTasksResult(v: any[]) { pendingTasksResult = v },
    setClaimTaskResult(v: any) { claimTaskResult = v },
  }
}

describe('subscribeToQueued', () => {
  it('connects to SSE stream via client.connectStream', async () => {
    const s = makeStubClient()
    const unsub = await subscribeToQueued(s.client, () => {})

    expect(s.calls.connectStream).toBe(1)
    expect(typeof unsub).toBe('function')
    await unsub()
  })
})

describe('drainQueued', () => {
  it('returns task ids from client.getPendingTasks()', async () => {
    const s = makeStubClient()
    s.setPendingTasksResult([
      { id: 'task_1', title: 'Task 1' },
      { id: 'task_2', title: 'Task 2' },
    ])

    const ids = await drainQueued(s.client)

    expect(ids).toEqual(['task_1', 'task_2'])
    expect(s.calls.getPendingTasks).toBe(1)
  })

  it('returns empty array on error', async () => {
    const failingClient = {
      async getPendingTasks() {
        throw new Error('network down')
      },
    } as unknown as SpecflowClient

    const ids = await drainQueued(failingClient)
    expect(ids).toEqual([])
  })
})

describe('claimTask', () => {
  it('claims task atomically via client.claimTask and returns ClaimedTask', async () => {
    const s = makeStubClient()
    s.setClaimTaskResult({
      task: {
        id: 'task_123',
        feature: 'feat_abc',
        title: 'Do something',
        prompt: 'Implement feature',
      },
      run_id: 'run_999',
    })

    const claimed = await claimTask(s.client, 'task_123', 'worker_1')

    expect(claimed).not.toBeNull()
    expect(claimed!.id).toBe('task_123')
    expect(claimed!.featureId).toBe('feat_abc')
    expect(claimed!.runId).toBe('run_999')
  })

  it('returns null when claiming fails or errors', async () => {
    const s = makeStubClient()
    s.setClaimThrows(true)

    const claimed = await claimTask(s.client, 'task_123', 'worker_1')

    expect(claimed).toBeNull()
  })
})
