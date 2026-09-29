# @specflow/worker

A standalone Bun daemon that connects outbound to PocketBase, claims queued tasks, and executes them via a configured CLI provider. The daemon opens **zero inbound ports** — it connects to PocketBase strictly over HTTP(S) and uses SSE for realtime subscriptions.

## Install

```bash
bun install
```

## Run

```bash
# Development (TypeScript)
bun run src/cli.ts start

# Compiled binary (ROADMAP Phase 0)
bun run build
./bin/specflow-worker start
```

## Configuration

The daemon reads configuration from environment variables and an optional `~/.specflow/worker.env` file.

### Environment variables

| Variable | Source | Default | Purpose |
|---|---|---|---|
| `POCKETBASE_URL` | env / worker.env | `http://127.0.0.1:8090` | PocketBase base URL |
| `POCKETBASE_TOKEN` | env / worker.env | — | Auth token (feature contract) |
| `POCKETBASE_ADMIN_EMAIL` | env / worker.env | — | Superuser fallback auth |
| `POCKETBASE_ADMIN_PASSWORD` | env / worker.env | — | Superuser fallback auth |
| `WORKER_NAME` | env / worker.env | `os.hostname()` | Presence identity in `local_workers` |

### `~/.specflow/worker.env`

A `KEY=VALUE` file (no `dotenv` dependency — Bun auto-loads cwd `.env`). The file is read at startup and used to fill gaps that process environment does not already define.

**Precedence:** process environment wins; `worker.env` fills gaps. `PATH` is taken **only** from `worker.env` (never from the process environment) and is used for `Bun.which(command, { PATH })` command resolution and injected into spawned provider processes. This matters when running the compiled binary from a GUI, `launchd`, or a context where the shell `PATH` is not available.

### Example `~/.specflow/worker.env`

```
POCKETBASE_URL=http://127.0.0.1:8090
POCKETBASE_TOKEN=pb_auth_token_here
WORKER_NAME=my-worker
PATH=/usr/local/bin:/usr/bin
```

## Task payload contract

The upstream orchestrator must populate these fields on a `tasks` record before it is queued (prompt assembly, context retrieval, structured-output parsing, retries, verification gates, and phase commits are **out of scope** and happen upstream):

| Field | Type | Required | Purpose |
|---|---|---|---|
| `prompt` | text | yes | Assembled prompt text piped to the provider via stdin |
| `provider_command` | text | yes | CLI executable name or path (resolved via `Bun.which`) |
| `model` | text | no | Model identifier passed as `--model` |
| `allowed_tools` | json (array) | no | Tool names passed as `--allowedTools`; empty/missing defaults to `["none"]` |
| `timeout` | number | no | Timeout in seconds (<10000) or milliseconds (≥10000); default 1800000 (30 min) |

`project_dir` and `branch` are resolved from the expanded `feature` relation (`features.project_dir`, `features.git_branch`). The daemon reads them natively via `task.expand.feature`.

> **Note (Assumption §6.1):** No upstream producer currently writes `prompt` / `provider_command` / `model` / `allowed_tools` / `timeout` to `tasks` records yet. These fields are provisioned by migration `1800000003_task_execution_fields.js`. End-to-end execution requires the orchestrator to populate them before queueing.

## Event mapping (NDJSON → `run_events`)

The provider's stdout is expected to be newline-delimited JSON (NDJSON). Each line is parsed and mapped to a `run_events` record with a monotonic `sequence` number starting at 1.

| Provider stdout event | `run_events.type` | `payload` |
|---|---|---|
| `{ type: 'text', delta }` | `text` | `{ content: delta }` |
| `{ type: 'reasoning', delta }` | `reasoning` | `{ content: deltaDeduped }` |
| `{ type: 'tool_call', name, callId, args }` | `tool_call` | `{ name, call_id: callId, args }` |
| `{ type: 'tool_result', name, callId, output }` | `tool_result` | `{ name, call_id: callId, output }` |
| `{ type: 'error', message }` | `error` | `{ message }` (terminal error events also carry `exit_code` / `signal`) |
| `{ type: 'done', usage }` | — | Persisted on the `runs` record (`input_tokens`, `output_tokens`, `cost_usd`), not as a `run_events` row |
| `{ type: 'agent_end' }` | — | Usage-neutral terminal marker; no `run_events` row |

`done` events accumulate `cost_usd` across multiple occurrences while `input_tokens` / `output_tokens` take the last `done` event's values. Both `camelCase` and `snake_case` usage keys are read.

## Finalization matrix

| Outcome | `runs.status` | `tasks.status` | `tasks.error` |
|---|---|---|---|
| Exit 0, no result error | `completed` (+tokens/cost) | `done` | — |
| NDJSON `error` / `Error:` result text / non-zero exit / timeout | `failed` (+error text) | `failed` | error text |
| Executable missing (pre-spawn) | `failed` (+message) | `failed` | `Provider executable "<command>" not found in PATH.` |
| Daemon shutdown abort (SIGINT/SIGTERM) | `cancelled` | `queued` (`assigned_worker` cleared) | — |

## Migrations

The daemon requires three PocketBase collections: `local_workers`, `runs`, `run_events`, and additional fields on `tasks`. These are provisioned by the migrations in `pb_migrations/`:

- `1800000001_local_workers.js` — creates the `local_workers` collection
- `1800000002_runs_run_events.js` — creates `runs` and `run_events` collections
- `1800000003_task_execution_fields.js` — adds `assigned_worker`, `prompt`, `provider_command`, `model`, `allowed_tools`, `timeout` to `tasks` (idempotent)

### Scratch-dir verification recipe

```bash
# 1. Create a scratch directory
mkdir -p /tmp/specflow-worker-pbcheck/pb_migrations

# 2. Copy the reference repo's migrations (so tasks/features exist first)
cp /home/tor/source/specflow/pb_migrations/*.js /tmp/specflow-worker-pbcheck/pb_migrations/

# 3. Copy the worker migrations into the same directory
cp pb_migrations/*.js /tmp/specflow-worker-pbcheck/pb_migrations/

# 4. Run migrations against the scratch PocketBase data directory
/home/tor/source/specflow/bin/pocketbase --dir=/tmp/specflow-worker-pbcheck/pb_data migrate up

# 5. Verify reversibility
/home/tor/source/specflow/bin/pocketbase --dir=/tmp/specflow-worker-pbcheck/pb_data migrate down 3
/home/tor/source/specflow/bin/pocketbase --dir=/tmp/specflow-worker-pbcheck/pb_data migrate up 3
```

> The migrations are applied by the shared PocketBase instance that serves the `pb_data` directory used by the orchestrator and web packages. The scratch-dir recipe above is for verification only — do not point `--dir` at the live `pb_data`.

## Development

```bash
# Run tests (no live PocketBase required)
bun test

# Type-check
bun run typecheck

# Build the compiled binary
bun run build
```

## Agent protocol

The task payload contract and NDJSON event vocabulary are defined in `docs/SPECFLOW_AGENT_PROTOCOL.md` (§2–§4). The worker daemon consumes only the subset of the protocol defined in §4 (the standard openrouter-agent NDJSON vocabulary). Provider-specific format branches (Claude, agy) are deliberately absent — no provider name is hardcoded anywhere in the daemon.

## No provider binary required

The daemon does not assume or require any specific provider binary. The `provider_command` field on the queued task record is the sole source of the executable name, resolved at runtime via `Bun.which`. No provider name, model name, or machine path is hardcoded.
