/**
 * Daemon entry point for @specflow/worker.
 *
 * Connects to Specflow orchestrator via HTTP/SSE using Bearer token authentication.
 * Single-slot serial work pump, graceful shutdown on SIGINT/SIGTERM.
 */

import { loadConfig, type WorkerConfig } from './config.js'
import { SpecflowClient } from './client.js'
import { Presence } from './presence.js'
import { drainQueued, claimTask, subscribeToQueued, type ClaimedTask } from './queue.js'
import { executeClaimedTask } from './runner.js'
import { HttpWorkerStore } from './store.js'

import { discoverLocalManifest } from './discovery.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_WORKER_HEARTBEAT_MS = 30_000
const DEFAULT_WORKER_POLL_INTERVAL_MS = 10_000
const SHUTDOWN_FINALIZE_CAP_MS = 5_000

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.error('Usage: specflow-worker start')
  console.error('')
  console.error('Commands:')
  console.error('  start   Run the daemon (connect to Specflow, claim and execute tasks)')
  console.error('')
  console.error('Options:')
  console.error('  --help, -h  Show this help message')
}

// ---------------------------------------------------------------------------
// main — CLI entry
// ---------------------------------------------------------------------------

export async function main(argv: string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    printUsage()
    process.exit(0)
  }

  if (argv.length !== 1 || argv[0] !== 'start') {
    printUsage()
    process.exit(1)
  }

  // -------------------------------------------------------------------------
  // Step 1: load configuration
  // -------------------------------------------------------------------------
  const config = await loadConfig()

  console.log(
    `[worker] starting: name=${config.workerName} url=${config.specflowUrl} env=${config.workerEnvPath || 'none'}`,
  )

  if (!config.specflowToken) {
    console.error(
      '[worker] FATAL: Missing SPECFLOW_TOKEN. Generate a token from the Specflow web dashboard and set it in your environment or ~/.specflow/worker.env.',
    )
    process.exit(1)
  }

  // -------------------------------------------------------------------------
  // Step 2: create Specflow HTTP/SSE client
  // -------------------------------------------------------------------------
  const client = new SpecflowClient({
    baseUrl: config.specflowUrl || 'http://127.0.0.1:3200',
    token: config.specflowToken,
  })

  // -------------------------------------------------------------------------
  // Step 3: discovery & presence — probe local capabilities, models & register
  // -------------------------------------------------------------------------
  const manifest = await discoverLocalManifest()
  if (manifest.models.length > 0) {
    console.log(`[worker] discovered ${manifest.models.length} models from local provider CLI`)
  }

  const presence = new Presence(client, config.workerName, manifest, DEFAULT_WORKER_HEARTBEAT_MS)
  const workerId = await presence.ensure()

  if (!workerId) {
    console.error(
      `[worker] FATAL: Failed to authenticate or register presence with Specflow at ${config.specflowUrl}. Verify SPECFLOW_TOKEN.`,
    )
    process.exit(1)
  }

  presence.start()
  console.log(`[worker] registered: worker_id=${workerId}`)

  // -------------------------------------------------------------------------
  // Step 4: work-loop state
  // -------------------------------------------------------------------------
  const pending = new Set<string>()
  let activePromise: Promise<unknown> | null = null
  let shuttingDown = false
  let unsub: (() => Promise<void>) | null = null
  let pollInterval: ReturnType<typeof setInterval> | null = null

  const shutdownController = new AbortController()
  const store = new HttpWorkerStore(client)

  // -------------------------------------------------------------------------
  // Step 5: drain helper — catches up on queued tasks
  // -------------------------------------------------------------------------
  async function drainAndEnqueue(): Promise<void> {
    const ids = await drainQueued(client)
    for (const id of ids) {
      pending.add(id)
    }
  }

  // -------------------------------------------------------------------------
  // Step 6: single-slot serial pump
  // -------------------------------------------------------------------------
  async function pump(): Promise<void> {
    if (activePromise !== null) return

    while (pending.size > 0 && !shuttingDown) {
      const taskId = pending.values().next().value!
      pending.delete(taskId)

      // Claim the task atomically
      const claimed = await claimTask(client, taskId, workerId)
      if (!claimed) continue

      // Execute the task
      activePromise = executeClaimedTask(
        claimed,
        {
          store,
          presence,
          config,
        },
        shutdownController.signal,
      )

      try {
        await activePromise
      } catch (err: any) {
        console.warn('[worker] executeClaimedTask error:', err?.message || String(err))
      } finally {
        activePromise = null
      }

      if (!shuttingDown) {
        await drainAndEnqueue()
      }
    }
  }

  // -------------------------------------------------------------------------
  // Step 7: subscribe to SSE stream
  // -------------------------------------------------------------------------
  const onQueued = (taskId: string): void => {
    if (shuttingDown) return
    pending.add(taskId)
    if (activePromise === null && !shuttingDown) {
      pump().catch((err: any) => {
        console.warn('[worker] pump error:', err?.message || String(err))
      })
    }
  }

  try {
    unsub = await subscribeToQueued(client, onQueued)
  } catch (err: any) {
    console.warn('[worker] subscribe notice:', err?.message || String(err))
  }

  // -------------------------------------------------------------------------
  // Step 8: initial catch-up drain
  // -------------------------------------------------------------------------
  await drainAndEnqueue()
  if (pending.size > 0) {
    pump().catch(() => {})
  }

  // -------------------------------------------------------------------------
  // Step 9: safety poll — periodic catch-up for missed events
  // -------------------------------------------------------------------------
  pollInterval = setInterval(() => {
    if (shuttingDown || activePromise !== null) return
    drainAndEnqueue().then(() => {
      if (pending.size > 0 && activePromise === null && !shuttingDown) {
        pump().catch(() => {})
      }
    }).catch(() => {})
  }, DEFAULT_WORKER_POLL_INTERVAL_MS)
  pollInterval.unref()

  // -------------------------------------------------------------------------
  // Step 10: graceful shutdown
  // -------------------------------------------------------------------------
  let shutdownDone = false

  async function shutdown(signalName: string): Promise<void> {
    if (shuttingDown) {
      console.warn(`[worker] forced shutdown on second ${signalName}`)
      process.exit(1)
    }
    shuttingDown = true
    console.log(`[worker] shutting down (${signalName})...`)

    if (pollInterval !== null) {
      clearInterval(pollInterval)
      pollInterval = null
    }

    if (unsub) {
      await unsub().catch(() => {})
    }

    shutdownController.abort()

    if (activePromise !== null) {
      console.log('[worker] waiting for active task to finalize...')
      const cap = new Promise((resolve) => setTimeout(resolve, SHUTDOWN_FINALIZE_CAP_MS))
      await Promise.race([activePromise, cap]).catch(() => {})
    }

    await presence.stop().catch(() => {})
    shutdownDone = true
    console.log('[worker] shutdown complete')
    process.exit(0)
  }

  process.on('SIGINT', () => { shutdown('SIGINT').catch(() => process.exit(1)) })
  process.on('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(1)) })
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((err: any) => {
    console.error('[worker] fatal:', err?.message || String(err))
    process.exit(1)
  })
}
