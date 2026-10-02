/**
 * Daemon entry point for @specflow/worker.
 *
 * Connects to Specflow orchestrator via HTTP/SSE using Bearer token authentication.
 * Single-slot serial work pump, graceful shutdown on SIGINT/SIGTERM.
 */

import { loadConfig, saveWorkerEnv, type WorkerConfig } from './config.js'
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
// Helpers
// ---------------------------------------------------------------------------

function isLocalUrl(urlStr: string): boolean {
  try {
    const u = new URL(urlStr)
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '0.0.0.0'
  } catch {
    return false
  }
}

async function tryAutoProvisionLocalToken(baseUrl: string, workerName: string): Promise<string | null> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/user/worker-tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: workerName }),
      signal: AbortSignal.timeout(3000),
    })
    if (res.ok) {
      const data = await res.json()
      if (data?.token && typeof data.token === 'string') {
        return data.token
      }
    }
  } catch {
    // server unreachable or requires auth
  }
  return null
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log('Usage: specflow-worker <command> [options]')
  console.log('')
  console.log('Commands:')
  console.log('  connect [url]   Connect and pair this worker with a Specflow orchestrator')
  console.log('  start           Run the daemon (claim and execute tasks)')
  console.log('  status          Show worker configuration and connection status')
  console.log('')
  console.log('Connect Options:')
  console.log('  --token, -t <token>   Worker authentication token')
  console.log('  --name, -n <name>     Worker machine name (default: hostname)')
  console.log('  --start               Immediately start the daemon after connecting')
  console.log('')
  console.log('General Options:')
  console.log('  --help, -h            Show this help message')
}

// ---------------------------------------------------------------------------
// Command: connect
// ---------------------------------------------------------------------------

