// Count actual Git launches: concurrent listings share probes and empty folders remain fresh.
import './fixtures/memory-secrets';
import { expect, test, spyOn } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tailnet from '../src/tailnet';
// Project probing is independent of this machine's external tailnet account.
const identity = spyOn(tailnet, 'identity').mockReturnValue({});
const { checkout } = await import('../src/projects');
identity.mockRestore();

test('cold checkouts share Git probes, cache commits, and recheck empty folders', async () => {
  const root = await mkdtemp(join(tmpdir(), 'checkout-shared-'));
  const other = await mkdtemp(join(tmpdir(), 'checkout-other-'));
  const spawn = spyOn(Bun, 'spawn');
  try {
    const [a, b, c] = await Promise.all([
      checkout(root),
      checkout(root),
      checkout(other),
    ]);
    expect(a).toBe(b);
    expect(c.root).toBe(other);
    expect(a.commit).toBe(false);
    expect(
      spawn.mock.calls.filter(
        ([args]) => Array.isArray(args) && args[0] === 'git'
      )
    ).toHaveLength(6);
    const init = Bun.spawnSync(['git', '-C', root, 'init', '--quiet']);
    expect(init.exitCode).toBe(0);
    const commit = Bun.spawnSync([
      'git',
      '-C',
      root,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '--quiet',
      '-m',
      'fixture',
    ]);
    expect(commit.exitCode).toBe(0);
    expect((await checkout(root)).commit).toBe(true);
    expect((await checkout(root)).commit).toBe(true);
    expect(
      spawn.mock.calls.filter(
        ([args]) => Array.isArray(args) && args[0] === 'git'
      )
    ).toHaveLength(9);
  } finally {
    spawn.mockRestore();
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(other, { recursive: true, force: true }),
    ]);
  }
}, 60000);
