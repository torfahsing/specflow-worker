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

export async function getDefaultBranch(dir: string): Promise<string> {
  if (await branchExists(dir, 'main')) return 'main'
  if (await branchExists(dir, 'master')) return 'master'
  return 'main'
}

export async function createBranch(
  dir: string,
  branch: string,
  startPoint?: string,
): Promise<void> {
  try {
    const base = startPoint || (await getDefaultBranch(dir))
    if (await branchExists(dir, base)) {
      await Bun.$`git -C ${dir} branch ${branch} ${base}`.text()
    } else {
      await Bun.$`git -C ${dir} branch ${branch}`.text()
    }
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

export async function discardWorkingChanges(dir: string): Promise<void> {
  try {
    await Bun.$`git -C ${dir} checkout -- .`.text()
    await Bun.$`git -C ${dir} clean -fd`.text()
  } catch (err) {
    console.error(`[git] failed to discard working changes: ${(err as Error).message}`)
  }
}

export async function commitChanges(dir: string, message: string): Promise<boolean> {
  try {
    const status = (await Bun.$`git -C ${dir} status --porcelain`.text()).trim()
    if (!status) return false
    await Bun.$`git -C ${dir} add -A`.text()
    await Bun.$`git -C ${dir} commit -m ${message}`.text()
    console.log(`[git] committed changes in '${dir}': ${message}`)
    return true
  } catch (err) {
    console.warn(`[git] commit failed: ${(err as Error).message}`)
    return false
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

export async function initRepo(dir: string): Promise<void> {
  try {
    await Bun.$`git -C ${dir} init`.quiet()
  } catch (err) {
    throw new Error(`Failed to init repo at '${dir}': ${(err as Error).message}`)
  }
}

export async function hasUncommittedChanges(dir: string): Promise<boolean> {
  try {
    const status = (await Bun.$`git -C ${dir} status --porcelain`.text()).trim()
    return status.length > 0
  } catch {
    return false
  }
}

export async function rebaseBranch(dir: string, branch: string, onto = 'main'): Promise<void> {
  try {
    await Bun.$`git -C ${dir} rebase ${onto} ${branch}`.quiet()
  } catch (err) {
    await Bun.$`git -C ${dir} rebase --abort`.quiet().catch(() => {})
    throw new Error(`Failed to rebase '${branch}' onto '${onto}': ${(err as Error).message}`)
  }
}

export async function getChangedFiles(dir: string, base?: string): Promise<string[]> {
  try {
    const out = base
      ? await Bun.$`git -C ${dir} diff --name-only ${base}...HEAD`.text()
      : await Bun.$`git -C ${dir} diff --name-only HEAD`.text()
    return out.trim().split('\n').filter(Boolean)
  } catch {
    try {
      const out = await Bun.$`git -C ${dir} diff --name-only HEAD`.text()
      return out.trim().split('\n').filter(Boolean)
    } catch {
      return []
    }
  }
}

export async function hasRemote(dir: string): Promise<boolean> {
  try {
    await Bun.$`git -C ${dir} remote get-url origin`.quiet()
    return true
  } catch {
    return false
  }
}

export async function pushBranch(dir: string, branch: string): Promise<void> {
  try {
    await Bun.$`git -C ${dir} push -u origin ${branch}`.quiet()
  } catch (err) {
    throw new Error(`Failed to push branch '${branch}': ${(err as Error).message}`)
  }
}

export async function createPullRequest(
  dir: string,
  title: string,
  body: string,
  branch: string,
): Promise<string | null> {
  try {
    const out = (
      await Bun.$`gh pr create --title ${title} --body ${body} --head ${branch}`.cwd(dir).text()
    ).trim()
    return out
  } catch (err) {
    console.warn(`[git] Failed to create PR: ${(err as Error).message}`)
    return null
  }
}

const EXT_LANGUAGE: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
  '.json': 'json', '.md': 'markdown', '.html': 'html', '.css': 'css', '.scss': 'scss',
  '.yaml': 'yaml', '.yml': 'yaml', '.py': 'python', '.go': 'go', '.rs': 'rust',
  '.sh': 'shell', '.sql': 'sql', '.xml': 'xml', '.java': 'java', '.rb': 'ruby',
}

export interface FileDiff {
  path: string
  original: string
  modified: string
  language: string
}

export async function getFileDiff(dir: string, filepath: string, branch: string): Promise<FileDiff> {
  const ext = filepath.substring(filepath.lastIndexOf('.'))
  const language = EXT_LANGUAGE[ext.toLowerCase()] || 'plaintext'

  const branchTip = branch
  let baseRef = `${branchTip}~1`

  try {
    const out = await Bun.$`git -C ${dir} log --oneline main..${branch}`.text()
    const uniqueCommits = out.trim().split('\n').filter(Boolean)
    if (uniqueCommits.length > 0) {
      const oldest = uniqueCommits[uniqueCommits.length - 1].split(' ')[0]
      baseRef = `${oldest}~1`
    }
  } catch {
    // use branch~1
  }

  let original = ''
  try {
    original = await Bun.$`git -C ${dir} show ${baseRef}:${filepath}`.text()
  } catch {
    // new file
  }

  let modified = ''
  try {
    modified = await Bun.$`git -C ${dir} show ${branchTip}:${filepath}`.text()
  } catch {
    // deleted file
  }

  return { path: filepath, original, modified, language }
}
