/**
 * Worker presence & heartbeat.
 *
 * Primary mode: HTTP heartbeat via SpecflowClient.heartbeat (/api/worker/heartbeat).
 * Backwards compatibility: supports legacy test mock interfaces.
 *
 * The heartbeat timer is .unref()'d so it cannot keep the process
 * alive after shutdown (spec §2.3, T9 AC).
 */

import type { SpecflowClient } from './client';

const DEFAULT_CAPABILITIES = ['git'] as const
const DEFAULT_INTERVAL_MS = 30_000

export class Presence {
  workerId: string | null = null
  private desiredStatus: 'online' | 'busy' = 'online'
  private intervalMs: number
  private timer: ReturnType<typeof setInterval> | null = null
  private stopped = false

  constructor(
    private client: SpecflowClient | any,
    private workerName: string,
    private capabilities: readonly string[] = DEFAULT_CAPABILITIES,
    intervalMs?: number,
  ) {
    this.intervalMs = intervalMs ?? DEFAULT_INTERVAL_MS
  }

  private static escapeFilter(value: string): string {
    return value.replace(/["\\]/g, '\\$&')
  }

  async ensure(): Promise<string> {
    // SpecflowClient HTTP path
    if (typeof this.client?.heartbeat === 'function') {
      try {
        const res = await this.client.heartbeat({
          worker_name: this.workerName,
          status: this.desiredStatus,
          capabilities: this.capabilities,
        })
        this.workerId = res.worker_id
        return res.worker_id
      } catch (err: any) {
        console.warn('[worker] presence notice:', err?.message || String(err))
        return ''
      }
    }

    // Legacy mock PB path (for existing unit tests)
    const escaped = Presence.escapeFilter(this.workerName)
    const data = {
      worker_name: this.workerName,
      status: this.desiredStatus,
      capabilities: this.capabilities,
      last_heartbeat: new Date().toISOString(),
    }

    try {
      const existing = await this.client
        ?.collection?.('local_workers')
        ?.getFirstListItem?.(`worker_name = "${escaped}"`)

      if (existing) {
        try {
          const updated = await this.client
            .collection('local_workers')
            .update(existing.id, data)
          this.workerId = updated.id
          return updated.id
        } catch (err: any) {
          if (err?.status === 404) {
            console.warn('[pb] presence notice: record vanished, re-creating')
            return this.ensure()
          }
          console.warn('[pb] presence notice:', err?.message ?? String(err))
        }
      }
    } catch (err: any) {
      console.warn('[pb] presence notice:', err?.message ?? String(err))
    }

    try {
      const created = await this.client?.collection?.('local_workers')?.create?.(data)
      if (created?.id) {
        this.workerId = created.id
        return created.id
      }
    } catch (err: any) {
      console.warn('[pb] presence notice:', err?.message ?? String(err))
    }

    return ''
  }

  setBusy(busy: boolean): void {
    this.desiredStatus = busy ? 'busy' : 'online'
    this.writeStatus(this.desiredStatus).catch(() => {})
  }

  start(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => {
      this.tick().catch(() => {})
    }, this.intervalMs)
    this.timer.unref()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    await this.writeStatus('offline').catch(() => {})
  }

  async tick(): Promise<void> {
    if (this.stopped) return
    await this.writeStatus(this.desiredStatus)
  }

  private async writeStatus(status: string): Promise<void> {
    // SpecflowClient HTTP path
    if (typeof this.client?.heartbeat === 'function') {
      try {
        const res = await this.client.heartbeat({
          worker_name: this.workerName,
          status,
          capabilities: this.capabilities,
        })
        if (res?.worker_id) {
          this.workerId = res.worker_id
        }
        return
      } catch (err: any) {
        console.warn('[worker] presence notice:', err?.message || String(err))
        return
      }
    }

    // Legacy mock PB path
    if (!this.workerId) return
    try {
      await this.client?.collection?.('local_workers')?.update?.(this.workerId, {
        status,
        last_heartbeat: new Date().toISOString(),
      })
    } catch (err: any) {
      if (err?.status === 404) {
        console.warn('[pb] presence notice: record vanished on heartbeat, re-ensuring')
        await this.ensure()
      } else {
        console.warn('[pb] presence notice:', err?.message ?? String(err))
      }
    }
  }
}
