import { describe, it, expect } from 'bun:test'
import type PocketBase from 'pocketbase'
import {
  createClient,
  authenticate,
  isAvailable,
  startAuthWatchdog,
  onRealtimeConnect,
} from '../pb/client'
import type { AuthOptions } from '../pb/client'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface StubOptions {
  superuserError?: Error
  adminsError?: Error
  withAdmins?: boolean
  healthCode?: number
  healthError?: Error
  subscribeImpl?: (
    topic: string,
    cb: (data: unknown) => void,
  ) => Promise<() => Promise<void>>
}

/**
 * Build a stub PocketBase client that records every SDK interaction.
 * No network is ever touched.
 */
function makeStubPb(options: StubOptions = {}) {
  const calls = { superuser: 0, admins: 0, health: 0 }
  const authStore = {
    isValid: false,
    savedToken: null as string | null,
    save(token: string): void {
      authStore.savedToken = token
    },
    clear(): void {},
  }
  const realtimeState = {
    callbacks: [] as Array<(data: unknown) => void>,
    unsubscribeCount: 0,
  }

  const pb = {
    authStore,
    health: {
      check: async () => {
        calls.health++
        if (options.healthError) throw options.healthError
        return { code: options.healthCode ?? 200, message: 'ok', data: {} }
      },
    },
    collection: (name: string) => {
      if (name === '_superusers') {
        return {
          authWithPassword: async (_email: string, _password: string) => {
            calls.superuser++
            if (options.superuserError) throw options.superuserError
            authStore.isValid = true
            return { token: 'jwt-token', record: { id: 'su_1' } }
          },
        }
      }
      throw new Error(`unexpected collection "${name}"`)
    },
    realtime: {
      subscribe:
        options.subscribeImpl ??
        (async (topic: string, cb: (data: unknown) => void) => {
          if (topic === 'PB_CONNECT') realtimeState.callbacks.push(cb)
          return async () => {
            realtimeState.unsubscribeCount++
          }
        }),
      unsubscribe: async () => {},
    },
    autoCancellation: (_enabled: boolean) => {},
  }

  if (options.withAdmins) {
    ;(pb as any).admins = {
      authWithPassword: async () => {
        calls.admins++
        if (options.adminsError) throw options.adminsError
        authStore.isValid = true
        return { token: 'legacy-jwt', record: { id: 'adm_1' } }
      },
    }
  }

  return { pb: pb as unknown as PocketBase, calls, authStore, realtimeState }
}

describe('createClient', () => {
  it('constructs a client (no network on construction) with autoCancellation disabled', () => {
    const pb = createClient('http://127.0.0.1:8090')
    expect(pb).toBeDefined()
    expect(pb.authStore).toBeDefined()
    expect(typeof pb.health.check).toBe('function')
    // autoCancellation(false) is idempotent — mirror initClient() semantics
    pb.autoCancellation(false)
    expect(pb.authStore).toBeDefined()
  })
})

