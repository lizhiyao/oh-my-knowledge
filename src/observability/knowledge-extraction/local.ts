import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { canonicalJson } from '../../knowledge/store.js';
import { KnowledgeApplication } from './application.js';
import { CodexEvidenceStore } from './adapters/codex-evidence.js';
import { FileKnowledgeStore } from './adapters/knowledge-store.js';
import { FileExtractionRunStore } from './adapters/run-store.js';

/** The root is an explicit user choice shared by CLI and Studio. */
export function createLocalKnowledgeApplication(root: string): KnowledgeApplication {
  if (!root.trim()) throw new Error('Explicit knowledge workspace required.');
  const workspace = resolve(root);
  return new KnowledgeApplication({
    evidence: new CodexEvidenceStore(join(workspace, 'sources')),
    knowledge: new FileKnowledgeStore(join(workspace, 'items'), 'local'),
    runs: new FileExtractionRunStore(join(workspace, 'runs')),
    id: randomUUID, now: () => new Date().toISOString(),
    hash: (value) => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`,
    actor: { actorKind: 'human', actorId: 'local-user' },
  });
}
