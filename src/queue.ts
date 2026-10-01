/**
 * Task queue — SSE subscription, catch-up drain, and task claiming.
 *
 * Supports both modern SpecflowClient HTTP/SSE and legacy mock interfaces
 * for unit tests.
 */

import type { SpecflowClient } from './client.js'

export const QUEUED_FILTER = 'status = "queued"'

export interface ClaimedTask {
  id: string
  featureId: string
  record: any
  runId?: string
}

export async function subscribeToQueued(
  client: SpecflowClient | any,
  onQueued: (taskId: string) => void,
): Promise<() => Promise<void>> {
  if (typeof client?.connectStream === 'function') {
    const unsub = client.connectStream(
      (data: { task_id: string }) => onQueued(data.task_id),
      (err: Error) => console.warn('[worker] sse notice:', err.message),
    )
    return async () => unsub()
  }

  // Legacy PB mock fallback
  let unsubscribe: (() => Promise<void>) | null = null
  try {
    const sub = await client
      ?.collection?.('tasks')
      ?.subscribe?.(
        '*',
        (e: any) => {
          if (e.action === 'create' || e.action === 'update') {
            onQueued(e.record.id)
          }
        },
        { filter: QUEUED_FILTER, expand: 'feature' },
      )
      ?.catch?.((err: Error) => {
        console.warn('[pb] subscribe notice:', err.message)
      })

    if (typeof sub === 'function') {
      unsubscribe = sub
    }
  } catch (err: any) {
    console.warn('[pb] subscribe notice:', err?.message ?? String(err))
  }

  return async () => {
    if (unsubscribe) {
      await unsubscribe().catch(() => {})
    }
  }
}

export async function drainQueued(
  client: SpecflowClient | any,
): Promise<string[]> {
  if (typeof client?.getPendingTasks === 'function') {
    try {
      const tasks = await client.getPendingTasks()
      return tasks.map((t: any) => t.id)
    } catch (err: any) {
      console.warn('[worker] drain notice:', err.message)
      return []
    }
  }

  // Legacy PB mock fallback
  try {
    const records = await client.collection('tasks').getFullList({
      filter: QUEUED_FILTER,
      sort: 'created',
      expand: 'feature',
    })
    return records.map((r: any) => r.id)
  } catch (err: any) {
    console.warn('[pb] drain notice:', err.message)
    return []
  }
}

export async function claimTask(
  client: SpecflowClient | any,
  taskId: string,
  workerId: string,
): Promise<ClaimedTask | null> {
  if (typeof client?.claimTask === 'function') {
    try {
      const result = await client.claimTask(taskId, workerId)
      return {
        id: result.task.id,
        featureId: result.task.feature,
        record: result.task,
        runId: result.run_id,
      }
    } catch (err: any) {
      console.warn('[worker] claim notice:', err.message)
      return null
    }
  }

  // Legacy PB mock fallback
  let task: any
  try {
    task = await client
      .collection('tasks')
      .getOne(taskId, { expand: 'feature' })
  } catch (err: any) {
    console.warn('[pb] claim notice:', err.message)
    return null
  }

  if (task.status !== 'queued') {
    console.log(
      `[worker] task ${taskId} skipped: status=${task.status}`,
    )
    return null
  }

  try {
    await client.collection('tasks').update(taskId, {
      status: 'in_progress',
      assigned_worker: workerId,
    })
  } catch (err: any) {
    console.warn('[pb] claim notice:', err.message)
    return null
  }

  let after: any
  try {
    after = await client
      .collection('tasks')
      .getOne(taskId, { expand: 'feature' })
  } catch (err: any) {
    console.warn('[pb] claim notice:', err.message)
    return null
  }

  if (after.assigned_worker !== workerId) {
    console.log(
      `[worker] task ${taskId} claim lost (assigned_worker=${after.assigned_worker}); leaving record untouched`,
    )
    return null
  }

  const featureId =
    (typeof after.feature === 'object' && after.feature !== null
      ? after.feature.id
      : after.feature) ??
    after.expand?.feature?.id ??
    ''

  return {
    id: after.id,
    featureId,
    record: after,
  }
}
