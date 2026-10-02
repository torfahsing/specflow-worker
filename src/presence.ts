/**
 * Worker presence & heartbeat.
 *
 * Heartbeat via SpecflowClient.heartbeat (/api/worker/heartbeat).
 * Sends status, local capabilities, and discovered models to Specflow Cloud.
 *
 * The heartbeat timer is .unref()'d so it cannot keep the process
 * alive after shutdown.
 */

import type { SpecflowClient } from './client.js'

const DEFAULT_CAPABILITIES = ['git'] as const
const DEFAULT_INTERVAL_MS = 30_000

export class Presence {
  workerId: string | null = null
  private desiredStatus: 'online' | 'busy' | 'offline' = 'online'
  private intervalMs: number
  private timer: ReturnType<typeof setInterval> | null = null
  private stopped = false

  constructor(
    private client: SpecflowClient,
    private workerName: string,
    private capabilities: Record<string, any> | readonly string[] = DEFAULT_CAPABILITIES,
    intervalMs?: number,
  ) {
    this.intervalMs = intervalMs ?? DEFAULT_INTERVAL_MS
  }

  async ensure(): Promise<string> {
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

  private async writeStatus(status: 'online' | 'busy' | 'offline'): Promise<void> {
    try {
      const res = await this.client.heartbeat({
        worker_name: this.workerName,
        status,
        // capabilities omitted — sent once on initial registration via ensure()
      })
      if (res?.worker_id) {
        this.workerId = res.worker_id
      }
    } catch (err: any) {
      console.warn('[worker] presence notice:', err?.message || String(err))
    }
  }
}
