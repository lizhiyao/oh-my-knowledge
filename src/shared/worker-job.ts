import { Worker, parentPort, workerData, type TransferListItem } from 'node:worker_threads';

export class WorkerJobError extends Error {
  constructor(readonly code: 'worker_busy' | 'worker_cancelled' | 'worker_failed') { super(code); this.name = 'WorkerJobError'; }
}
export interface WorkerJobContext { readonly signal: AbortSignal; checkpoint(): void }

/** A file worker has its own entry; eval/stdin input mode must not override it.
 * Keep all other inherited flags, including permission restrictions and preload/loader options. */
export function fileWorkerExecArgv(argv: readonly string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index];
    if (option === '--input-type') {
      // Do not swallow a following restriction flag if a malformed argv lacks its value.
      if (argv[index + 1] !== undefined && !argv[index + 1].startsWith('-')) index++;
    } else if (!option.startsWith('--input-type=')) result.push(option);
  }
  return result;
}

/** One fresh worker, one active lease and no queue. Only delivery-owned fixed URLs are supplied. */
export function createWorkerJobService(entry: URL, cancellation: 'cooperative' | 'terminate') {
  let occupied = false;
  return {
    reserve(signal?: AbortSignal) {
      if (signal?.aborted) throw new WorkerJobError('worker_cancelled');
      if (occupied) throw new WorkerJobError('worker_busy');
      occupied = true;
      const flag = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
      let worker: Worker | undefined, used = false, released = false;
      const abort = () => {
        Atomics.store(flag, 0, 1);
        if (worker) {
          // A producing worker must finish executor cancellation, archive and cleanup itself.
          if (cancellation === 'terminate') void worker.terminate().catch(() => undefined);
          else { try { worker.postMessage({ messageKind: 'abort' }); } catch { /* exit owns final settlement */ } }
        }
      };
      signal?.addEventListener('abort', abort, { once: true });
      const release = () => {
        if (released || worker) return;
        released = true; occupied = false; signal?.removeEventListener('abort', abort);
      };
      return {
        release,
        run<T>(input: unknown, transferList: readonly TransferListItem[] = []): Promise<T> {
          if (used || released) return Promise.reject(new WorkerJobError('worker_failed'));
          used = true;
          if (signal?.aborted) { abort(); release(); return Promise.reject(new WorkerJobError('worker_cancelled')); }
          return new Promise<T>((resolve, reject) => {
            let result: T | undefined, received = false, failure: WorkerJobError | undefined;
            const inherited = process.execArgv, filtered = fileWorkerExecArgv(inherited);
            // Keep Node's normal inheritance unless eval/stdin mode actually needs removal.
            try { worker = new Worker(entry, { ...(filtered.length === inherited.length ? {} : { execArgv: filtered }), workerData: { input, cancellation: flag.buffer }, transferList: [...transferList] }); }
            catch { release(); reject(new WorkerJobError('worker_failed')); return; }
            const instance = worker;
            const onMessage = (message: unknown) => {
              if (received || !message || typeof message !== 'object' || !('messageKind' in message)
                || message.messageKind !== 'result' || !('value' in message)) { failure = new WorkerJobError('worker_failed'); return; }
              received = true; result = message.value as T;
            };
            const onError = () => { failure = new WorkerJobError('worker_failed'); };
            const onExit = (code: number) => {
              instance.off('message', onMessage); instance.off('error', onError); instance.off('exit', onExit);
              worker = undefined; release();
              if (signal?.aborted) reject(new WorkerJobError('worker_cancelled'));
              else if (failure || code !== 0 || !received) reject(failure ?? new WorkerJobError('worker_failed'));
              else resolve(result as T);
            };
            instance.on('message', onMessage); instance.once('error', onError); instance.once('exit', onExit);
            // Abort can race with worker construction; the shared flag is also checked before dispatch.
            if (signal?.aborted) abort();
          });
        },
      };
    },
  };
}

/** Worker-only processor. Failures never transport exception text, input or filesystem paths. */
export async function runWorkerJob(handler: (input: unknown, context: WorkerJobContext) => unknown | Promise<unknown>): Promise<void> {
  if (!parentPort) throw new Error('Worker job requires its fixed worker entry.');
  const port = parentPort, data = workerData as { input: unknown; cancellation: SharedArrayBuffer };
  const flag = new Int32Array(data.cancellation), controller = new AbortController();
  const checkpoint = () => { if (Atomics.load(flag, 0)) controller.abort(); controller.signal.throwIfAborted(); };
  const onMessage = (message: unknown) => {
    if (message && typeof message === 'object' && 'messageKind' in message && message.messageKind === 'abort') controller.abort();
  };
  port.on('message', onMessage);
  try {
    checkpoint();
    const value = await handler(data.input, { signal: controller.signal, checkpoint });
    port.postMessage({ messageKind: 'result', value });
  } catch { process.exitCode = 1; }
  finally { port.off('message', onMessage); port.close(); }
}
