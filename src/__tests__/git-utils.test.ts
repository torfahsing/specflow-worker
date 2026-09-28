import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  getCurrentBranch,
  branchExists,
  createBranch,
  checkoutBranch,
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
})
