/**
 * Daemon entry point.
 *
 * T1 scaffold stub — only the `start` subcommand is accepted. The full
 * startup sequence (config, PocketBase auth/health, presence, queue
 * subscription, work loop, signal wiring) lands in a later phase.
 */
export async function main(argv: string[]): Promise<void> {
  if (argv.length !== 1 || argv[0] !== 'start') {
    console.error('usage: specflow-worker start');
    process.exit(1);
  }

  console.log('[worker] start: scaffold stub reached — daemon startup lands in a later phase');
}

// Self-invoke when run directly (bun run src/cli.ts start, compiled binary)
// so the module entry behaves identically to index.ts. When index.ts is the
// entry point, import.meta.main is false here and main runs exactly once.
if (import.meta.main) {
  await main(process.argv.slice(2));
}