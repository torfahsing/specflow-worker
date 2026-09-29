/**
 * Daemon entry point for @specflow/worker.
 *
 * T12 — complete implementation:
 *   startup order (config → auth → presence → watchdog → subscribe → drain),
 *   single-slot serial work pump, SIGINT/SIGTERM graceful shutdown.
 *
 * Mirrors the shutdown pattern of specflow/packages/orchestrator/src/server.ts
 * (shuttingDown latch, double-signal forced exit, .unref() cap on finalize).
 */

import { loadConfig, type WorkerConfig } from './config.js'
import {
  createClient,
  authenticate,
  isAvailable,
  startAuthWatchdog,
  onRealtimeConnect,
  type AuthOptions,
} from './pb/client.js'
import { Presence } from './presence.js'
import { drainQueued, claimTask, subscribeToQueued, type ClaimedTask } from './queue.js'
import { executeClaimedTask } from './runner.js'
import { PocketBaseStore } from './store.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_WORKER_HEARTBEAT_MS = 30_000
const DEFAULT_WORKER_POLL_INTERVAL_MS = 5_000
const SHUTDOWN_FINALIZE_CAP_MS = 5_000

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.error('Usage: specflow-worker start')
  console.error('')
  console.error('Commands:')
  console.error('  start   Run the daemon (connect to PocketBase, claim and execute tasks)')
  console.error('')
  console.error('Options:')
  console.error('  --help, -h  Show this help message')
}

// ---------------------------------------------------------------------------
// main — CLI entry
// ---------------------------------------------------------------------------

