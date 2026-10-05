import { describe, it, expect } from 'bun:test'
import {
  probeCapabilities,
  probeModels,
  discoverLocalManifest,
} from '../discovery'

describe('probeCapabilities', () => {
  it('returns null when executable does not exist', async () => {
    const caps = await probeCapabilities('nonexistent-binary-xyz')
    expect(caps).toBeNull()
  })

  it('probes real openrouter-agent if present in PATH', async () => {
    const bin = Bun.which('openrouter-agent')
    if (!bin) return // skip if not installed locally

    const caps = await probeCapabilities(bin)
    expect(caps).not.toBeNull()
    expect(caps?.protocol).toBe('specflow-agent-v1')
    expect(Array.isArray(caps?.tools)).toBe(true)
  })
})

describe('probeModels', () => {
  it('returns empty array when executable does not exist', async () => {
    const models = await probeModels('nonexistent-binary-xyz')
    expect(models).toEqual([])
  })

  it('probes real openrouter-agent models if present in PATH', async () => {
    const bin = Bun.which('openrouter-agent')
    if (!bin) return

    const models = await probeModels(bin)
    expect(Array.isArray(models)).toBe(true)
  })
})

describe('discoverLocalManifest', () => {
  it('detects git availability', async () => {
    const manifest = await discoverLocalManifest()
    expect(typeof manifest.git).toBe('boolean')
    expect(manifest.git).toBe(true)
  })
})
