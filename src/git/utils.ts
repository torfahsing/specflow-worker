/**
 * Git alignment helpers for the worker daemon.
 *
 * Uses Bun.$ (shell interpolation) exclusively — no node:child_process,
 * no execa. All values go through Bun's safe template interpolation.
 *
 * Only the four functions ported from specflow/packages/orchestrator/src/git/utils.ts
 * that are needed for branch alignment (spec §2.3). Out-of-scope helpers
 * (worktree, push, PR, rebase, commit, diff, discard, isGitRepo, etc.)
 * are deliberately absent.
 */

export async function getCurrentBranch(dir: string): Promise<string> {
  try {
    return (await Bun.$`git -C ${dir} rev-parse --abbrev-ref HEAD`.text()).trim()
  } catch (err) {
    throw new Error(`Failed to get current branch: ${(err as Error).message}`)
  }
}

export async function branchExists(dir: string, branch: string): Promise<boolean> {
  try {
    await Bun.$`git -C ${dir} show-ref --verify --quiet refs/heads/${branch}`.text()
    return true
  } catch {
    return false
  }
}

export async function createBranch(dir: string, branch: string): Promise<void> {
  try {
    await Bun.$`git -C ${dir} branch ${branch}`.text()
  } catch (err) {
    throw new Error(`Failed to create branch '${branch}': ${(err as Error).message}`)
  }
}

export async function checkoutBranch(dir: string, branch: string): Promise<void> {
  try {
    await Bun.$`git -C ${dir} checkout ${branch}`.text()
  } catch (err) {
    throw new Error(`Failed to checkout branch '${branch}': ${(err as Error).message}`)
  }
}

/**
 * Assemble a bounded git diff representation capped at maxDiffChars (default 100,000).
 * Prevents context ballooning by appending a manifest and file pointers when truncated.
 */
export async function getBoundedDiff(
  dir: string,
  branch: string | null,
  maxDiffChars = 100_000,
): Promise<string | null> {
  const candidates = branch ? [`main...${branch}`, 'HEAD'] : ['HEAD'];
  let range = '';
  let statOut = '';
  let fullDiff = '';

  for (const candidate of candidates) {
    try {
      const stat = (await Bun.$`git -C ${dir} diff --stat ${candidate}`.text()).trim();
      const diff = await Bun.$`git -C ${dir} diff ${candidate}`.text();
      if (!diff.trim()) return null;
      range = candidate;
      statOut = stat;
      fullDiff = diff;
      break;
    } catch {
      // try next candidate
    }
  }

  if (!range) return null;

  const chunks: string[] = [];
  let current: string[] = [];
  for (const line of fullDiff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (current.length > 0) chunks.push(current.join('\n'));
      current = [line];
    } else if (current.length > 0) {
      current.push(line);
    }
  }
  if (current.length > 0) chunks.push(current.join('\n'));

  const parseHeaderPath = (header: string): string => {
    const rest = header.slice('diff --git '.length);
    const quoted = /^"a\/((?:[^"\\]|\\.)*)" "b\/((?:[^"\\]|\\.)*)"$/u.exec(rest);
    if (quoted && quoted[2]) return quoted[2];
    const bIdx = rest.indexOf(' b/');
    if (bIdx !== -1) return rest.slice(bIdx + 3);
    return rest.trim();
  };

  const blocks: string[] = [`### Diff Manifest (git diff --stat ${range})\n${statOut}`];
  let used = blocks[0]?.length ?? 0;
  const pointers: string[] = [];

  for (const chunk of chunks) {
    const firstLine = chunk.split('\n')[0] ?? '';
    const filePath = parseHeaderPath(firstLine);
    const isBinary = chunk.includes('GIT binary patch') || chunk.includes('Binary files ');
    const lines = chunk.split('\n');
    const additions = lines.filter(l => l.startsWith('+') && !l.startsWith('+++')).length;
    const deletions = lines.filter(l => l.startsWith('-') && !l.startsWith('---')).length;
    const block = `### ${filePath}\n\`\`\`diff\n${chunk}\n\`\`\``;
    if (used + block.length <= maxDiffChars) {
      blocks.push(block);
      used += block.length;
    } else {
      const statPart = isBinary ? '(binary)' : `(+${additions}/-${deletions})`;
      pointers.push(`[omitted: ${filePath} ${statPart} — inspect via git diff ${range} -- ${filePath} or file_read]`);
    }
  }

  return [...blocks, ...pointers].join('\n\n');
}

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    const res = await Bun.$`git -C ${dir} rev-parse --is-inside-work-tree`.quiet()
    return res.exitCode === 0
  } catch {
    return false
  }
}

export async function discardWorkingChanges(dir: string): Promise<void> {
  try {
    await Bun.$`git -C ${dir} checkout -- .`.quiet().nothrow()
    await Bun.$`git -C ${dir} clean -fd`.quiet().nothrow()
  } catch {
    // ignore
  }
}

export async function commitChanges(dir: string, message: string): Promise<void> {
  try {
    await Bun.$`git -C ${dir} add -A`
    await Bun.$`git -C ${dir} commit -m ${message}`.quiet().nothrow()
  } catch {
    // ignore
  }
}
