/**
 * Task queue — SSE subscription, catch-up drain, and optimistic
 * compare-and-set claim.
 *
 * Mirrors the subscription shape of
 * packages/web/src/lib/pocketbase.ts:94
 * (`collection('tasks').subscribe('*', cb)`) narrowed by the
 * SDK filter option.  Every SDK interaction is try/caught with
 * `[pb]` / `[worker]` diagnostics so that a transient network
 * hiccup never crashes the work loop.
 *
 * `claimTask` uses an optimistic compare-and-set (CAS) because
 * the PocketBase SDK has no conditional PATCH: re-read
 * (`queued`) → update → re-read and verify ownership; losers
 * make no further mutation and do not revert `status`.
 *
 * Feature identity is read natively via `expand: 'feature'`
 * (gate #2 — `tasks.feature` is already a formal relation; no
 * name-based lookup, no manual join, no workaround).
 */

import type PocketBase from 'pocketbase'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Filter string for the SSE subscription and getFullList drain.
 * Kept as a constant so every call site uses the identical value.
 */
export const QUEUED_FILTER = 'status = "queued"'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result of a successful `claimTask`.  `featureId` is read
 * natively from the expanded `feature` relation (no name-based
 * lookup, no manual join).
 */
export interface ClaimedTask {
  id: string
  featureId: string
  record: any
}

// ---------------------------------------------------------------------------
// subscribeToQueued
// ---------------------------------------------------------------------------

/**
 * Subscribe to `tasks` records whose `status` is `"queued"`.
 *
 * Fires `onQueued(taskId)` for `create` and `update` actions
 * only.  The subscription is narrowed by the SDK `filter`
 * option (not by post-hoc filtering in the callback).  The
 * `expand: 'feature'` option ensures the expanded feature
 * record is available when the callback fires.
 *
 * Never throws — every SDK interaction is try/caught with a
 * `[pb]` prefix.  Returns a disposer that awaits
 * `unsubscribe('*')`.
 */
export async function subscribeToQueued(
  pb: PocketBase,
  onQueued: (taskId: string) => void,
): Promise<() => void> {
  let unsubscribe: (() => Promise<void>) | null = null
  let disposed = false

  try {
    const sub = await pb
      .collection('tasks')
      .subscribe(
        '*',
        (e: any) => {
          // Fire only for create / update — the spec requires
          // that delete and patch (non-status-changing) actions
          // do not trigger a re-drain.
          if (e.action === 'create' || e.action === 'update') {
            onQueued(e.record.id)
          }
        },
        { filter: QUEUED_FILTER, expand: 'feature' },
      )
      .catch((err: Error) => {
        console.warn('[pb] subscribe notice:', err.message)
      })

    // The SDK returns a disposer function from subscribe()
    if (typeof sub === 'function') {
      unsubscribe = sub
    }
  } catch (err) {
    console.warn('[pb] subscribe notice:', (err as Error).message)
  }

  return () => {
    disposed = true
    if (unsubscribe) {
      unsubscribe().catch(() => {})
    }
  }
}

// ---------------------------------------------------------------------------
// drainQueued
// ---------------------------------------------------------------------------

/**
 * Catch-up drain: fetch all currently queued tasks oldest-first.
 *
 * Uses `getFullList` with the identical filter/sort/expand options
 * as the SSE subscription so the daemon never misses a task that
 * was queued before the subscription was established (startup,
 * reconnect, post-task, safety poll).
 *
 * On rejection logs `[pb] drain notice` and returns `[]`.
 */
export async function drainQueued(
  pb: PocketBase,
): Promise<string[]> {
  try {
    const records = await pb.collection('tasks').getFullList({
      filter: QUEUED_FILTER,
      sort: 'created',
      expand: 'feature',
    })
    return records.map((r: any) => r.id)
  } catch (err) {
    console.warn('[pb] drain notice:', (err as Error).message)
    return []
  }
}

// ---------------------------------------------------------------------------
// claimTask — optimistic compare-and-set
// ---------------------------------------------------------------------------

/**
 * Claim a queued task by atomically setting `status = 'in_progress'`
 * and `assigned_worker = workerId`.
 *
 * CAS steps (spec §2.3):
 *   1. `getOne(taskId, { expand: 'feature' })` — skip if not queued.
 *   2. `update(taskId, { status: 'in_progress', assigned_worker: workerId })`.
 *   3. Re-read and verify `after.assigned_worker === workerId`.
 *      If another worker stole it → return `null` and make **no
 *      further mutation** (specifically: do NOT revert `status`).
 *   4. Return the confirmed `ClaimedTask` with the feature id
 *      read natively (`after.feature ?? after.expand?.feature?.id`).
 *
 * Any step throwing → log `[pb]` / `[worker]` and return `null`
 * (never crash the work loop).
 */
export async function claimTask(
  pb: PocketBase,
  taskId: string,
  workerId: string,
): Promise<ClaimedTask | null> {
  // Step 1: re-read and verify queued status
  let task: any
  try {
    task = await pb
      .collection('tasks')
      .getOne(taskId, { expand: 'feature' })
  } catch (err) {
    console.warn('[pb] claim notice:', (err as Error).message)
    return null
  }

  if (task.status !== 'queued') {
    console.log(
      `[worker] task ${taskId} skipped: status=${task.status}`,
    )
    return null
  }

  // Step 2: optimistic update
  try {
    await pb.collection('tasks').update(taskId, {
      status: 'in_progress',
      assigned_worker: workerId,
    })
  } catch (err) {
    console.warn('[pb] claim notice:', (err as Error).message)
    return null
  }

  // Step 3: re-read and verify ownership
  let after: any
  try {
    after = await pb
      .collection('tasks')
      .getOne(taskId, { expand: 'feature' })
  } catch (err) {
    console.warn('[pb] claim notice:', (err as Error).message)
    return null
  }

  if (after.assigned_worker !== workerId) {
    console.log(
      `[worker] task ${taskId} claim lost (assigned_worker=${after.assigned_worker}); leaving record untouched`,
    )
    return null
  }

  // Step 4: return confirmed claim with native feature id
  // after.feature is the expanded record object when expand:'feature' is used;
  // after.expand?.feature?.id is the same path via the expand accessor.
  // We handle both the object form (expanded relation) and the string form
  // (non-expanded, where the relation id is stored directly).
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
