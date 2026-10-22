import { createHash } from 'node:crypto';

interface PromptIdentity { promptVersion: string; systemDigest: string; systemBytes: number }
export interface EntityEvidenceSemanticsManifest {
  assetVersion: 'omk-entity-evidence-semantics/v1';
  changedVariable: 'prompt';
  composition: 'unchanged-strict30-then-raw-evidence-rules/v1';
  wireId: string;
  baseline: PromptIdentity;
  candidate: PromptIdentity;
  rules: { file: 'rules.txt'; digest: string; bytes: number };
}
const digest = (value: string) => `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
function verifyBytes(value: string, expected: { digest: string; bytes: number }, label: string) {
  if (Buffer.from(value, 'utf8').toString('utf8') !== value
    || Buffer.byteLength(value, 'utf8') !== expected.bytes || digest(value) !== expected.digest) {
    throw new Error(`Entity evidence semantics ${label} bytes differ from the frozen manifest.`);
  }
}

/** Pure composition only. Callers supply explicit bytes; no source, runtime, model or files are discovered. */
export function buildEntityEvidenceSemantics(input: {
  baselineSystem: string; rules: string; wireId: string; manifest: EntityEvidenceSemanticsManifest;
}) {
  const { baselineSystem, rules, wireId, manifest } = input;
  if (manifest.assetVersion !== 'omk-entity-evidence-semantics/v1' || manifest.changedVariable !== 'prompt'
    || manifest.composition !== 'unchanged-strict30-then-raw-evidence-rules/v1'
    || manifest.baseline.promptVersion !== 'knowledge-extraction-v30'
    || manifest.candidate.promptVersion !== 'knowledge-extraction-v34'
    || manifest.rules.file !== 'rules.txt' || wireId !== manifest.wireId) {
    throw new Error('Entity evidence semantics identity differs from the frozen joint-task candidate.');
  }
  verifyBytes(baselineSystem, { digest: manifest.baseline.systemDigest, bytes: manifest.baseline.systemBytes }, 'baseline');
  verifyBytes(rules, manifest.rules, 'rules');
  const system = baselineSystem + rules;
  verifyBytes(system, { digest: manifest.candidate.systemDigest, bytes: manifest.candidate.systemBytes }, 'candidate');
  return {
    baseline: { profileVersion: 'knowledge-extraction-prompt-profile/v1' as const,
      promptVersion: manifest.baseline.promptVersion, system: baselineSystem },
    candidate: { profileVersion: 'knowledge-extraction-prompt-profile/v1' as const,
      promptVersion: manifest.candidate.promptVersion, system },
  };
}
