// Pure unit test for NodeBackgroundTasks — no testcontainers needed.
// Verifies (a) spawn tracks the promise, (b) drain awaits in-flight
// tasks, (c) drain swallows individual rejections (never throws),
// (d) idempotent drain when nothing is pending.

import { describe, it, expect, vi } from 'vitest';
import { NodeBackgroundTasks } from '../../../src/runtime/node/bg-tasks.js';

describe('NodeBackgroundTasks', () => {
  it('drain awaits in-flight tasks', async () => {
    const bg = new NodeBackgroundTasks();
    let done = false;
    bg.spawn(
      new Promise<void>((resolve) =>
        setTimeout(() => {
          done = true;
          resolve();
        }, 30),
      ),
    );
    expect(done).toBe(false);
    await bg.drain();
    expect(done).toBe(true);
  });

  it('drain swallows rejections without throwing', async () => {
    const bg = new NodeBackgroundTasks();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    bg.spawn(Promise.reject(new Error('boom')));
    await expect(bg.drain()).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('drain with no pending tasks is a no-op', async () => {
    const bg = new NodeBackgroundTasks();
    await expect(bg.drain()).resolves.toBeUndefined();
  });

  it('settled tasks are removed from the pending set', async () => {
    const bg = new NodeBackgroundTasks();
    bg.spawn(Promise.resolve());
    // Yield twice so the .finally microtask runs.
    await Promise.resolve();
    await Promise.resolve();
    // A subsequent drain should finish immediately (no pending).
    const t0 = Date.now();
    await bg.drain();
    expect(Date.now() - t0).toBeLessThan(50);
  });
});
