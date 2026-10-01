import { describe, it, expect } from 'bun:test'
import { parseEnv, resolveConfig, loadConfig } from '../config'
import path from 'node:path'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir, hostname } from 'node:os'

describe('parseEnv', () => {
  it('parses simple KEY=VALUE lines', () => {
    const result = parseEnv('FOO=bar\nBAZ=qux')
    expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' })
  })

  it('skips blank lines and # comments', () => {
    const result = parseEnv('\n# this is a comment\nFOO=bar\n\n')
    expect(result).toEqual({ FOO: 'bar' })
  })

  it('handles KEY= with an empty value', () => {
    const result = parseEnv('FOO=\nBAR=baz')
    expect(result).toEqual({ FOO: '', BAR: 'baz' })
  })

  it('strips surrounding double quotes', () => {
    const result = parseEnv('FOO="hello world"')
    expect(result).toEqual({ FOO: 'hello world' })
  })

  it('strips surrounding single quotes', () => {
    const result = parseEnv("FOO='hello world'")
    expect(result).toEqual({ FOO: 'hello world' })
  })

  it('tolerates a leading export keyword', () => {
    const result = parseEnv('export FOO=bar')
    expect(result).toEqual({ FOO: 'bar' })
  })

  it('splits at the first = only (value contains =)', () => {
    const result = parseEnv('FOO=bar=baz')
    expect(result).toEqual({ FOO: 'bar=baz' })
  })

  it('ignores lines without an = sign', () => {
    const result = parseEnv('FOO=bar\nno-equals-here\nBAZ=qux')
    expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' })
  })

  it('trims whitespace from keys and values', () => {
    const result = parseEnv('  FOO  =  bar  ')
    expect(result).toEqual({ FOO: 'bar' })
  })

  it('returns an empty object for empty input', () => {
    expect(parseEnv('')).toEqual({})
  })
})

describe('resolveConfig', () => {
  it('uses env value when env[K] is defined (non-empty)', () => {
    const result = resolveConfig(
      { SPECFLOW_URL: 'http://custom:3200' },
      { SPECFLOW_URL: 'http://file:3200' },
    )
    expect(result.specflowUrl).toBe('http://custom:3200')
  })

  it('uses env value even when it is an empty string', () => {
    const result = resolveConfig(
      { SPECFLOW_URL: '' },
      { SPECFLOW_URL: 'http://file:3200' },
    )
    expect(result.specflowUrl).toBe('')
  })

  it('falls through to file value when env[K] is undefined', () => {
    const result = resolveConfig(
      { SPECFLOW_URL: undefined },
      { SPECFLOW_URL: 'http://file:3200' },
    )
    expect(result.specflowUrl).toBe('http://file:3200')
  })

  it('defaults specflowUrl to http://127.0.0.1:3200', () => {
    const result = resolveConfig({}, {})
    expect(result.specflowUrl).toBe('http://127.0.0.1:3200')
  })

  it('defaults workerName to the hostname', () => {
    const result = resolveConfig({}, {})
    expect(result.workerName).toBe(hostname())
  })

  it('pathOverride comes from file.PATH only, never env.PATH', () => {
    const result = resolveConfig(
      { PATH: '/env/path' },
      { PATH: '/file/path' },
    )
    expect(result.pathOverride).toBe('/file/path')
  })

  it('does not set pathOverride when file has no PATH', () => {
    const result = resolveConfig(
      { PATH: '/env/path' },
      { FOO: 'bar' },
    )
    expect(result.pathOverride).toBeUndefined()
  })

  it('envValues contains all file pairs including PATH', () => {
    const result = resolveConfig(
      { SPECFLOW_URL: 'http://env:3200' },
      { SPECFLOW_URL: 'http://file:3200', PATH: '/custom/path' },
    )
    expect(result.envValues).toEqual({
      SPECFLOW_URL: 'http://file:3200',
      PATH: '/custom/path',
    })
  })
})

describe('loadConfig', () => {
  it('reads and parses a worker.env file', async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), 'specflow-worker-config-'))
    const envPath = path.join(tmpDir, 'worker.env')
    await Bun.write(envPath, 'SPECFLOW_URL=http://custom:3200\n')

    const config = await loadConfig({
      env: {},
      workerEnvPath: envPath,
    })
    expect(config.specflowUrl).toBe('http://custom:3200')
    expect(config.workerEnvPath).toBe(envPath)

    await rm(tmpDir, { recursive: true, force: true })
  })

  it('returns defaults when the worker.env file is missing', async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), 'specflow-worker-config-'))
    const envPath = path.join(tmpDir, 'worker.env')

    const config = await loadConfig({
      env: {},
      workerEnvPath: envPath,
    })
    expect(config.specflowUrl).toBe('http://127.0.0.1:3200')
    expect(config.workerName).toBe(hostname())

    await rm(tmpDir, { recursive: true, force: true })
  })

  it('uses SPECFLOW_DIR for the default worker.env path', async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), 'specflow-worker-config-'))
    const envPath = path.join(tmpDir, '.specflow', 'worker.env')
    await mkdir(path.dirname(envPath), { recursive: true })
    await Bun.write(envPath, 'WORKER_NAME=myworker\n')

    const config = await loadConfig({
      env: { SPECFLOW_DIR: tmpDir },
    })
    expect(config.workerName).toBe('myworker')

    await rm(tmpDir, { recursive: true, force: true })
  })

  it('never writes the worker.env file', async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), 'specflow-worker-config-'))
    const envPath = path.join(tmpDir, 'worker.env')

    await loadConfig({
      env: {},
      workerEnvPath: envPath,
    })

    const exists = await Bun.file(envPath).exists()
    expect(exists).toBe(false)

    await rm(tmpDir, { recursive: true, force: true })
  })
})
