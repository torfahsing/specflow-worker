/**
 * Daemon entry point for @specflow/worker.
 *
 * Connects to Specflow orchestrator via HTTP/SSE using Bearer token authentication.
 * Single-slot serial work pump, graceful shutdown on SIGINT/SIGTERM.
 */

import path from 'node:path'
import { loadConfig, saveWorkerEnv, DEFAULT_WORKER_CONCURRENCY } from './config.js'
import type { WorkerConfig } from './config.js'
import { SpecflowClient } from './client.js'
import { Presence } from './presence.js'
import { subscribeToControl } from './queue.js'
import type { ClaimedTask, ControlMessage } from './queue.js'
import { executeClaimedTask } from './runner.js'
import { HttpWorkerStore } from './store.js'
import { discoverLocalManifest, probeCapabilities, probeModels } from './discovery.js'
import * as git from './git/utils.js'
import { inspectCodebase, runVerification } from './project.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_WORKER_HEARTBEAT_MS = 30_000
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
      const data = (await res.json()) as any
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
    } else if (arg && !arg.startsWith('-') && !url) {
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

  const presence = new Presence(client, config.workerName, undefined, DEFAULT_WORKER_HEARTBEAT_MS)

  // Retry registration with backoff — worker can start before specflow is up.
  let workerId: string | null = null
  let attempt = 0
  while (!workerId) {
    workerId = await presence.ensure()
    if (!workerId) {
      const delay = Math.min(1000 * 2 ** attempt, 30000)
      console.log(`[worker] specflow not reachable at ${config.specflowUrl}, retrying in ${delay / 1000}s...`)
      await new Promise(r => setTimeout(r, delay))
      attempt++
    }
  }

  presence.start()
  console.log(`[worker] registered: worker_id=${workerId}`)

  const pending = new Set<string>()
  const taskPayloads = new Map<string, { task: Record<string, unknown>; runId?: string }>()
  interface ActiveTaskInfo {
    taskId: string
    taskSlug?: string
    featureId: string
    featureName?: string
    controller: AbortController
    promise: Promise<unknown>
  }
  const activeTasks = new Map<string, ActiveTaskInfo>()
  let activeChatTask: ActiveTaskInfo | null = null
  const concurrency = config.concurrency ?? DEFAULT_WORKER_CONCURRENCY
  let shuttingDown = false
  let unsub: (() => Promise<void>) | null = null

  const shutdownController = new AbortController()
  const store = new HttpWorkerStore(client)

  async function pump(): Promise<void> {
    if (activeTasks.size >= concurrency || shuttingDown) return

    while (activeTasks.size < concurrency && pending.size > 0 && !shuttingDown) {
      const taskId = pending.values().next().value!
      pending.delete(taskId)

      const payload = taskPayloads.get(taskId)
      taskPayloads.delete(taskId)
      if (!payload || !payload.task) continue

      const taskRecord = payload.task
      const taskIdFromPayload = (taskRecord.task_id || taskRecord.id) as string | undefined
      const featIdFromPayload = (taskRecord.featureId || taskRecord.feature) as string | undefined
      const featNameFromPayload = (taskRecord.feature_name || taskRecord.featureName || taskRecord.feature) as string | undefined

      const claimed: ClaimedTask = {
        id: taskId,
        featureId: featIdFromPayload || '',
        record: taskRecord,
        runId: payload.runId,
      }

      const taskController = new AbortController()
      const onShutdown = () => taskController.abort()
      shutdownController.signal.addEventListener('abort', onShutdown, { once: true })

      const promise = executeClaimedTask(
        claimed,
        {
          store,
          presence,
          config,
        },
        taskController.signal,
      )
        .catch((err) => {
          console.error(`[worker] task execution error:`, err?.message || String(err))
        })
        .finally(() => {
          shutdownController.signal.removeEventListener('abort', onShutdown)
          activeTasks.delete(claimed.id)
          if (!shuttingDown) {
            pump().catch(() => {})
          }
        })

      activeTasks.set(claimed.id, {
        taskId: claimed.id,
        taskSlug: taskIdFromPayload,
        featureId: claimed.featureId,
        featureName: featNameFromPayload,
        controller: taskController,
        promise,
      })
    }
  }

  function handleControl(ctrl: ControlMessage): void {
    if (ctrl.action === 'run_task') {
      const taskId = (ctrl.taskId || ctrl.task_id) as string | undefined
      if (taskId && ctrl.task) {
        console.log(`[worker] received run_task command for task "${taskId}"`)
        taskPayloads.set(taskId, { task: ctrl.task as Record<string, unknown>, runId: ctrl.runId as string | undefined })
        pending.add(taskId)
        pump().catch(() => {})
      }
      return
    }

    if (ctrl.action === 'chat_step') {
      const taskId = (ctrl.taskId || ctrl.task_id || `chat_${Date.now()}`) as string
      console.log(`[worker] received chat_step command for task "${taskId}"`)
      const taskRecord = (ctrl.task as Record<string, unknown> | undefined) || {
        prompt: ctrl.prompt,
        role: 'colleague',
        task_type: 'chat_step',
        provider_command: ctrl.command || config.providerCommand || 'openrouter-agent',
        models: ctrl.models || (ctrl.model ? [ctrl.model] : []),
        allowed_tools: ctrl.allowedTools || ['file_read', 'list_dir', 'grep', 'glob'],
        project_dir: ctrl.cwd || ctrl.project_dir,
        git_branch: ctrl.branch,
        timeout: ctrl.timeout,
      }
      const claimed: ClaimedTask = {
        id: taskId,
        featureId: (ctrl.featureId || ctrl.feature_id || ctrl.feature || '') as string,
        record: taskRecord,
        runId: ctrl.runId as string | undefined,
        isChat: true,
      }

      const taskController = new AbortController()
      const onShutdown = () => taskController.abort()
      shutdownController.signal.addEventListener('abort', onShutdown, { once: true })

      const promise = executeClaimedTask(
        claimed,
        {
          store,
          presence,
          config,
        },
        taskController.signal,
      )
        .catch((err) => {
          console.error(`[worker] chat_step execution error:`, err?.message || String(err))
        })
        .finally(() => {
          shutdownController.signal.removeEventListener('abort', onShutdown)
          if (activeChatTask?.taskId === taskId) {
            activeChatTask = null
          }
        })

      activeChatTask = {
        taskId,
        taskSlug: (ctrl.task_id || ctrl.taskId || taskId) as string,
        featureId: claimed.featureId,
        featureName: (ctrl.feature_name || ctrl.featureName || ctrl.feature) as string | undefined,
        controller: taskController,
        promise,
      }
      return
    }

    if (ctrl.action.startsWith('query:') || ctrl.action.startsWith('query_')) {
      const queryId = ctrl.queryId
      const command = ctrl.command || config.providerCommand || 'openrouter-agent'
      if (!queryId) return

      const action = ctrl.action.replace('_', ':')
      console.log(`[worker] handling on-demand query "${action}" (id=${queryId}, command=${command})`)

      Promise.resolve().then(async () => {
        try {
          if (action === 'query:models') {
            const models = await probeModels(command)
            await client.sendQueryResponse(queryId, models)
          } else if (action === 'query:capabilities') {
            const caps = await probeCapabilities(command)
            await client.sendQueryResponse(queryId, caps)
          }
        } catch (err: any) {
          console.warn(`[worker] query "${action}" error:`, err?.message || String(err))
          await client.sendQueryResponse(queryId, null, err?.message || String(err)).catch(() => {})
        }
      })
      return
    }

    if (ctrl.action.startsWith('git:')) {
      const queryId = ctrl.queryId
      if (!queryId) return
      const dir = ctrl.dir as string

      Promise.resolve().then(async () => {
        try {
          if (ctrl.action === 'git:init_repo') {
            await git.initRepo(dir)
            await client.sendQueryResponse(queryId, { ok: true })
          } else if (ctrl.action === 'git:validate_branch') {
            const isRepo = await git.isGitRepo(dir)
            if (!isRepo) {
              await client.sendQueryResponse(queryId, { error: null })
            } else {
              const exists = ctrl.branch ? await git.branchExists(dir, ctrl.branch) : false
              if (!exists) {
                await client.sendQueryResponse(queryId, { error: null })
              } else {
                const dirty = await git.hasUncommittedChanges(dir)
                if (dirty) {
                  if (ctrl.isFirstPhase) {
                    await client.sendQueryResponse(queryId, {
                      error: 'Working directory has uncommitted changes. Commit or stash before running a phase.',
                    })
                  } else {
                    console.log(`[worker] uncommitted changes detected in working directory — skipping rebase onto main`)
                    await client.sendQueryResponse(queryId, { error: null })
                  }
                } else {
                  try {
                    console.log(`[worker] rebasing '${ctrl.branch}' onto main before phase`)
                    if (ctrl.branch) {
                      await git.rebaseBranch(dir, ctrl.branch)
                    }
                    await client.sendQueryResponse(queryId, { error: null })
                  } catch (err: any) {
                    await client.sendQueryResponse(queryId, {
                      error: `Branch '${ctrl.branch}' rebase onto main failed: ${err.message}`,
                    })
                  }
                }
              }
            }
          } else if (ctrl.action === 'git:commit_phase') {
            const isRepo = await git.isGitRepo(dir)
            if (!isRepo) {
              await client.sendQueryResponse(queryId, { committed: false })
            } else {
              const committed = await git.commitChanges(dir, ctrl.message || '')
              await client.sendQueryResponse(queryId, { committed })
            }
          } else if (ctrl.action === 'git:get_changed_files') {
            const isRepo = await git.isGitRepo(dir)
            if (!isRepo) {
              await client.sendQueryResponse(queryId, { files: [] })
            } else {
              const files = await git.getChangedFiles(dir, ctrl.base)
              await client.sendQueryResponse(queryId, { files })
            }
          } else if (ctrl.action === 'git:get_bounded_diff') {
            const isRepo = await git.isGitRepo(dir)
            if (!isRepo) {
              await client.sendQueryResponse(queryId, { diff: null })
            } else {
              const diff = await git.getBoundedDiff(dir, ctrl.branch || null, ctrl.maxDiffChars)
              await client.sendQueryResponse(queryId, { diff })
            }
          } else if (ctrl.action === 'git:get_file_diff') {
            const isRepo = await git.isGitRepo(dir)
            if (!isRepo) {
              await client.sendQueryResponse(queryId, { error: 'Not a git repo' })
            } else {
              const fileDiff = await git.getFileDiff(dir, ctrl.filepath || '', ctrl.branch || 'HEAD')
              await client.sendQueryResponse(queryId, { diff: fileDiff })
            }
          } else if (ctrl.action === 'git:finalize') {
            const isRepo = await git.isGitRepo(dir)
            if (!isRepo) {
              await client.sendQueryResponse(queryId, { prUrl: null })
            } else {
              let prUrl: string | null = null
              if (await git.hasRemote(dir)) {
                if (ctrl.branch) {
                  console.log(`[worker] pushing branch "${ctrl.branch}"`)
                  await git.pushBranch(dir, ctrl.branch)
                }
                console.log(`[worker] creating PR for "${ctrl.featureName || 'feature'}"`)
                prUrl = await git.createPullRequest(
                  dir,
                  ctrl.featureName || 'Feature',
                  ctrl.description || '',
                  ctrl.branch || '',
                )
              }
              await client.sendQueryResponse(queryId, { prUrl })
            }
          } else if (ctrl.action === 'git:is_repo') {
            const isRepo = await git.isGitRepo(dir)
            await client.sendQueryResponse(queryId, { isRepo })
          } else {
            await client.sendQueryResponse(queryId, null, `Unknown git action: ${ctrl.action}`)
          }
        } catch (err: any) {
          console.warn(`[worker] git action "${ctrl.action}" failed:`, err?.message || String(err))
          await client.sendQueryResponse(queryId, null, err?.message || String(err)).catch(() => {})
        }
      })
      return
    }

    if (ctrl.action.startsWith('fs:')) {
      const queryId = ctrl.queryId
      if (!queryId) return

      Promise.resolve().then(async () => {
        try {
          if (ctrl.action === 'fs:read_file') {
            const filePath = ctrl.path as string
            const maxBytes = typeof ctrl.maxBytes === 'number' ? ctrl.maxBytes : 500_000
            const file = Bun.file(filePath)
            if (!(await file.exists())) {
              await client.sendQueryResponse(queryId, { content: null })
            } else {
              let content = await file.text()
              if (content.length > maxBytes) {
                content = content.slice(0, maxBytes)
              }
              await client.sendQueryResponse(queryId, { content })
            }
          } else if (ctrl.action === 'fs:find_files') {
            const dir = ctrl.dir as string
            const rawPatterns: string[] = Array.isArray(ctrl.patterns)
              ? ctrl.patterns
              : (ctrl.pattern ? [ctrl.pattern] : [])
            const maxResults = typeof ctrl.maxResults === 'number' ? ctrl.maxResults : 50

            const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.cache', '__pycache__'])
            const results: string[] = []

            const walk = async (currentDir: string, relative: string) => {
              if (results.length >= maxResults) return
              try {
                const { readdir } = await import('node:fs/promises')
                const entries = await readdir(currentDir, { withFileTypes: true }).catch(() => [])
                for (const entry of entries) {
                  if (SKIP.has(entry.name)) continue
                  const relPath = relative ? `${relative}/${entry.name}` : entry.name
                  if (entry.isDirectory()) {
                    await walk(path.join(currentDir, entry.name), relPath)
                  } else if (rawPatterns.length === 0 || rawPatterns.some(p => entry.name.includes(p))) {
                    results.push(relPath)
                    if (results.length >= maxResults) return
                  }
                }
              } catch {}
            }

            await walk(dir, '')
            await client.sendQueryResponse(queryId, { files: results })
          } else if (ctrl.action === 'fs:get_tree') {
            const dir = ctrl.dir as string
            const maxDepth = typeof ctrl.maxDepth === 'number' ? ctrl.maxDepth : 3
            const maxTreeChars = typeof ctrl.maxTreeChars === 'number' ? ctrl.maxTreeChars : 32_000

            const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.cache', '__pycache__'])
            const lines: string[] = []

            const walk = async (currentDir: string, prefix: string, depth: number) => {
              if (depth > maxDepth || lines.length > 500) return
              try {
                const { readdir } = await import('node:fs/promises')
                const entries = await readdir(currentDir, { withFileTypes: true }).catch(() => [])
                entries.sort((a, b) => a.name.localeCompare(b.name))
                for (const entry of entries) {
                  if (SKIP.has(entry.name)) continue
                  const isDir = entry.isDirectory()
                  lines.push(`${prefix}${entry.name}${isDir ? '/' : ''}`)
                  if (isDir && depth < maxDepth) {
                    await walk(path.join(currentDir, entry.name), prefix + '  ', depth + 1)
                  }
                }
              } catch {}
            }

            await walk(dir, '', 0)
            if (lines.length === 0) {
              await client.sendQueryResponse(queryId, { tree: null })
            } else {
              let result = lines.join('\n')
              if (result.length > maxTreeChars) {
                result = result.slice(0, maxTreeChars) + '\n...[truncated]'
              }
              await client.sendQueryResponse(queryId, { tree: result })
            }
          } else {
            await client.sendQueryResponse(queryId, null, `Unknown fs action: ${ctrl.action}`)
          }
        } catch (err: any) {
          console.warn(`[worker] fs action "${ctrl.action}" failed:`, err?.message || String(err))
          await client.sendQueryResponse(queryId, null, err?.message || String(err)).catch(() => {})
        }
      })
      return
    }

    if (ctrl.action.startsWith('project:')) {
      const queryId = ctrl.queryId
      if (!queryId) return

      Promise.resolve().then(async () => {
        try {
          if (ctrl.action === 'project:inspect_codebase') {
            const result = await inspectCodebase({
              dir: ctrl.dir as string,
              maxBytes: ctrl.maxBytes,
              maxSnippets: ctrl.maxSnippets,
            })
            await client.sendQueryResponse(queryId, result)
          } else if (ctrl.action === 'project:run_verification') {
            const result = await runVerification({
              dir: ctrl.dir as string,
              command: ctrl.command as string | undefined,
              timeoutMs: ctrl.timeoutMs as number | undefined,
            })
            await client.sendQueryResponse(queryId, result)
          } else {
            await client.sendQueryResponse(queryId, null, `Unknown project action: ${ctrl.action}`)
          }
        } catch (err: any) {
          console.warn(`[worker] project action "${ctrl.action}" failed:`, err?.message || String(err))
          await client.sendQueryResponse(queryId, null, err?.message || String(err)).catch(() => {})
        }
      })
      return
    }

    if (ctrl.action === 'stop' || ctrl.action === 'cancel') {
      const targetTaskId = (ctrl.taskId || ctrl.task_id) as string | undefined
      const targetFeatureId = (ctrl.featureId || ctrl.feature_id) as string | undefined
      const targetFeature = (ctrl.feature || ctrl.featureName || targetFeatureId) as string | undefined
      console.log(
        `[worker] received control stop: taskId=${targetTaskId || '*'} featureId=${targetFeatureId || '*'} feature=${(ctrl.feature as string | undefined) || '*'}`
      )

      if (!targetTaskId && !targetFeatureId && !ctrl.feature && !ctrl.all) {
        console.warn(`[worker] stop command ignored: neither taskId nor feature/featureId specified`)
        return
      }

      let stoppedCount = 0

      for (const [id, payload] of taskPayloads.entries()) {
        const payloadTaskId = payload.task.task_id as string | undefined
        const payloadTaskDbId = payload.task.id as string | undefined
        const matchesTask = targetTaskId
          ? (id === targetTaskId || payloadTaskId === targetTaskId || payloadTaskDbId === targetTaskId)
          : true
        const featId = (payload.task.featureId || payload.task.feature) as string | undefined
        const featName = (payload.task.feature_name || payload.task.featureName || payload.task.feature) as string | undefined
        const matchesFeature = (targetFeatureId || targetFeature)
          ? (featId === targetFeatureId || featId === targetFeature || featName === targetFeature || featName === targetFeatureId)
          : true

        if (matchesTask && matchesFeature) {
          console.log(`[worker] cancelling pending task "${id}" before execution`)
          taskPayloads.delete(id)
          pending.delete(id)
          stoppedCount++
        }
      }

      for (const [id, taskInfo] of activeTasks.entries()) {
        const matchesTask = targetTaskId
          ? (id === targetTaskId || taskInfo.taskId === targetTaskId || taskInfo.taskSlug === targetTaskId)
          : true
        const matchesFeature = (targetFeatureId || targetFeature)
          ? (taskInfo.featureId === targetFeatureId ||
             taskInfo.featureId === targetFeature ||
             (taskInfo.featureName !== undefined && (taskInfo.featureName === targetFeature || taskInfo.featureName === targetFeatureId)))
          : true

        if (matchesTask && matchesFeature) {
          console.log(`[worker] aborting active task "${id}" (feature: "${taskInfo.featureId}")`)
          taskInfo.controller.abort()
          stoppedCount++
        }
      }

      if (activeChatTask) {
        const matchesTask = targetTaskId
          ? (activeChatTask.taskId === targetTaskId || activeChatTask.taskSlug === targetTaskId)
          : true
        const matchesFeature = (targetFeatureId || targetFeature)
          ? (activeChatTask.featureId === targetFeatureId ||
             activeChatTask.featureId === targetFeature ||
             (activeChatTask.featureName !== undefined && (activeChatTask.featureName === targetFeature || activeChatTask.featureName === targetFeatureId)))
          : true
        if (matchesTask && matchesFeature) {
          console.log(`[worker] aborting active chat task "${activeChatTask.taskId}"`)
          activeChatTask.controller.abort()
          stoppedCount++
        }
      }

      if (stoppedCount === 0) {
        console.log(`[worker] stop signal received but no active tasks matched`)
      }
    }
  }

  try {
    unsub = await subscribeToControl(client, handleControl)
    console.log(`[worker] SSE subscription established`)
  } catch (err: any) {
    console.warn(`[worker] SSE subscribe failed (${err?.message || String(err)})`)
  }

  let shutdownDone = false
  async function shutdown(signal: string): Promise<void> {
    if (shutdownDone) return
    shuttingDown = true
    console.log(`[worker] received ${signal}, shutting down gracefully...`)

    if (unsub !== null) {
      await unsub().catch(() => {})
      unsub = null
    }

    shutdownController.abort()

    const allActivePromises = Array.from(activeTasks.values()).map((t) => t.promise)
    if (activeChatTask) {
      allActivePromises.push(activeChatTask.promise)
    }
    if (allActivePromises.length > 0) {
      console.log(`[worker] waiting for ${allActivePromises.length} active task(s) to finalize...`)
      const cap = new Promise((resolve) => setTimeout(resolve, SHUTDOWN_FINALIZE_CAP_MS))
      await Promise.race([Promise.all(allActivePromises), cap]).catch(() => {})
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