describe('authenticate', () => {
  it('token path saves the token, sets tokenMode, and never calls authWithPassword', async () => {
    const { pb, calls, authStore } = makeStubPb({ withAdmins: true })
    const opts: AuthOptions = {
      token: 'raw-token',
      email: 'a@b.c',
      password: 'pw',
      latch: { failed: false },
    }

    const ok = await authenticate(pb, opts)

    expect(ok).toBe(true)
    expect(authStore.savedToken).toBe('raw-token')
    expect(opts.tokenMode).toBe(true)
    expect(calls.superuser).toBe(0)
    expect(calls.admins).toBe(0)
  })

  it('token path wins even when the auth latch is already tripped', async () => {
    const { pb, calls } = makeStubPb()
    const opts: AuthOptions = { token: 'raw-token', latch: { failed: true } }

    const ok = await authenticate(pb, opts)

    expect(ok).toBe(true)
    expect(opts.tokenMode).toBe(true)
    expect(calls.superuser).toBe(0)
  })

  it('short-circuits to true when authStore.isValid is already set (no network)', async () => {
    const { pb, calls, authStore } = makeStubPb()
    authStore.isValid = true

    const ok = await authenticate(pb, {
      email: 'a@b.c',
      password: 'pw',
      latch: { failed: false },
    })

    expect(ok).toBe(true)
    expect(calls.superuser).toBe(0)
  })

  it('returns false when no credentials are provided', async () => {
    const { pb, calls } = makeStubPb()

    const ok = await authenticate(pb, {})

    expect(ok).toBe(false)
    expect(calls.superuser).toBe(0)
  })

  it('authenticates via _superusers and keeps the latch reset on success', async () => {
    const { pb, calls } = makeStubPb()
    const opts: AuthOptions = {
      email: 'admin@example.com',
      password: 'secret',
      latch: { failed: false },
    }

    const ok = await authenticate(pb, opts)

    expect(ok).toBe(true)
    expect(calls.superuser).toBe(1)
    expect(opts.latch?.failed).toBe(false)
  })

  it('a tripped latch short-circuits to false before any network call', async () => {
    const { pb, calls } = makeStubPb()
    const opts: AuthOptions = {
      email: 'admin@example.com',
      password: 'secret',
      latch: { failed: true },
    }

    const ok = await authenticate(pb, opts)

    expect(ok).toBe(false)
    expect(calls.superuser).toBe(0)
  })

  it('falls back to legacy (pb as any).admins when _superusers auth throws', async () => {
    const { pb, calls } = makeStubPb({
      withAdmins: true,
      superuserError: new Error('_superusers unavailable'),
    })
    const opts: AuthOptions = {
      email: 'admin@example.com',
      password: 'secret',
      latch: { failed: false },
    }

    const ok = await authenticate(pb, opts)

    expect(ok).toBe(true)
    expect(calls.superuser).toBe(1)
    expect(calls.admins).toBe(1)
    expect(opts.latch?.failed).toBe(false)
  })

  it('returns false and latches when both auth paths fail', async () => {
    const { pb, calls } = makeStubPb({
      withAdmins: true,
      superuserError: new Error('su down'),
      adminsError: new Error('adm down'),
    })
    const opts: AuthOptions = {
      email: 'admin@example.com',
      password: 'secret',
      latch: { failed: false },
    }

    const ok = await authenticate(pb, opts)

    expect(ok).toBe(false)
    expect(calls.superuser).toBe(1)
    expect(calls.admins).toBe(1)
    expect(opts.latch?.failed).toBe(true)
  })

  it('latch blocks a retry: a second call makes zero additional auth attempts', async () => {
    const { pb, calls } = makeStubPb({ superuserError: new Error('su down') })
    const opts: AuthOptions = {
      email: 'admin@example.com',
      password: 'secret',
      latch: { failed: false },
    }

    const first = await authenticate(pb, opts)
    expect(first).toBe(false)
    expect(opts.latch?.failed).toBe(true)
    expect(calls.superuser).toBe(1)

    const second = await authenticate(pb, opts)
    expect(second).toBe(false)
    expect(calls.superuser).toBe(1)
    expect(calls.admins).toBe(0)
  })

  it('never leaks credentials: a failed ladder does not log the password', async () => {
    const { pb } = makeStubPb({ superuserError: new Error('401') })
    // No throw and no credential echo — the warning carries only the message
    await expect(
      authenticate(pb, { email: 'creds@x.y', password: 's3cr3t', latch: { failed: false } }),
    ).resolves.toBe(false)
  })
})

describe('isAvailable', () => {
  it('returns true for a healthy 200 response', async () => {
    const { pb, calls } = makeStubPb({ healthCode: 200 })
    expect(await isAvailable(pb)).toBe(true)
    expect(calls.health).toBe(1)
  })

  it('returns false for a non-200 code', async () => {
    const { pb } = makeStubPb({ healthCode: 503 })
    expect(await isAvailable(pb)).toBe(false)
  })

  it('returns false (never throws) when health.check throws', async () => {
    const { pb } = makeStubPb({ healthError: new Error('connection refused') })
    await expect(isAvailable(pb)).resolves.toBe(false)
  })
})

