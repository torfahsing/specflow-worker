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