export async function main(argv: string[]): Promise<void> {
  // --help / -h
  if (argv.includes('--help') || argv.includes('-h')) {
    printUsage()
    process.exit(0)
  }

  // Only the `start` subcommand is accepted
  if (argv.length !== 1 || argv[0] !== 'start') {
    printUsage()
    process.exit(1)
  }

  // -------------------------------------------------------------------------
  // Step 1: load configuration
  // -------------------------------------------------------------------------
  const config = await loadConfig()

  console.log(
    `[worker] starting: name=${config.workerName} url=${config.pocketbaseUrl} env=${config.workerEnvPath || 'none'}`,
  )

  // -------------------------------------------------------------------------
  // Step 2: create PocketBase client
  // -------------------------------------------------------------------------
  const pb = createClient(config.pocketbaseUrl)

  // -------------------------------------------------------------------------
  // Step 3: health check — fatal if unreachable
  // -------------------------------------------------------------------------
  const available = await isAvailable(pb)
  if (!available) {
    console.error(`[worker] FATAL: PocketBase is unreachable at ${config.pocketbaseUrl}`)
    process.exit(1)
  }

  // -------------------------------------------------------------------------
  // Step 4: authenticate — fatal if auth fails
  // -------------------------------------------------------------------------
  const authOpts: AuthOptions = {
    token: config.pocketbaseToken,
    email: config.adminEmail,
    password: config.adminPassword,
    latch: { failed: false },
  }

  const authed = await authenticate(pb, authOpts)
  if (!authed) {
    console.error(
      '[worker] FATAL: Failed to authenticate with PocketBase. Verify POCKETBASE_TOKEN or POCKETBASE_ADMIN_EMAIL/POCKETBASE_ADMIN_PASSWORD.',
    )
    process.exit(1)
  }

  // -------------------------------------------------------------------------
  // Step 5: presence — upsert local_workers record + start heartbeat
  // -------------------------------------------------------------------------
  const presence = new Presence(pb, config.workerName, ['git'], DEFAULT_WORKER_HEARTBEAT_MS)
  const workerId = await presence.ensure()
  presence.start()

  // -------------------------------------------------------------------------
  // Step 6: auth watchdog (re-auth on stale auth store)
  // -------------------------------------------------------------------------
  const stopWatchdog = startAuthWatchdog(pb, authOpts, DEFAULT_WORKER_HEARTBEAT_MS)

  // -------------------------------------------------------------------------
  // Step 7: work-loop state
  // -------------------------------------------------------------------------
  const pending = new Set<string>()
  let activePromise: Promise<unknown> | null = null
  let shuttingDown = false
  let unsub: (() => Promise<void>) | null = null
  let stopRealtimeConnect: (() => void) | null = null
  let pollInterval: ReturnType<typeof setInterval> | null = null

  // The shutdown signal controller — its signal is passed to executeClaimedTask
  // so that aborting it kills the in-flight child process.
  const shutdownController = new AbortController()

  // -------------------------------------------------------------------------
  // Step 8: drain helper — fetches queued tasks and adds them to pending
  // -------------------------------------------------------------------------
  async function drainAndEnqueue(): Promise<void> {
    const ids = await drainQueued(pb)
    for (const id of ids) {
      pending.add(id)
    }
  }

  // -------------------------------------------------------------------------
  // Step 9: single-slot serial pump
  // -------------------------------------------------------------------------
  async function pump(): Promise<void> {
    // Skip while a task is in flight
    if (activePromise !== null) return

    while (pending.size > 0 && !shuttingDown) {
      const taskId = pending.values().next().value!
      pending.delete(taskId)

      // Claim the task
      const claimed = await claimTask(pb, taskId, workerId)
      if (!claimed) continue

      // Execute the task — single-slot serial execution
      activePromise = executeClaimedTask(claimed, {
        store: new PocketBaseStore(pb),
        presence,
        config,
      }, shutdownController.signal)

      try {
        await activePromise
      } catch (err) {
        console.warn('[worker] executeClaimedTask error:', (err as Error).message)
      } finally {
        activePromise = null
      }

      // After task completion, drain again (catch-up for tasks queued during execution)
      if (!shuttingDown) {
        await drainAndEnqueue()
      }
    }
  }

  // -------------------------------------------------------------------------
  // Step 10: subscribe to queued tasks (only after auth — A4)
  // -------------------------------------------------------------------------
  const onQueued = (taskId: string): void => {
    if (shuttingDown) return
    pending.add(taskId)
    // Kick the pump if idle
    if (activePromise === null && !shuttingDown) {
      pump().catch((err) => {
        console.warn('[worker] pump error:', (err as Error).message)
      })
    }
  }

  try {
    unsub = await subscribeToQueued(pb, onQueued)
  } catch (err) {
    console.warn('[pb] subscribe notice:', (err as Error).message)
  }

  // Re-drain on every realtime reconnect (PB_CONNECT)
  stopRealtimeConnect = onRealtimeConnect(pb, async () => {
    await drainAndEnqueue()
    // Kick the pump after reconnect if idle
    if (activePromise === null && !shuttingDown) {
      pump().catch((err) => {
        console.warn('[worker] pump error:', (err as Error).message)
      })
    }
  })

  // -------------------------------------------------------------------------
  // Step 11: initial catch-up drain
  // -------------------------------------------------------------------------
  await drainAndEnqueue()

  // -------------------------------------------------------------------------
  // Step 12: safety poll — low-frequency catch-up for missed events
  // -------------------------------------------------------------------------
  pollInterval = setInterval(() => {
    if (shuttingDown || activePromise !== null) return
    drainAndEnqueue().catch((err) => {
      console.warn('[worker] poll drain error:', (err as Error).message)
    })
  }, DEFAULT_WORKER_POLL_INTERVAL_MS)
  pollInterval.unref()

  // -------------------------------------------------------------------------
  // Step 13: kick the initial pump if there are already queued tasks
  // -------------------------------------------------------------------------
  if (pending.size > 0 && activePromise === null) {
    pump().catch((err) => {
      console.warn('[worker] pump error:', (err as Error).message)
    })
  }

  // -------------------------------------------------------------------------
  // Step 14: signal wiring — graceful shutdown
  // -------------------------------------------------------------------------
  const gracefulShutdown = async (): Promise<void> => {
    if (shuttingDown) {
      console.log('[worker] Forced exit.')
      process.exit(1)
    }

    shuttingDown = true
    console.log('[worker] shutting down…')

    // Abort the shutdown controller — this propagates to the runner's
    // AbortController, which kills the child process via Bun's signal
    // handling. The runner then finalizes the run as cancelled.
    if (!shutdownController.signal.aborted) {
      shutdownController.abort()
    }

    // Wait for the in-flight finalize with a .unref() cap so an unreachable
    // PB never hangs exit.
    if (activePromise !== null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => resolve(), SHUTDOWN_FINALIZE_CAP_MS)
        timer.unref()
        // Poll for activePromise to clear
        const check = setInterval(() => {
          if (activePromise === null) {
            clearInterval(check)
            clearTimeout(timer)
            resolve()
          }
        }, 50)
        timer.unref()
      })
    }

    // Presence offline (best-effort)
    await presence.stop().catch(() => {})

    // Unsubscribe from realtime
    if (unsub) {
      await unsub().catch(() => {})
      unsub = null
    }

    // Stop the auth watchdog
    stopWatchdog()

    // Stop the safety poll
    if (pollInterval !== null) {
      clearInterval(pollInterval)
      pollInterval = null
    }

    // Unsubscribe from PB_CONNECT
    if (stopRealtimeConnect) {
      stopRealtimeConnect()
      stopRealtimeConnect = null
    }

    process.exit(0)
  }

  process.on('SIGINT', gracefulShutdown)
  process.on('SIGTERM', gracefulShutdown)

  // -------------------------------------------------------------------------
  // Step 15: idle — the pump runs itself when tasks arrive via SSE or poll
  // -------------------------------------------------------------------------
  // The process stays alive via the intervals and the realtime subscription.
  // The daemon does not open any inbound socket.
}

// Self-invoke when run directly (bun run src/cli.ts start, compiled binary)
// so the module entry behaves identically to index.ts. When index.ts is the
// entry point, import.meta.main is false here and main runs exactly once.
if (import.meta.main) {
  await main(process.argv.slice(2))
}
