import type { EvaluationEngineClock } from '../eval-core/engine/index.js';

/** Node.js clock for Core orchestration. It owns waiting only, never measurement identity. */
export function createNodeEvaluationClock(): EvaluationEngineClock {
  return Object.freeze({
    monotonicNow: () => performance.now(),
    timestamp: () => new Date().toISOString(),
    sleep(delayMs: number, signal: AbortSignal): Promise<void> {
      if (!Number.isFinite(delayMs) || delayMs < 0) {
        return Promise.reject(new TypeError('Clock delayMs 必须是有限非负数。'));
      }
      if (signal.aborted) return Promise.reject(signal.reason);
      return new Promise((resolve, reject) => {
        const abort = (): void => {
          clearTimeout(timer);
          reject(signal.reason);
        };
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', abort);
          resolve();
        }, delayMs);
        signal.addEventListener('abort', abort, { once: true });
      });
    },
  });
}
