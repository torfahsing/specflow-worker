/**
 * Specflow HTTP & SSE Client for the Worker Daemon.
 *
 * Uses native fetch and Web standard streams — zero external database SDKs,
 * zero migrations, zero raw database access.
 */

export interface SpecflowClientOptions {
  baseUrl: string;
  token: string;
}

export interface WorkerHeartbeatPayload {
  worker_name: string;
  status?: 'online' | 'busy' | 'offline';
  capabilities?: Record<string, any> | readonly string[];
}

export interface WorkerClaimedTask {
  id: string;
  title: string;
  feature: string;
  git_branch?: string;
  prompt?: string;
  provider_command?: string;
  model?: string;
  allowed_tools?: string[];
  timeout?: number;
  output_schema?: Record<string, any>;
  acceptance_criteria?: string[];
}

export interface WorkerClaimResult {
  task: WorkerClaimedTask;
  run_id: string;
}

export interface WorkerEventItem {
  sequence: number;
  type: string;
  payload: any;
}

export interface WorkerFinishPayload {
  run_id: string;
  status: 'completed' | 'failed';
  output?: any;
  error?: string;
  input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;
}

export class SpecflowClient {
  private baseUrl: string;
  private token: string;

  constructor(options: SpecflowClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token.trim();
  }

  private get authHeaders(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };
  }

  async heartbeat(payload: WorkerHeartbeatPayload): Promise<{ status: string; worker_id: string }> {
    const res = await fetch(`${this.baseUrl}/api/worker/heartbeat`, {
      method: 'POST',
      headers: this.authHeaders,
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Heartbeat failed (${res.status}): ${text || res.statusText}`);
    }

    return (await res.json()) as { status: string; worker_id: string };
  }

  async getPendingTasks(): Promise<WorkerClaimedTask[]> {
    const res = await fetch(`${this.baseUrl}/api/worker/tasks/pending`, {
      method: 'GET',
      headers: this.authHeaders,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Failed to fetch pending tasks (${res.status}): ${text || res.statusText}`);
    }

    const data = (await res.json()) as { tasks: WorkerClaimedTask[] };
    return data.tasks || [];
  }

  async claimTask(taskId: string, workerId: string): Promise<WorkerClaimResult> {
    const res = await fetch(`${this.baseUrl}/api/worker/tasks/${encodeURIComponent(taskId)}/claim`, {
      method: 'POST',
      headers: this.authHeaders,
      body: JSON.stringify({ worker_id: workerId }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Failed to claim task "${taskId}" (${res.status}): ${text || res.statusText}`);
    }

    return (await res.json()) as WorkerClaimResult;
  }

  async sendEvents(taskId: string, runId: string, events: WorkerEventItem[]): Promise<number> {
    const res = await fetch(`${this.baseUrl}/api/worker/tasks/${encodeURIComponent(taskId)}/events`, {
      method: 'POST',
      headers: this.authHeaders,
      body: JSON.stringify({ run_id: runId, events }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Failed to send events for task "${taskId}" (${res.status}): ${text || res.statusText}`);
    }

    const data = (await res.json()) as { status: string; count: number };
    return data.count;
  }

  async finishTask(taskId: string, payload: WorkerFinishPayload): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/worker/tasks/${encodeURIComponent(taskId)}/finish`, {
      method: 'POST',
      headers: this.authHeaders,
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Failed to finish task "${taskId}" (${res.status}): ${text || res.statusText}`);
    }
  }

  /**
   * Connect to the SSE task stream.
   * Auto-reconnects with exponential backoff on disconnect.
   * Returns a cleanup disposer function.
   */
  connectStream(
    onTaskAvailable: (data: { task_id: string; feature: string }) => void,
    onError?: (err: Error) => void,
  ): () => void {
    let closed = false;
    let currentController: AbortController | null = null;
    let reconnectDelay = 1000;

    const connect = async () => {
      if (closed) return;
      currentController = new AbortController();

      try {
        const streamUrl = `${this.baseUrl}/api/worker/stream`;
        const res = await fetch(streamUrl, {
          headers: {
            'Authorization': `Bearer ${this.token}`,
            'Accept': 'text/event-stream',
          },
          signal: currentController.signal,
        });

        if (!res.ok) {
          throw new Error(`SSE stream failed with status ${res.status}`);
        }

        reconnectDelay = 1000; // Reset backoff on successful connection
        const reader = res.body?.getReader();
        if (!reader) {
          throw new Error('Response body has no readable stream reader');
        }

        const decoder = new TextDecoder();
        let buffer = '';

        while (!closed) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const messages = buffer.split('\n\n');
          buffer = messages.pop() ?? '';

          for (const msg of messages) {
            const lines = msg.split('\n');
            let eventType = 'message';
            let dataStr = '';

            for (const line of lines) {
              if (line.startsWith('event: ')) {
                eventType = line.slice(7).trim();
              } else if (line.startsWith('data: ')) {
                dataStr = line.slice(6).trim();
              }
            }

            if (eventType === 'task_available' && dataStr) {
              try {
                const parsed = JSON.parse(dataStr);
                onTaskAvailable(parsed);
              } catch (e: any) {
                console.warn('[worker-sse] Failed to parse task_available payload:', e?.message);
              }
            }
          }
        }
      } catch (err: any) {
        if (!closed) {
          onError?.(err);
        }
      } finally {
        if (!closed) {
          setTimeout(connect, reconnectDelay);
          reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
        }
      }
    };

    connect().catch(() => {});

    return () => {
      closed = true;
      if (currentController) {
        currentController.abort();
        currentController = null;
      }
    };
  }
}
