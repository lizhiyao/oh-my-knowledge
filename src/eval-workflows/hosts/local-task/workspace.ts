import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkspaceDescriptor, WorkspaceProvider } from '../../../eval-runtime/workspace.js';
import type { TaskFile } from '../../inputs/contracts/local-task.js';
import { materializeTaskFiles, taskTreeDigest } from './files.js';

export function createTaskWorkspace(files: readonly TaskFile[], temporaryRoot: string): {
  descriptor: WorkspaceDescriptor; provider: WorkspaceProvider;
} {
  const digest = taskTreeDigest(files);
  const descriptor: WorkspaceDescriptor = {
    resourceId: 'local-task-snapshot', digest, mediaType: 'application/vnd.omk.local-task-tree',
    classification: 'sensitive', size: files.reduce((size, file) => size + Buffer.from(file.contentBase64, 'base64').length, 0),
  };
  return {
    descriptor,
    provider: {
      providerId: 'omk.local-task-workspace/v1', version: '1.0.0',
      fingerprintFacets: { snapshotDigest: digest, retryState: 'shared-within-trial' },
      async open(request) {
        request.signal.throwIfAborted();
        if (request.descriptor.digest !== digest) throw new Error('TASK_SNAPSHOT_MISMATCH');
        const root = await mkdtemp(join(temporaryRoot, 'trial-'));
        try {
          await materializeTaskFiles(root, files);
          request.signal.throwIfAborted();
          return { root, close: () => rm(root, { recursive: true, force: true }) };
        } catch (error) {
          await rm(root, { recursive: true, force: true });
          throw error;
        }
      },
    },
  };
}
