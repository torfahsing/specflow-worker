/**
 * Fake provider fixture for runner tests.
 *
 * Reads the whole stdin prompt and emits NDJSON events
 * driven by environment variables:
 *
 *   FAKE_OUT=<path|ndjson text>  — file path or literal NDJSON text to emit
 *   FAKE_EXIT=<n>                — exit code (default 0)
 *   FAKE_ERR=<text>              — stderr text to write
 *   FAKE_SLEEP_MS=<n>            — milliseconds to sleep before exiting
 *
 * Tolerates the --model/--allowedTools/-j/--no-session flags
 * the worker passes (they are consumed and ignored).
 *
 * Spawned as: [process.execPath, '<abs fixture path>', ...providerArgs]
 * Contains no real provider name.
 */

// Read the entire stdin prompt (the worker pipes the prompt and then closes stdin)
let stdinData = ''
process.stdin.setEncoding('utf-8')
for await (const chunk of process.stdin) {
  stdinData += chunk
}

const outPath = process.env.FAKE_OUT ?? ''
const exitCode = parseInt(process.env.FAKE_EXIT ?? '0', 10)
const stderrText = process.env.FAKE_ERR ?? ''
const sleepMs = parseInt(process.env.FAKE_SLEEP_MS ?? '0', 10)

// Sleep if requested (simulates a slow provider)
if (sleepMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, sleepMs))
}

// Write stderr if requested
if (stderrText) {
  process.stderr.write(stderrText)
}

// Emit NDJSON events
if (outPath) {
  let content: string
  try {
    // Try reading as a file path first
    const f = Bun.file(outPath)
    content = await f.text()
  } catch {
    // Treat as literal NDJSON text
    content = outPath
  }

  // Split across lines and emit each as a separate NDJSON event.
  // This exercises the runner's line-buffering logic including
  // remainder handling when a chunk boundary splits a line.
  const lines = content.split('\n').filter((l) => l.trim() !== '')
  for (const line of lines) {
    process.stdout.write(line + '\n')
  }
}

// Exit with the configured code
process.exit(exitCode)
