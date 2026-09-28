import type { CapturedContent } from '../../eval-core/contracts/index.js';
import { LocalTaskAcceptanceSchema, LocalTaskOutputSchema } from '../inputs/contracts/local-task-evidence.js';

/** Only declared file metadata reaches Studio; source bytes and Agent prose stay in raw evidence. */
export function projectLocalTaskOutput(content: CapturedContent | undefined) {
  if (content?.contentKind !== 'inline' || content.classification === 'secret' || content.classification === 'gold') return undefined;
  const parsed = LocalTaskOutputSchema.safeParse(content.value);
  if (!parsed.success) return undefined;
  return {
    snapshotDigest: parsed.data.snapshotDigest,
    files: parsed.data.files.map(({ path, digest, change }) => ({ path, digest, change })),
    missing: parsed.data.missing,
    collectionErrors: parsed.data.collectionErrors,
  };
}

export function projectLocalTaskAcceptance(content: CapturedContent | undefined) {
  if (content?.contentKind !== 'inline' || content.classification === 'secret' || content.classification === 'gold'
    || content.value === null || typeof content.value !== 'object' || Array.isArray(content.value)) return undefined;
  const { acceptanceDigest, ...value } = content.value;
  const parsed = LocalTaskAcceptanceSchema.safeParse(value);
  if (!parsed.success || typeof acceptanceDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(acceptanceDigest)) return undefined;
  return { acceptanceDigest, passed: parsed.data.passed, checks: parsed.data.checks.map(({ checkId, passed }) => ({ checkId, passed })) };
}
