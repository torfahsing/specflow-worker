import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  getCurrentBranch,
  branchExists,
  createBranch,
  checkoutBranch,
  getRepoStatus,
  isGitRepo,
} from '../git/utils'

async function initRepo(dir: string): Promise<void> {
  await Bun.spawn(['git', '-C', dir, 'init']).exited
  await Bun.spawn(['git', '-C', dir, 'config', 'user.email', 'test@test.com']).exited
  await Bun.spawn(['git', '-C', dir, 'config', 'user.name', 'Test']).exited
  await Bun.spawn(['git', '-C', dir, 'commit', '--allow-empty', '-m', 'init']).exited
}

describe('git/utils', () => {
  let testDir: string

  beforeEach(async () => {
    testDir = await mkdtemp(path.join(tmpdir(), 'specflow-worker-git-test-'))
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  describe('getCurrentBranch', () => {
    it('reads the initial branch name', async () => {
      await initRepo(testDir)
      const branch = await getCurrentBranch(testDir)
      expect(branch).toBe('master')
    })
  })

  describe('branchExists', () => {
    beforeEach(async () => {
      await initRepo(testDir)
    })

    it('returns false for a nonexistent branch', async () => {
      expect(await branchExists(testDir, 'nope')).toBe(false)
    })

    it('returns true after createBranch', async () => {
      await createBranch(testDir, 'feature/new-thing')
      expect(await branchExists(testDir, 'feature/new-thing')).toBe(true)
    })
  })

  describe('createBranch', () => {
    beforeEach(async () => {
      await initRepo(testDir)
    })

    it('creates a new branch', async () => {
      await createBranch(testDir, 'feature/new-thing')
      expect(await branchExists(testDir, 'feature/new-thing')).toBe(true)
    })
  })

  describe('checkoutBranch', () => {
    beforeEach(async () => {
      await initRepo(testDir)
    })

    it('switches to the new branch', async () => {
      await createBranch(testDir, 'feature/switch-to-me')
      await checkoutBranch(testDir, 'feature/switch-to-me')
      expect(await getCurrentBranch(testDir)).toBe('feature/switch-to-me')
    })

    it('rejects with a message starting "Failed to checkout branch" for a missing branch', async () => {
      await expect(checkoutBranch(testDir, 'nonexistent-branch')).rejects.toThrow(
        /Failed to checkout branch/
      )
    })
  })

  describe('branchExists on a non-git directory', () => {
    it('returns false without throwing', async () => {
      // testDir is a plain directory (no git init)
      expect(await branchExists(testDir, 'anything')).toBe(false)
    })
  })

  describe('getRepoStatus', () => {
    it('returns branch, empty dirtyFiles and lastCommit for a clean repo', async () => {
      await initRepo(testDir)
      const status = await getRepoStatus(testDir)
      expect(status.branch).toBe(await getCurrentBranch(testDir))
      expect(status.dirtyFiles).toEqual([])
      expect(status.lastCommit).toBeDefined()
      expect(status.lastCommit?.sha).toMatch(/^[0-9a-f]{40}$/i)
      expect(status.lastCommit?.message.length).toBeGreaterThan(0)
      expect(status.lastCommit?.author).toMatch(/^.+ <.+@.+>$/)
      expect(status.lastCommit?.date).toMatch(/\d{4}-\d{2}-\d{2}T/)
      expect(Number.isNaN(Date.parse(status.lastCommit!.date))).toBe(false)
    })

    it('returns branch null on detached HEAD while keeping lastCommit', async () => {
      await initRepo(testDir)
      await Bun.spawn(['git', '-C', testDir, 'checkout', '--detach', 'HEAD']).exited
      const status = await getRepoStatus(testDir)
      expect(status.branch).toBeNull()
      expect(status.lastCommit).toBeDefined()
    })

    it('lists modified and untracked files in dirtyFiles', async () => {
      await initRepo(testDir)
      const tracked = path.join(testDir, 'tracked.txt')
      await Bun.write(tracked, 'v1\n')
      await Bun.spawn(['git', '-C', testDir, 'add', 'tracked.txt']).exited
      await Bun.spawn(['git', '-C', testDir, 'commit', '-m', 'add tracked file']).exited
      await Bun.write(tracked, 'v2\n')
      await Bun.write(path.join(testDir, 'untracked.txt'), 'new\n')
      const status = await getRepoStatus(testDir)
      expect(status.dirtyFiles).toEqual(expect.arrayContaining(['tracked.txt', 'untracked.txt']))
    })

    it('omits lastCommit for a zero-commit repo', async () => {
      await Bun.spawn(['git', '-C', testDir, 'init']).exited
      const status = await getRepoStatus(testDir)
      expect(status.dirtyFiles).toEqual([])
      expect('lastCommit' in status).toBe(false)
      expect(
        status.branch === null ||
          (typeof status.branch === 'string' && status.branch.length > 0)
      ).toBe(true)
    })
  })

  describe('getRepoStatus on a non-git directory', () => {
    it('reports isGitRepo false for a plain directory', async () => {
      expect(await isGitRepo(testDir)).toBe(false)
    })

    it('throws when called directly, proving the dispatcher guard is necessary', async () => {
      await expect(getRepoStatus(testDir)).rejects.toThrow()
    })
  })
})
