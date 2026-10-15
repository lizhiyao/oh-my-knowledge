import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';

const { role, path, shared, moduleUrl, pauseAt = 'read' } = workerData;
const state = new Int32Array(shared);
if (role === 'stale-reader') {
  const method = pauseAt === 'read' ? 'readFileSync' : 'unlinkSync';
  const original = fs[method];
  let paused = false;
  fs[method] = function (file, ...args) {
    const bytes = pauseAt === 'read' ? original(file, ...args) : undefined;
    if (file === path && !paused) {
      paused = true;
      parentPort.postMessage('paused-recovery');
      Atomics.wait(state, 0, 0, 5000);
    }
    return pauseAt === 'read' ? bytes : original(file, ...args);
  };
  syncBuiltinESMExports();
}

// Execute the current source, transpiled by the test, in an independent native Node worker.
const { withFileLock } = await import(moduleUrl);
try {
  withFileLock(path, () => {
    if (role === 'new-writer') {
      parentPort.postMessage('new-writer-holds-lock');
      Atomics.wait(state, 1, 0, 5000);
    }
  }, { staleMs: 1, timeoutMs: 500, retryMs: 1 });
  parentPort.postMessage('entered');
} catch (error) {
  parentPort.postMessage(error.name);
}