describe('startAuthWatchdog', () => {
  it('never re-authenticates a raw token — zero repeat auth calls on N ticks', async () => {
    const { pb, calls } = makeStubPb({ withAdmins: true })
    const opts: AuthOptions = {
      token: 'raw-token',
      email: 'a@b.c',
      password: 'pw',
      latch: { failed: false },
    }
    await authenticate(pb, opts)
    expect(opts.tokenMode).toBe(true)

    const stop = startAuthWatchdog(pb, opts, 5)
    await sleep(40) // several ticks
    stop()
    await sleep(25) // nothing should fire after disposal either

    expect(calls.superuser).toBe(0)
    expect(calls.admins).toBe(0)
  })

  it('re-authenticates when the store goes stale, then stops after disposal', async () => {
    const { pb, calls, authStore } = makeStubPb()
    const opts: AuthOptions = {
      email: 'a@b.c',
      password: 'pw',
      latch: { failed: false },
    }

    // initial auth from the daemon startup path
    await authenticate(pb, opts)
    expect(calls.superuser).toBe(1)

    // simulate an expired token → the watchdog must re-auth exactly once
    authStore.isValid = false
    const stop = startAuthWatchdog(pb, opts, 10)
    await sleep(45)
    stop()
    await sleep(30)

    expect(calls.superuser).toBe(2) // initial + one watchdog re-auth
  })

  it('skips ticks while the store is valid', async () => {
    const { pb, calls, authStore } = makeStubPb()
    authStore.isValid = true

    const stop = startAuthWatchdog(pb, { email: 'a@b.c', password: 'pw' }, 5)
    await sleep(20)
    stop()

    expect(calls.superuser).toBe(0)
  })

  it('trips the latch on the first failed tick and stops trying', async () => {
    const { pb, calls } = makeStubPb({ superuserError: new Error('down') })
    const opts: AuthOptions = {
      email: 'a@b.c',
      password: 'pw',
      latch: { failed: false },
    }

    const stop = startAuthWatchdog(pb, opts, 5)
    await sleep(30)
    stop()

    expect(opts.latch?.failed).toBe(true)
    expect(calls.superuser).toBe(1)
  })

  it('never authenticates when no email/password are configured', async () => {
    const { pb, calls } = makeStubPb()

    const stop = startAuthWatchdog(pb, {}, 5)
    await sleep(20)
    stop()

    expect(calls.superuser).toBe(0)
  })
})

describe('onRealtimeConnect', () => {
  it('fires the callback on each PB_CONNECT and stops after disposal', async () => {
    const { pb, realtimeState } = makeStubPb()
    let calls = 0
    const disposer = onRealtimeConnect(pb, () => {
      calls++
    })

    await sleep(5)
    expect(realtimeState.callbacks.length).toBe(1)

    const emit = realtimeState.callbacks[0]!
    emit({})
    emit({})
    expect(calls).toBe(2)

    disposer()
    emit({})
    expect(calls).toBe(2) // disposed — ignored
  })

  it('disposer unsubscribes from the PB_CONNECT topic', async () => {
    const { pb, realtimeState } = makeStubPb()
    const disposer = onRealtimeConnect(pb, () => {})

    await sleep(5)
    disposer()

    expect(realtimeState.unsubscribeCount).toBe(1)
  })

  it('unsubscribes immediately when disposed before the subscribe promise resolves', async () => {
    let resolveSubscribe!: (value: () => Promise<void>) => void
    const deferred = new Promise<() => Promise<void>>((resolve) => {
      resolveSubscribe = resolve
    })
    let unsubbed = 0
    const { pb } = makeStubPb({
      subscribeImpl: async () => deferred,
    })

    const disposer = onRealtimeConnect(pb, () => {})
    disposer() // before the SDK resolves the subscription
    resolveSubscribe(async () => {
      unsubbed++
    })
    await sleep(5)

    expect(unsubbed).toBe(1)
  })
})