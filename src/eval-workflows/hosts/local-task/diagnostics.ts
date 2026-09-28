import { AsyncLocalStorage } from 'node:async_hooks';
import { join } from 'node:path';
import { digestCanonicalJson, type ContentDescriptor, type JsonValue } from '../../../eval-core/contracts/index.js';
import type { NodeCoreContentStore } from '../../artifact-store/node-content-store.js';
import { publishPrivateJsonExclusive } from '../../artifact-store/private-json-file.js';
import type { LocalTaskOutput } from '../../inputs/contracts/local-task.js';

export interface TaskAttemptDiagnostic {
  readonly stage: 'execution' | 'acceptance';
  readonly status: string;
  readonly output: LocalTaskOutput;
  readonly stdout: string;
  readonly stderr: string;
  readonly processOutcome: { readonly exitCode: number | null; readonly signal: string | null; readonly failureKind: string | null } | null;
}

/** Host-only diagnostics use the existing content envelope, never an Execution success record. */
export function createTaskDiagnostics(store: NodeCoreContentStore, outputDirectory: string) {
  const context = new AsyncLocalStorage<{ runId: string; references: ContentDescriptor[] }>();
  return {
    async capture(diagnostic: TaskAttemptDiagnostic) {
      const current = context.getStore();
      if (!current) throw new Error('TASK_DIAGNOSTIC_CONTEXT_MISSING');
      const value = { diagnosticKind: 'local-task-attempt', diagnosticVersion: 1,
        runId: current.runId, capturedAt: new Date().toISOString(), ...diagnostic } as unknown as JsonValue;
      const reference = await store.put({ value, digest: digestCanonicalJson(value),
        mediaType: 'application/json', classification: 'sensitive' });
      const source = diagnostic.output.source;
      const key = digestCanonicalJson({ ...source, stage: diagnostic.stage }).slice('sha256:'.length);
      const publication = await publishPrivateJsonExclusive(join(outputDirectory, 'task-diagnostics', current.runId, `${key}.json`),
        { runId: current.runId, ...source, stage: diagnostic.stage, status: diagnostic.status, reference });
      if (publication !== 'published') throw new Error('TASK_DIAGNOSTIC_INDEX_EXISTS');
      current.references.push(reference);
    },
    async run<T>(runId: string, operation: () => Promise<T>) {
      const state = { runId, references: [] as ContentDescriptor[] };
      const value = await context.run(state, operation);
      return { value, references: state.references };
    },
  };
}
