/**
 * Worker presence & heartbeat for the local_workers collection.
 *
 * Mirrors the find-then-create/update upsert pattern of
 * PocketBaseService.syncTask / saveSetting (service.ts:511-536,
 * :618-640) and the [pb] / [worker] log-prefix conventions.
 *
 * The heartbeat timer is .unref()'d so it cannot keep the process
 * alive after shutdown (spec §2.3, T9 AC).
 */

import type PocketBase from 'pocketbase'

const DEFAULT_CAPABILITIES = ['git'] as const
const DEFAULT_INTERVAL_MS = 30_000

export class Presence {
  workerId: string | null = null
  private desiredStatus: 'online' | 'busy' = 'online'
  private intervalMs: number
  private timer: ReturnType<typeof setInterval> | null = null
  private stopped = false

  constructor(
    private pb: PocketBase,
    private workerName: string,
    private capabilities: readonly string[] = DEFAULT_CAPABILITIES,
    intervalMs?: number,
  ) {
    this.intervalMs = intervalMs ?? DEFAULT_INTERVAL_MS
  }

  /**
   * Escape double-quotes and backslashes for use inside a
   * PocketBase filter string — mirrors service.ts:435.
   */
  private static escapeFilter(value: string): string {
    return value.replace(/["\\]/g, '\\$&')
  }

  /**
   * Upsert the local_workers record by worker_name.
   *
   * Find-then-create/update clone of PocketBaseService.syncTask
   * (service.ts:511-536). Returns the record id (the worker_id
   * used for assigned_worker). Every write is try/caught with
   * a [pb] prefix; a 404 on update triggers exactly one re-ensure.
   */
  async ensure(): Promise<string> {
    const escaped = Presence.escapeFilter(this.workerName)
    const data = {
      worker_name: this.workerName,
      status: this.desiredStatus,
      capabilities: this.capabilities,
      last_heartbeat: new Date().toISOString(),
    }

    try {
      const existing = await this.pb
        .collection('local_workers')
        .getFirstListItem(`worker_name = "${escaped}"`)

      if (existing) {
        try {
          const updated = await this.pb
            .collection('local_workers')
            .update(existing.id, data)
          this.workerId = updated.id
          return updated.id
        } catch (err) {
          const errObj = err as { status?: number; message?: string }
          if (errObj.status === 404) {
            // Record deleted out from under us — re-create once.
            console.warn('[pb] presence notice: record vanished, re-creating')
            return this.ensure()
          }
          console.warn('[pb] presence notice:', errObj.message ?? String(err))
        }
      }
    } catch (err) {
      const errObj = err as { message?: string }
      // getFirstListItem threw (e.g. no matching record) → create
      console.warn('[pb] presence notice:', errObj.message ?? String(err))
    }

    // Create path (either no existing record or 404 on update)
    try {
      const created = await this.pb.collection('local_workers').create(data)
      this.workerId = created.id
      return created.id
    } catch (err) {
      const errObj = err as { message?: string }
      console.warn('[pb] presence notice:', errObj.message ?? String(err))
      return ''
    }
  }

  /**
   * Flip the desired status and write it immediately.
   * Called by the runner when a task starts/finishes.
   */
  setBusy(busy: boolean): void {
    this.desiredStatus = busy ? 'busy' : 'online'
    // Write immediately so the heartbeat doesn't overwrite
    // the desired state until the next tick.
    this.writeStatus(this.desiredStatus).catch(() => {})
  }

  /**
   * Start the heartbeat interval. The timer is .unref()'d so
   * a heartbeat alone cannot keep the process alive after
   * shutdown.
   */
  start(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => {
      this.tick().catch(() => {})
    }, this.intervalMs)
    this.timer.unref()
  }

  /**
   * Stop the heartbeat and set status to offline (best-effort).
   */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    await this.writeStatus('offline').catch(() => {})
  }

  /**
   * Extract the tick logic for testability (the spec requires
   * the tick logic is testable directly).
   */
  async tick(): Promise<void> {
    if (this.stopped) return
    await this.writeStatus(this.desiredStatus)
  }

  private async writeStatus(status: string): Promise<void> {
    if (!this.workerId) return
    try {
      await this.pb.collection('local_workers').update(this.workerId, {
        status,
        last_heartbeat: new Date().toISOString(),
      })
    } catch (err) {
      const errObj = err as { status?: number; message?: string }
      if (errObj.status === 404) {
        // Record gone — try to re-ensure once.
        console.warn('[pb] presence notice: record vanished on heartbeat, re-ensuring')
        await this.ensure()
      } else {
        console.warn('[pb] presence notice:', errObj.message ?? String(err))
      }
    }
  }
}
