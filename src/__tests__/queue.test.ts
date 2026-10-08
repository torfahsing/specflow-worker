import { describe, it, expect } from 'bun:test'
import {
  subscribeToControl,
  type ClaimedTask,
} from '../queue'
import type { SpecflowClient } from '../client'

function makeStubClient() {
  const calls = {
    connectStream: 0,
  }

  const client = {
    connectStream(onControl: (d: any) => void, onError: (e: any) => void) {
      calls.connectStream++
      return () => {}
    },
  } as unknown as SpecflowClient

  return {
    client,
    calls,
  }
}

describe('subscribeToControl', () => {
  it('connects to SSE stream via client.connectStream', async () => {
    const s = makeStubClient()
    const unsub = await subscribeToControl(s.client, () => {})

    expect(s.calls.connectStream).toBe(1)
    expect(typeof unsub).toBe('function')
    await unsub()
  })

  it('matches stop control by canonical featureId or feature slug', () => {
    interface ActiveTask {
      taskId: string
      taskSlug?: string
      featureId: string
      featureName?: string
      aborted: boolean
    }

    const tasks: ActiveTask[] = [
      {
        taskId: 'rec_task_123',
        taskSlug: 'orchestrate-001',
        featureId: 'feat_pb_456',
        featureName: 'fix-diff-panel',
        aborted: false,
      },
      {
        taskId: 'rec_task_789',
        taskSlug: 'orchestrate-002',
        featureId: 'feat_pb_999',
        featureName: 'other-feature',
        aborted: false,
      },
    ]

    function matchAndAbort(ctrl: {
      action: string
      taskId?: string
      task_id?: string
      featureId?: string
      feature_id?: string
      feature?: string
      featureName?: string
    }) {
      const targetTaskId = ctrl.taskId || ctrl.task_id
      const targetFeatureId = ctrl.featureId || ctrl.feature_id
      const targetFeature = ctrl.feature || ctrl.featureName || targetFeatureId

      for (const t of tasks) {
        const matchesTask = targetTaskId ? (t.taskId === targetTaskId || t.taskSlug === targetTaskId) : true
        const matchesFeature = (targetFeatureId || targetFeature)
          ? (t.featureId === targetFeatureId ||
             t.featureId === targetFeature ||
             (t.featureName !== undefined && (t.featureName === targetFeature || t.featureName === targetFeatureId)))
          : true

        if (matchesTask && matchesFeature) {
          t.aborted = true
        }
      }
    }

    // Stop by canonical PocketBase featureId
    matchAndAbort({ action: 'stop', featureId: 'feat_pb_456' })
    expect(tasks[0].aborted).toBe(true)
    expect(tasks[1].aborted).toBe(false)

    // Stop by feature slug
    matchAndAbort({ action: 'stop', feature: 'other-feature' })
    expect(tasks[1].aborted).toBe(true)
  })
})