async function handleConnect(args: string[]): Promise<void> {
  let url = ''
  let token = ''
  let name = ''
  let startAfter = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--token' || arg === '-t') {
      token = args[++i] || ''
    } else if (arg === '--name' || arg === '-n') {
      name = args[++i] || ''
    } else if (arg === '--url' || arg === '-u') {
      url = args[++i] || ''
    } else if (arg === '--start') {
      startAfter = true
    } else if (!arg.startsWith('-') && !url) {
      url = arg
    }
  }

  const existingConfig = await loadConfig()
  url = url || existingConfig.specflowUrl || 'http://localhost:3200'
  name = name || existingConfig.workerName

  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = `http://${url}`
  }
  url = url.replace(/\/+$/, '')

  if (!token) {
    if (isLocalUrl(url)) {
      console.log(`[worker] No token provided. Checking local Specflow instance at ${url}...`)
      const autoToken = await tryAutoProvisionLocalToken(url, name)
      if (autoToken) {
        token = autoToken
        console.log(`[worker] Auto-provisioned worker token from local Specflow instance.`)
      }
    }
  }

  if (!token) {
    console.error(`[worker] Error: --token is required to connect to ${url}`)
    console.error(`[worker] Generate a worker token in Specflow and run:`)
    console.error(`[worker]   specflow-worker connect ${url} --token <token>`)
    process.exit(1)
  }

  console.log(`[worker] Verifying connection to ${url} (worker: ${name})...`)
  const client = new SpecflowClient({ baseUrl: url, token })

  try {
    const result = await client.heartbeat({
      worker_name: name,
      status: 'online',
    })

    const envPath = await saveWorkerEnv({
      specflowUrl: url,
      specflowToken: token,
      workerName: name,
    })

    console.log(`[worker] ✓ Successfully connected to Specflow!`)
    console.log(`[worker] Registered worker ID: ${result.worker_id}`)
    console.log(`[worker] Configuration saved to ${envPath}`)

    if (startAfter) {
      console.log(`[worker] Starting daemon...`)
      await runDaemon()
    } else {
      console.log(`[worker] Run 'specflow-worker start' to launch the worker daemon.`)
    }
  } catch (err: any) {
    console.error(`[worker] Connection failed: ${err?.message || String(err)}`)
    console.error(`[worker] Verify that Specflow is reachable at ${url} and that the token is valid.`)
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// Command: status
// ---------------------------------------------------------------------------

async function handleStatus(): Promise<void> {
  const config = await loadConfig()
  console.log(`[worker] Configured Specflow URL: ${config.specflowUrl}`)
  console.log(`[worker] Worker name:           ${config.workerName}`)
  console.log(`[worker] Config file:           ${config.workerEnvPath}`)
  console.log(`[worker] Token configured:      ${config.specflowToken ? 'yes (' + config.specflowToken.slice(0, 12) + '...)' : 'no'}`)

  if (!config.specflowToken) {
    console.log(`[worker] Status: Not paired. Run 'specflow-worker connect <url> --token <token>' to connect.`)
    return
  }

  console.log(`[worker] Testing connection...`)
  const client = new SpecflowClient({ baseUrl: config.specflowUrl, token: config.specflowToken })
  try {
    const res = await client.heartbeat({ worker_name: config.workerName, status: 'online' })
    console.log(`[worker] Status: ✓ Connected (registered worker ID: ${res.worker_id})`)
  } catch (err: any) {
    console.log(`[worker] Status: ✗ Offline / Error (${err?.message || String(err)})`)
  }
}

// ---------------------------------------------------------------------------
// Command: start (daemon)
// ---------------------------------------------------------------------------

async function runDaemon(): Promise<void> {
  let config = await loadConfig()

  if (!config.specflowToken) {
    if (isLocalUrl(config.specflowUrl)) {
      console.log(`[worker] No token found. Checking local Specflow at ${config.specflowUrl}...`)
      const autoToken = await tryAutoProvisionLocalToken(config.specflowUrl, config.workerName)
      if (autoToken) {
        config.specflowToken = autoToken
        const envPath = await saveWorkerEnv({
          specflowUrl: config.specflowUrl,
          specflowToken: autoToken,
          workerName: config.workerName,
        })
        console.log(`[worker] Auto-provisioned worker token. Saved to ${envPath}`)
      }
    }
  }

  if (!config.specflowToken) {
    console.error(`[worker] Error: No worker token configured.`)
    console.error(`[worker] Connect this worker daemon to Specflow (local, dogfood, or cloud) by running:`)
    console.error(``)
    console.error(`  specflow-worker connect <specflow-url> --token <worker-token>`)
    console.error(``)
    console.error(`Example:`)
    console.error(`  specflow-worker connect ${config.specflowUrl} --token sfw_live_...`)
    process.exit(1)
  }

  console.log(
    `[worker] starting: name=${config.workerName} url=${config.specflowUrl} env=${config.workerEnvPath || 'none'}`,
  )

  const client = new SpecflowClient({
    baseUrl: config.specflowUrl || 'http://127.0.0.1:3200',
    token: config.specflowToken,
  })

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

  const pending = new Set<string>()
  let activePromise: Promise<unknown> | null = null
  let shuttingDown = false
  let unsub: (() => Promise<void>) | null = null
  let pollInterval: ReturnType<typeof setInterval> | null = null

  const shutdownController = new AbortController()
  const store = new HttpWorkerStore(client)

  async function drainAndEnqueue(): Promise<void> {
    const ids = await drainQueued(client)
    for (const id of ids) {
      pending.add(id)
    }
  }

  async function pump(): Promise<void> {
    if (activePromise !== null) return

    while (pending.size > 0 && !shuttingDown) {
      const taskId = pending.values().next().value!
      pending.delete(taskId)

      const claimed = await claimTask(client, taskId, workerId)
      if (!claimed) continue

      activePromise = executeClaimedTask(
        claimed,
        {
          store,
          presence,
          config,
        },
        shutdownController.signal,
      )
        .catch((err) => {
          console.error(`[worker] task execution error:`, err?.message || String(err))
        })
        .finally(() => {
          activePromise = null
          if (!shuttingDown) {
            pump().catch(() => {})
          }
        })

      return
    }
  }

  try {
    await drainAndEnqueue()
  } catch (err: any) {
    console.error(`[worker] initial drain warning:`, err?.message || String(err))
  }
  pump().catch(() => {})

  try {
    unsub = await subscribeToQueued(client, (taskId) => {
      if (shuttingDown) return
      pending.add(taskId)
      pump().catch(() => {})
    })
    console.log(`[worker] SSE subscription established`)
  } catch (err: any) {
    console.warn(`[worker] SSE subscribe failed (${err?.message || String(err)}), falling back to polling`)
  }

  pollInterval = setInterval(async () => {
    if (shuttingDown) return
    try {
      await drainAndEnqueue()
      pump().catch(() => {})
    } catch {
      // transient poll error
    }
  }, DEFAULT_WORKER_POLL_INTERVAL_MS)

  let shutdownDone = false
  async function shutdown(signal: string): Promise<void> {
    if (shutdownDone) return
    shuttingDown = true
    console.log(`[worker] received ${signal}, shutting down gracefully...`)

    if (pollInterval !== null) {
      clearInterval(pollInterval)
      pollInterval = null
    }

    if (unsub !== null) {
      await unsub().catch(() => {})
      unsub = null
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

// ---------------------------------------------------------------------------
// main — CLI entry
// ---------------------------------------------------------------------------

export async function main(argv: string[]): Promise<void> {
  const cmd = argv[0]

  if (argv.includes('--help') || argv.includes('-h') || !cmd) {
    printUsage()
    process.exit(0)
  }

  if (cmd === 'connect') {
    await handleConnect(argv.slice(1))
    return
  }

  if (cmd === 'status') {
    await handleStatus()
    return
  }

  if (cmd === 'start') {
    await runDaemon()
    return
  }

  console.error(`Unknown command: ${cmd}`)
  printUsage()
  process.exit(1)
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((err: any) => {
    console.error('[worker] fatal:', err?.message || String(err))
    process.exit(1)
  })
}
