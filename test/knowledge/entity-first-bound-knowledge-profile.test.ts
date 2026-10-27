import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildEntityFirstBoundKnowledge, type EntityFirstBoundKnowledgeManifest } from '../../scripts/bench/assets/entity-first-bound-knowledge-v1/profile.js';
import { FROZEN_STRICT30_SYSTEM, FROZEN_STRICT30_PROFILE } from './fixtures/frozen-strict30.js';
import { WINDOW_EXTRACTION_WIRE_ID } from '../../src/knowledge/extraction/model-wire.js';

const asset = new URL('../../scripts/bench/assets/entity-first-bound-knowledge-v1/', import.meta.url);
const hash = (value: string) => `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
function input() {
  const manifest: EntityFirstBoundKnowledgeManifest = JSON.parse(readFileSync(new URL('manifest.json', asset), 'utf8'));
  return { baselineSystem: FROZEN_STRICT30_SYSTEM, rules: readFileSync(new URL(manifest.rules.file, asset), 'utf8'),
    suffix: readFileSync(new URL(manifest.suffix.file, asset), 'utf8'), wireId: WINDOW_EXTRACTION_WIRE_ID, manifest };
}

describe('frozen entity-first research profile (no model or quality fixture)', () => {
  it('composes the original strict30, evidence rules and entity-only suffix in order without changing baseline or wire', () => {
    const value = input(), profiles = buildEntityFirstBoundKnowledge(value);
    const semantics = JSON.parse(readFileSync(new URL('../entity-evidence-semantics-v1/manifest.json', asset), 'utf8'));
    const task = JSON.parse(readFileSync(new URL('../entity-task-only-ablation-v1/manifest.json', asset), 'utf8'));
    expect(FROZEN_STRICT30_PROFILE.promptVersion).toBe('knowledge-extraction-v30');
    expect(hash(FROZEN_STRICT30_SYSTEM)).toBe('sha256:45ccb3821a6ec2c0ee1bc5f8f6ab4f2e3590724e2d4453cd39d77f46d4fb0085');
    expect(WINDOW_EXTRACTION_WIRE_ID).toBe('sha256:63e1a6668343df71cc33584c1b5d5f6d6c318c7e3b4e03ec9bf4bb69d7b126fe');
    expect(value.manifest.rules).toEqual({ ...semantics.rules, file: '../entity-evidence-semantics-v1/rules.txt' });
    expect(value.manifest.suffix).toEqual({ ...task.suffix, file: '../entity-task-only-ablation-v1/task-suffix.txt' });
    expect(hash(value.baselineSystem + value.rules)).toBe(semantics.candidate.systemDigest);
    expect(hash(value.baselineSystem + value.suffix)).toBe(task.candidate.systemDigest);
    expect(profiles.baseline).toEqual({ profileVersion: 'knowledge-extraction-prompt-profile/v1', promptVersion: 'knowledge-extraction-v30', system: FROZEN_STRICT30_SYSTEM });
    expect(profiles.candidate).toEqual({ profileVersion: 'knowledge-extraction-prompt-profile/v1', promptVersion: 'knowledge-extraction-v35', system: value.baselineSystem + value.rules + value.suffix });
    expect(Buffer.byteLength(profiles.candidate.system, 'utf8')).toBe(71685);
    expect(hash(profiles.candidate.system)).toBe('sha256:39d852f41281743340feae6785037abfcd34e4e5d3ca0f499b1ac4dd5fac61a5');
  });

  it('rejects drift in each reused byte source, order or UTF-8 rather than trimming or repairing it', () => {
    const value = input();
    for (const changed of [
      { ...value, baselineSystem: value.baselineSystem + '\n' },
      { ...value, rules: value.rules.trim() },
      { ...value, suffix: value.suffix.trim() },
      { ...value, rules: value.suffix, suffix: value.rules },
      { ...value, suffix: value.suffix + '\ud800' },
    ]) expect(() => buildEntityFirstBoundKnowledge(changed)).toThrow(/frozen/);
  });

  it('rejects a different task, version, wire or source asset identity', () => {
    const value = input();
    for (const changed of [
      { ...value, wireId: hash('other wire') },
      { ...value, manifest: { ...value.manifest, wireId: hash('other wire') } },
      { ...value, manifest: { ...value.manifest, baseline: { ...value.manifest.baseline, promptVersion: 'knowledge-extraction-v34' } } },
      { ...value, manifest: { ...value.manifest, candidate: { ...value.manifest.candidate, promptVersion: 'knowledge-extraction-v33' } } },
      { ...value, manifest: { ...value.manifest, candidate: { ...value.manifest.candidate, systemBytes: 71684 } } },
      { ...value, manifest: { ...value.manifest, rules: { ...value.manifest.rules, digest: hash('other rules') } } },
    ]) expect(() => buildEntityFirstBoundKnowledge(changed)).toThrow(/frozen/);
  });

  it('rejects retuning the manifest to give modified source bytes the same v35 identity', () => {
    const value = input(), rules = value.rules + '\n', system = value.baselineSystem + rules + value.suffix;
    expect(() => buildEntityFirstBoundKnowledge({ ...value, rules, manifest: { ...value.manifest,
      rules: { ...value.manifest.rules, digest: hash(rules), bytes: Buffer.byteLength(rules, 'utf8') },
      candidate: { ...value.manifest.candidate, systemDigest: hash(system), systemBytes: Buffer.byteLength(system, 'utf8') },
    } })).toThrow(/frozen/);
  });
});
