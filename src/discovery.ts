/**
 * Local Capability & Model Discovery for Specflow Worker Daemon.
 *
 * Implements the Specflow Agent Protocol (v1) discovery contract (§3):
 * - Probes `--capabilities` for tools, categories, and supported features.
 * - Probes `--models` for real-time model catalog, context windows, and pricing.
 * - Probes `--quota` for subscription usage fractions and reset timers.
 */

export interface DiscoveredTool {
  id: string
  name: string
  category: string
  readOnly: boolean
  description: string
}

export interface DiscoveredModel {
  id: string
  model_id?: string
  name: string
  context_length?: number
  prompt_cost_per_1m?: number
  completion_cost_per_1m?: number
  is_free?: boolean
  description?: string
  category?: string
}

export interface DiscoveredCapabilities {
  name: string
  version?: string
  protocol: string
  description?: string
  tools: DiscoveredTool[]
  categories: Array<{ id: string; name: string; default?: boolean }>
  supportedModels: string[]
  features: {
    models?: boolean
    sessions?: boolean
    structuredOutput?: boolean
  }
}

export interface LocalWorkerManifest {
  git: boolean
  capabilities: DiscoveredCapabilities | null
  models: DiscoveredModel[]
}

/**
 * Probe a CLI provider for its self-describing capabilities manifest (--capabilities).
 */
export async function probeCapabilities(
  command: string,
  timeoutMs = 5000,
): Promise<DiscoveredCapabilities | null> {
  try {
    const proc = Bun.spawn([command, '--capabilities'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs))
    const readOutput = async (): Promise<DiscoveredCapabilities | null> => {
      const exitCode = await proc.exited
      if (exitCode !== 0) return null
      const text = await new Response(proc.stdout).text()
      const parsed = JSON.parse(text)
      if (parsed && Array.isArray(parsed.tools)) {
        return parsed as DiscoveredCapabilities
      }
      return null
    }

    return await Promise.race([readOutput(), timeout])
  } catch {
    return null
  }
}

/**
 * Probe a CLI provider for its real-time model catalog and pricing (--models).
 */
export async function probeModels(
  command: string,
  timeoutMs = 8000,
): Promise<DiscoveredModel[]> {
  try {
    const proc = Bun.spawn([command, '--models'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const timeout = new Promise<DiscoveredModel[]>((resolve) => setTimeout(() => resolve([]), timeoutMs))
    const readOutput = async (): Promise<DiscoveredModel[]> => {
      const exitCode = await proc.exited
      if (exitCode !== 0) return []
      const text = await new Response(proc.stdout).text()
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed)) {
        return parsed as DiscoveredModel[]
      }
      return []
    }

    return await Promise.race([readOutput(), timeout])
  } catch {
    return []
  }
}

/**
 * Collect the full local worker manifest (git support, capabilities, live models).
 */
export async function discoverLocalManifest(
  defaultProviderCommand?: string,
): Promise<LocalWorkerManifest> {
  let gitAvailable = false
  try {
    const gitCheck = Bun.spawn(['git', '--version'], { stdout: 'ignore', stderr: 'ignore' })
    gitAvailable = (await gitCheck.exited) === 0
  } catch {
    gitAvailable = false
  }

  const command = defaultProviderCommand || 'openrouter-agent'
  const resolved = Bun.which(command)

  if (!resolved) {
    return {
      git: gitAvailable,
      capabilities: null,
      models: [],
    }
  }

  const [capabilities, models] = await Promise.all([
    probeCapabilities(resolved),
    probeModels(resolved),
  ])

  return {
    git: gitAvailable,
    capabilities,
    models,
  }
}
