import { describe, it, expect } from 'bun:test'
import {
  subscribeToControl,
  type ClaimedTask,
} from '../queue'
import type { SpecflowClient } from '../client'

function makeStubClient() {
  const calls = {
    connectStream: 0,
  }

  const client = {
    connectStream(onControl: (d: any) => void, onError: (e: any) => void) {
      calls.connectStream++
      return () => {}
    },
  } as unknown as SpecflowClient

  return {
    client,
    calls,
  }
}

describe('subscribeToControl', () => {
  it('connects to SSE stream via client.connectStream', async () => {
    const s = makeStubClient()
    const unsub = await subscribeToControl(s.client, () => {})

    expect(s.calls.connectStream).toBe(1)
    expect(typeof unsub).toBe('function')
    await unsub()
  })
})
