import { createHash } from 'node:crypto';

interface PromptIdentity { promptVersion: string; systemDigest: string; systemBytes: number }
export interface EntityFirstBoundKnowledgeManifest {
  assetVersion: 'omk-entity-first-bound-knowledge/v1';
  stageKind: 'entity-analysis-only';
  composition: 'unchanged-strict30-then-raw-evidence-rules-then-raw-entity-task-suffix/v1';
  wireId: string;
  baseline: PromptIdentity;
  candidate: PromptIdentity;
  rules: { file: '../entity-evidence-semantics-v1/rules.txt'; digest: string; bytes: number };
  suffix: { file: '../entity-task-only-ablation-v1/task-suffix.txt'; digest: string; bytes: number };
}

const frozen = {
  wireId: 'sha256:63e1a6668343df71cc33584c1b5d5f6d6c318c7e3b4e03ec9bf4bb69d7b126fe',
  baseline: { digest: 'sha256:45ccb3821a6ec2c0ee1bc5f8f6ab4f2e3590724e2d4453cd39d77f46d4fb0085', bytes: 63430 },
  rules: { digest: 'sha256:d13d6a3d92ff3698c103851a32efd4fe60a14566f6ae13652f1d23c9fc3a7b4a', bytes: 7912 },
  suffix: { digest: 'sha256:019627e19a09bced18c710534b10d8e3e98f26ff424cc7dc22b5a3f9b0f6c696', bytes: 343 },
  candidate: { digest: 'sha256:39d852f41281743340feae6785037abfcd34e4e5d3ca0f499b1ac4dd5fac61a5', bytes: 71685 },
} as const;
const digest = (value: string) => `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
function verifyBytes(value: string, declared: { digest: string; bytes: number }, expected: { digest: string; bytes: number }, label: string) {
  if (declared.digest !== expected.digest || declared.bytes !== expected.bytes
    || Buffer.from(value, 'utf8').toString('utf8') !== value
    || Buffer.byteLength(value, 'utf8') !== expected.bytes || digest(value) !== expected.digest) {
    throw new Error(`Entity-first ${label} bytes differ from the frozen research profile.`);
  }
}

/** Pure composition of existing frozen bytes. The trusted research host supplies assets; no discovery or model access. */
export function buildEntityFirstBoundKnowledge(input: {
  baselineSystem: string; rules: string; suffix: string; wireId: string; manifest: EntityFirstBoundKnowledgeManifest;
}) {
  const { baselineSystem, rules, suffix, wireId, manifest } = input;
  if (manifest.assetVersion !== 'omk-entity-first-bound-knowledge/v1' || manifest.stageKind !== 'entity-analysis-only'
    || manifest.composition !== 'unchanged-strict30-then-raw-evidence-rules-then-raw-entity-task-suffix/v1'
    || manifest.baseline.promptVersion !== 'knowledge-extraction-v30'
    || manifest.candidate.promptVersion !== 'knowledge-extraction-v35'
    || manifest.rules.file !== '../entity-evidence-semantics-v1/rules.txt'
    || manifest.suffix.file !== '../entity-task-only-ablation-v1/task-suffix.txt'
    || wireId !== frozen.wireId || manifest.wireId !== frozen.wireId) {
    throw new Error('Entity-first identity differs from the frozen research profile.');
  }
  verifyBytes(baselineSystem, { digest: manifest.baseline.systemDigest, bytes: manifest.baseline.systemBytes }, frozen.baseline, 'baseline');
  verifyBytes(rules, manifest.rules, frozen.rules, 'rules');
  verifyBytes(suffix, manifest.suffix, frozen.suffix, 'suffix');
  const system = baselineSystem + rules + suffix;
  verifyBytes(system, { digest: manifest.candidate.systemDigest, bytes: manifest.candidate.systemBytes }, frozen.candidate, 'candidate');
  return {
    baseline: { profileVersion: 'knowledge-extraction-prompt-profile/v1' as const,
      promptVersion: manifest.baseline.promptVersion, system: baselineSystem },
    candidate: { profileVersion: 'knowledge-extraction-prompt-profile/v1' as const,
      promptVersion: manifest.candidate.promptVersion, system },
  };
}
