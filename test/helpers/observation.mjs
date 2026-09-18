import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

// Test-only polling: the callback must bound its I/O by the remaining budget.
// Check again after it returns so a late response can never pass the smoke.
export async function observeWithin({ poll, timeoutMs, intervalMs, now = () => performance.now(), sleep = delay }) {
  const deadline = now() + timeoutMs;
  while (true) {
    const remainingMs = Math.floor(deadline - now());
    if (remainingMs <= 0) return false;
    let complete;
    try {
      complete = await poll(remainingMs);
    } catch (error) {
      if (now() >= deadline) return false;
      throw error;
    }
    if (now() >= deadline) return false;
    if (complete) return true;
    const sleepMs = Math.min(intervalMs, Math.floor(deadline - now()));
    if (sleepMs <= 0) return false;
    await sleep(sleepMs);
  }
}
