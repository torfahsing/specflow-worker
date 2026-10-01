/**
 * Task queue — SSE subscription, catch-up drain, and task claiming.
 *
 * All queue operations interact exclusively with the Specflow HTTP/SSE API via SpecflowClient.
 */

import type { SpecflowClient } from './client.js'

export interface ClaimedTask {
  id: string
  featureId: string
  record: any
  runId?: string
}

export async function subscribeToQueued(
  client: SpecflowClient,
  onQueued: (taskId: string) => void,
): Promise<() => Promise<void>> {
  const unsub = client.connectStream(
    (data: { task_id: string }) => onQueued(data.task_id),
    (err: Error) => console.warn('[worker] sse notice:', err.message),
  )
  return async () => unsub()
}

export async function drainQueued(
  client: SpecflowClient,
): Promise<string[]> {
  try {
    const tasks = await client.getPendingTasks()
    return tasks.map((t: any) => t.id)
  } catch (err: any) {
    console.warn('[worker] drain notice:', err.message)
    return []
  }
}

export async function claimTask(
  client: SpecflowClient,
  taskId: string,
  workerId: string,
): Promise<ClaimedTask | null> {
  try {
    const result = await client.claimTask(taskId, workerId)
    if (!result || !result.task) return null
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
