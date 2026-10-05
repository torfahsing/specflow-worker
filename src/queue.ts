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

export async function subscribeToControl(
  client: SpecflowClient,
  onControl: (control: { action: string; [key: string]: any }) => void,
): Promise<() => Promise<void>> {
  const unsub = client.connectStream(
    onControl,
    (err: Error) => console.warn('[worker] sse notice:', err.message),
  )
  return async () => unsub()
}

