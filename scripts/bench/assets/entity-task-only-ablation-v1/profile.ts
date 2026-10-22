import { createHash } from 'node:crypto';

interface PromptIdentity { promptVersion: string; systemDigest: string; systemBytes: number }
export interface EntityTaskOnlyAblationManifest {
  assetVersion: 'omk-entity-task-only-ablation/v1';
  changedVariable: 'prompt';
  composition: 'unchanged-strict30-then-raw-task-suffix/v1';
  wireId: string;
  baseline: PromptIdentity;
  candidate: PromptIdentity;
  suffix: { file: 'task-suffix.txt'; digest: string; bytes: number };
}
const digest = (value: string) => `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
function verifyBytes(value: string, expected: { digest: string; bytes: number }, label: string) {
  if (Buffer.from(value, 'utf8').toString('utf8') !== value
    || Buffer.byteLength(value, 'utf8') !== expected.bytes || digest(value) !== expected.digest) {
    throw new Error(`Entity task ablation ${label} bytes differ from the frozen manifest.`);
  }
}

/** Pure composition only. Callers supply explicit bytes; no source, runtime, model or files are discovered. */
export function buildEntityTaskOnlyAblation(input: {
  baselineSystem: string; suffix: string; wireId: string; manifest: EntityTaskOnlyAblationManifest;
}) {
  const { baselineSystem, suffix, wireId, manifest } = input;
  if (manifest.assetVersion !== 'omk-entity-task-only-ablation/v1' || manifest.changedVariable !== 'prompt'
    || manifest.composition !== 'unchanged-strict30-then-raw-task-suffix/v1'
    || manifest.baseline.promptVersion !== 'knowledge-extraction-v30'
    || manifest.candidate.promptVersion !== 'knowledge-extraction-v33'
    || manifest.suffix.file !== 'task-suffix.txt' || wireId !== manifest.wireId) {
    throw new Error('Entity task ablation identity differs from the frozen task contrast.');
  }
  verifyBytes(baselineSystem, { digest: manifest.baseline.systemDigest, bytes: manifest.baseline.systemBytes }, 'baseline');
  verifyBytes(suffix, manifest.suffix, 'suffix');
  const system = baselineSystem + suffix;
  verifyBytes(system, { digest: manifest.candidate.systemDigest, bytes: manifest.candidate.systemBytes }, 'candidate');
  return {
    baseline: { profileVersion: 'knowledge-extraction-prompt-profile/v1' as const,
      promptVersion: manifest.baseline.promptVersion, system: baselineSystem },
    candidate: { profileVersion: 'knowledge-extraction-prompt-profile/v1' as const,
      promptVersion: manifest.candidate.promptVersion, system },
  };
}
