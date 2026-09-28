import { describe, it, expect } from 'bun:test'
import {
  buildProviderCmd,
  normalizeTimeout,
} from '../providers/cli'

describe('buildProviderCmd', () => {
  it('includes command, model, tools, -j, --no-session in exact order', () => {
    const cmd = buildProviderCmd({
      command: 'my-provider',
      model: 'gpt-4',
      allowedTools: ['file_read', 'file_write'],
    })
    expect(cmd).toEqual([
      'my-provider',
      '--model',
      'gpt-4',
      '--allowedTools',
      'file_read',
      'file_write',
      '-j',
      '--no-session',
    ])
  })

  it('omits --model when model is undefined', () => {
    const cmd = buildProviderCmd({
      command: 'my-provider',
      allowedTools: ['file_read'],
    })
    expect(cmd).toEqual([
      'my-provider',
      '--allowedTools',
      'file_read',
      '-j',
      '--no-session',
    ])
    expect(cmd).not.toContain('--model')
  })

  it('omits --model when model is empty string', () => {
    const cmd = buildProviderCmd({
      command: 'my-provider',
      model: '',
      allowedTools: ['file_read'],
    })
    expect(cmd).toEqual([
      'my-provider',
      '--allowedTools',
      'file_read',
      '-j',
      '--no-session',
    ])
    expect(cmd).not.toContain('--model')
  })

  it('uses --allowedTools none when allowedTools is empty', () => {
    const cmd = buildProviderCmd({
      command: 'my-provider',
      model: 'gpt-4',
      allowedTools: [],
    })
    expect(cmd).toEqual([
      'my-provider',
      '--model',
      'gpt-4',
      '--allowedTools',
      'none',
      '-j',
      '--no-session',
    ])
  })

  it('uses --allowedTools none when allowedTools is undefined', () => {
    const cmd = buildProviderCmd({
      command: 'my-provider',
    })
    expect(cmd).toEqual([
      'my-provider',
      '--allowedTools',
      'none',
      '-j',
      '--no-session',
    ])
  })

  it('command is always argv[0]', () => {
    const cmd = buildProviderCmd({ command: 'openrouter-agent' })
    expect(cmd[0]).toBe('openrouter-agent')
  })

  it('-j precedes --no-session in all cases', () => {
    const cmd = buildProviderCmd({ command: 'x' })
    const jIdx = cmd.indexOf('-j')
    const noSessionIdx = cmd.indexOf('--no-session')
    expect(jIdx).toBeLessThan(noSessionIdx)
  })

  it('never adds --prompt or -p flag', () => {
    const cmd = buildProviderCmd({
      command: 'x',
      model: 'm',
      allowedTools: ['t'],
    })
    expect(cmd).not.toContain('--prompt')
    expect(cmd).not.toContain('-p')
  })
})

describe('normalizeTimeout', () => {
  it('undefined → DEFAULT_TIMEOUT_MS', () => {
    expect(normalizeTimeout(undefined)).toBe(1_800_000)
  })

  it('null → DEFAULT_TIMEOUT_MS', () => {
    expect(normalizeTimeout(null)).toBe(1_800_000)
  })

  it('number < 10000 treated as seconds → ms', () => {
    expect(normalizeTimeout(60)).toBe(60_000)
  })

  it('number >= 10000 used as-is (already ms)', () => {
    expect(normalizeTimeout(60_000)).toBe(60_000)
  })

  it('numeric string coerced', () => {
    expect(normalizeTimeout('90')).toBe(90_000)
  })

  it('empty string → DEFAULT_TIMEOUT_MS', () => {
    expect(normalizeTimeout('')).toBe(1_800_000)
  })
})
