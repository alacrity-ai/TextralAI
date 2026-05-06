import { describe, it, expect } from 'vitest';
import { backoffDelay, sleep } from '../src/providers/lib/backoff.js';

describe('backoffDelay', () => {
  it('attempt 0 falls in [400, 600] ms (~500 ± 20%)', () => {
    for (let i = 0; i < 50; i++) {
      const d = backoffDelay(0);
      expect(d).toBeGreaterThanOrEqual(400);
      expect(d).toBeLessThanOrEqual(600);
    }
  });

  it('caps exponential growth at the cap (4000) ± jitter', () => {
    for (let i = 0; i < 50; i++) {
      const d = backoffDelay(10);
      expect(d).toBeLessThanOrEqual(4800); // cap + 20% jitter
      expect(d).toBeGreaterThanOrEqual(3200);
    }
  });

  it('honors retry-after up to 2× cap', () => {
    expect(backoffDelay(0, 1500)).toBeLessThanOrEqual(8000);
    expect(backoffDelay(0, 30_000)).toBe(8000); // capped at 2× CAP_MS
  });
});

describe('sleep', () => {
  it('resolves after the requested duration', async () => {
    const start = Date.now();
    await sleep(20);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });

  it('rejects when an aborted signal is supplied up front', async () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error('cancel'));
    await expect(sleep(5000, ctrl.signal)).rejects.toThrow('cancel');
  });

  it('rejects when the signal fires mid-sleep', async () => {
    const ctrl = new AbortController();
    const p = sleep(5000, ctrl.signal);
    setTimeout(() => ctrl.abort(new Error('later')), 5);
    await expect(p).rejects.toThrow('later');
  });
});
