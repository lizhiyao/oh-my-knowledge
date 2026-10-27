import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { KnowledgeApplication } from '../../../src/knowledge/application/application.js';

// Historical measurement bytes only. Production never imports this fixture or a legacy reader.
export const FROZEN_STRICT30_SYSTEM = readFileSync(new URL('./strict-v30.prompt.txt', import.meta.url), 'utf8');
if (Buffer.byteLength(FROZEN_STRICT30_SYSTEM, 'utf8') !== 63430
  || createHash('sha256').update(FROZEN_STRICT30_SYSTEM).digest('hex') !== '45ccb3821a6ec2c0ee1bc5f8f6ab4f2e3590724e2d4453cd39d77f46d4fb0085') {
  throw new Error('Historical strict30 measurement fixture changed.');
}
export const FROZEN_STRICT30_PROFILE = { profileVersion: 'knowledge-extraction-prompt-profile/v1' as const,
  promptVersion: 'knowledge-extraction-v30', system: FROZEN_STRICT30_SYSTEM };

/** Explicit test opt-in for unchanged private v30 tasks, never a production default. */
export function generateFrozenStrict30(app: KnowledgeApplication, ...args: Parameters<KnowledgeApplication['generate']>) {
  const [snapshotId, model, runId, signal, options] = args;
  return app.generate(snapshotId, model, runId, signal, { promptProfile: FROZEN_STRICT30_PROFILE, ...options });
}
