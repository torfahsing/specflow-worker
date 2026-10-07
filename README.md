# @specflow/worker

A standalone Bun daemon that runs on the developer's local workstation, connecting outbound to Specflow via HTTP and SSE. 

The daemon executes autonomous agent CLI providers (e.g. `openrouter-agent`, `antigravity-agent`) locally where your repositories, compilers, and tools live, streaming events, tokens, and cost back to Specflow in real time.

The daemon opens **zero inbound ports** and requires **zero direct database access** — it authenticates purely via standard Bearer token (`SPECFLOW_TOKEN`) against Specflow's `/api/worker/*` endpoints.

## Install

```bash
bun install
```

## Run

```bash
# Development (TypeScript)
bun run src/cli.ts start

# Compiled standalone binary
bun run build
./bin/specflow-worker start
```

## Configuration

The daemon reads configuration from environment variables and an optional `~/.specflow/worker.env` file.

### Environment variables

| Variable | Source | Default | Purpose |
|---|---|---|---|
| `SPECFLOW_URL` | env / worker.env | `http://127.0.0.1:3200` | Specflow orchestrator base URL |
| `SPECFLOW_TOKEN` | env / worker.env | — | Worker authentication Bearer token |
| `WORKER_NAME` | env / worker.env | `os.hostname()` | Presence identity reported in heartbeat |

### `~/.specflow/worker.env`

A `KEY=VALUE` file (no `dotenv` dependency — Bun auto-loads cwd `.env`). The file is read at startup and used to fill gaps that process environment does not already define.

**Precedence:** process environment wins; `worker.env` fills gaps. `PATH` is taken **only** from `worker.env` (never from the process environment) and is used for `Bun.which(command, { PATH })` command resolution and injected into spawned provider processes.

### Example `~/.specflow/worker.env`

```env
SPECFLOW_URL=https://specflow.example.com
SPECFLOW_TOKEN=spw_auth_token_here
WORKER_NAME=my-laptop-worker
PATH=/usr/local/bin:/usr/bin
```

## Protocol & Capabilities

The daemon adheres strictly to the **SpecFlow Agent Protocol (v1)**:
- **Capability & Model Discovery**: Probes `command --capabilities`, `command --models`, and `command --quota` to discover installed tools, live models, and pricing, reporting them to Specflow in heartbeat.
- **Git Alignment & Bounded Diff**: Ensures working tree branch alignment and bounds git diffs to 100k characters to prevent review context ballooning.
- **Structured Output & 1-Turn Repair**: Stages bare JSON schemas for `--output-schema` and performs automatic 1-turn repair if structured responses contain invalid formatting.
- **Streaming NDJSON**: Relays real-time `text`, `reasoning`, `tool_call`, and `tool_result` events.
- **Cost & Token Accounting**: Extracts micro-dollar costs (`done.usage.cost`) and token counts with 6-decimal precision.
- **Codebase Inspection**: Services the `project:inspect_codebase` control query, returning a bounded briefing of curated root-level manifests, configs, and sample source snippets so the cloud orchestrator can understand a local repo without spawning an agent.

## Development

```bash
# Run tests
bun test

# Type-check
bun run typecheck

# Build the compiled binary
bun run build
```
