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
  isChat?: boolean
}

export interface ControlMessage {
  action: string
  all?: boolean
  allowedTools?: string[]
  base?: string
  branch?: string
  command?: string
  cwd?: string
  description?: string
  dir?: string
  feature?: string
  feature_id?: string
  featureId?: string
  feature_name?: string
  featureName?: string
  filepath?: string
  isFirstPhase?: boolean
  maxBytes?: number
  maxDepth?: number
  maxDiffChars?: number
  maxResults?: number
  maxSnippets?: number
  maxTreeChars?: number
  message?: string
  model?: string
  models?: string[]
  path?: string
  pattern?: string
  patterns?: string[]
  project_dir?: string
  prompt?: string
  queryId?: string
  runId?: string
  task?: Record<string, unknown>
  task_id?: string
  taskId?: string
  timeout?: number
}

export async function subscribeToControl(
  client: SpecflowClient,
  onControl: (control: ControlMessage) => void,
): Promise<() => Promise<void>> {
  const unsub = client.connectStream(
    onControl,
    (err: Error) => console.warn('[worker] sse notice:', err.message),
  )
  return async () => unsub()
}

