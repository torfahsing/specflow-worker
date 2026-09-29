/**
 * PocketBase connection for the worker daemon.
 *
 * Mirrors specflow/packages/orchestrator/src/pocketbase/service.ts
 * (initClient / authenticateAdmin / isAvailable / ensureReady) and
 * packages/web/src/lib/pocketbase.ts:
 *   - new PocketBase(url) + autoCancellation(false)
 *   - _superusers auth ladder with legacy `pb.admins` fallback + authFailed latch
 *   - health-check gating that never throws
 *
 * No reconnect/backoff logic lives here — the SDK's RealtimeService owns
 * reconnection (predefinedReconnectIntervals); we only consume the
 * `PB_CONNECT` topic as a hook to re-drain the queue after every (re)connect.
 */

import PocketBase from 'pocketbase'

export interface AuthOptions {
  /** POCKETBASE_TOKEN — raw auth token. Applied once, never re-authenticated. */
  token?: string
  /** POCKETBASE_ADMIN_EMAIL / POCKETBASE_ADMIN_PASSWORD fallback auth. */
  email?: string
  password?: string
  /** Shared authFailed latch — mirrors PocketBaseService.authFailed. */
  latch?: { failed: boolean }
  /**
   * Set to true once authentication has been performed via the raw-token
   * path. Kept on the same opts object so startAuthWatchdog() can share it.
   */
  tokenMode?: boolean
}

/**
 * Construct a PocketBase client (2-line clone of PocketBaseService.initClient(),
 * service.ts:119-121). Construction performs no network I/O.
 */
export function createClient(url: string): PocketBase {
  const pb = new PocketBase(url)
  pb.autoCancellation(false)
  return pb
}

/**
 * Authenticate with PocketBase.
 *
 * Ladder (mirrors PocketBaseService.authenticateAdmin, service.ts:141-158):
 *   1. Raw token → pb.authStore.save(token) + tokenMode flag.
 *   2. authStore.isValid → true without any network round-trip.
 *   3. Auth latch (previous failure) → false, no retry storm.
 *   4. email+password → _superusers.authWithPassword, with fallback to the
 *      legacy (pb as any).admins.authWithPassword.
 *
 * Never throws. Sensitive values (tokens/passwords) are never logged.
 */
export async function authenticate(
  pb: PocketBase,
  opts: AuthOptions,
): Promise<boolean> {
  // Raw token path: always wins and never goes over the network. A raw
  // (non-JWT) token keeps authStore.isValid false forever, so we record
  // tokenMode to stop the watchdog from ever re-authenticating it.
  if (opts.token) {
    try {
      pb.authStore.save(opts.token)
      opts.tokenMode = true
      console.log('[pb] authenticated (token mode)')
      return true
    } catch (err) {
      console.warn('[pb] authenticate notice:', (err as Error).message)
      return false
    }
  }

  // Already authenticated — no network round-trip.
  if (pb.authStore?.isValid) return true

  // authFailed latch (parity with service.ts `authFailed`).
  if (opts.latch?.failed) return false

  if (!opts.email || !opts.password) return false

  try {
    try {
      await pb.collection('_superusers').authWithPassword(opts.email, opts.password)
      if (opts.latch) opts.latch.failed = false
      console.log('[pb] authenticated (superuser)')
      return true
    } catch (err) {
      // Legacy SDKs expose admins via `pb.admins` instead of the
      // `_superusers` collection — mirror service.ts fallback.
      if ((pb as any).admins) {
        await (pb as any).admins.authWithPassword(opts.email, opts.password)
        if (opts.latch) opts.latch.failed = false
        console.log('[pb] authenticated (legacy admins)')
        return true
      }
      console.warn('[pb] authenticate notice:', (err as Error).message)
      if (opts.latch) opts.latch.failed = true
      return false
    }
  } catch (err) {
    console.warn('[pb] authenticate notice:', (err as Error).message)
    if (opts.latch) opts.latch.failed = true
    return false
  }
}

/**
 * Health-check gate (port of PocketBaseService.isAvailable, service.ts:160-170).
 * Never throws — returns false when the request fails or the code is not 200.
 */
export async function isAvailable(pb: PocketBase): Promise<boolean> {
  try {
    const health = await pb.health.check()
    return health.code === 200
  } catch (err) {
    console.warn('[pb] isAvailable notice:', (err as Error).message)
    return false
  }
}

/**
 * ensureReady() (service.ts:172-180) as a timer: re-authenticate when the
 * auth store has gone stale. Re-auth happens only when we authenticated via
 * email/password — a raw POCKETBASE_TOKEN (tokenMode) is never re-authed
 * (a non-JWT raw token keeps isValid false forever).
 *
 * Returns a disposer that clears the interval.
 */
export function startAuthWatchdog(
  pb: PocketBase,
  opts: AuthOptions,
  intervalMs = 30_000,
): () => void {
  const timer = setInterval(() => {
    // `!opts.token` is belt-and-braces: skip even if authenticate() has not
    // run yet (tokenMode is only set by an authenticate() call).
    if (opts.tokenMode || opts.token) return
    if (pb.authStore?.isValid) return
    if (!opts.email || !opts.password) return
    authenticate(pb, opts).catch(() => {})
  }, intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}

/**
 * Register a callback that fires on every realtime (re)connect via the SDK's
 * `PB_CONNECT` topic. No custom reconnect/backoff logic — RealtimeService's
 * predefinedReconnectIntervals owns that; we only need the hook to re-drain
 * the queue after state is lost. Returns a disposer that unregisters.
 */
export function onRealtimeConnect(
  pb: PocketBase,
  cb: () => void,
): () => void {
  let dispose: (() => Promise<void>) | null = null
  let disposed = false

  pb.realtime
    .subscribe('PB_CONNECT', () => {
      if (!disposed) cb()
    })
    .then((unsubscribe) => {
      if (disposed) {
        unsubscribe().catch(() => {})
      } else {
        dispose = unsubscribe
      }
    })
    .catch((err) => {
      console.warn('[pb] realtime connect notice:', (err as Error).message)
    })

  return () => {
    disposed = true
    const unsubscribe = dispose
    dispose = null
    if (unsubscribe) unsubscribe().catch(() => {})
  }
}