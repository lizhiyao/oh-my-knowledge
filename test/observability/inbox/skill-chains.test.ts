import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildSkillChainsForEvidence,
  inferSkillCwds,
  skillNamesFromReports,
} from '../../../src/observability/inbox/skill-chains.js';
import type { ObservationInboxReport } from '../../../src/observability/inbox/index.js';

const roots: string[] = [];
function projectWithSkill(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `omk-chain-${name}-`));
  roots.push(dir);
  const skillDir = join(dir, '.agents', 'skills', 'omk_chain_probe');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '# omk_chain_probe\n');
  return dir;
}
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

function reportWith(items: { skillName: string; cwd?: string }[]): ObservationInboxReport {
  return {
    meta: { skillInvocationCounts: {}, skillSessionCounts: {} },
    items,
  } as unknown as ObservationInboxReport;
}

describe('skill 链的单一生产者按报告内 cwd 证据建链', () => {
  it('单一 cwd 证据：在该目录建链，不误报缺 SKILL.md', () => {
    const dir = projectWithSkill('single');
    const report = reportWith([{ skillName: 'omk_chain_probe', cwd: dir }]);
    expect(inferSkillCwds([report]).get('omk_chain_probe')).toBe(dir);
    const { chains, skipped } = buildSkillChainsForEvidence(skillNamesFromReports([report]), [report]);
    expect(chains.omk_chain_probe?.definition.found).toBe(true);
    expect(skipped).toEqual([]);
  });

  it('多个 cwd 即歧义：跳过而不是任选一个', () => {
    const left = projectWithSkill('left');
    const right = projectWithSkill('right');
    const report = reportWith([
      { skillName: 'omk_chain_probe', cwd: left },
      { skillName: 'omk_chain_probe', cwd: right },
    ]);
    expect(inferSkillCwds([report]).get('omk_chain_probe')).toBeNull();
    const { chains, skipped } = buildSkillChainsForEvidence(skillNamesFromReports([report]), [report]);
    expect(chains.omk_chain_probe).toBeUndefined();
    expect(skipped).toEqual(['omk_chain_probe']);
  });

  it('items 无 cwd 时回退到 experience 调用证据，全无证据则跳过', () => {
    const dir = projectWithSkill('fallback');
    const withExperience = {
      meta: { skillInvocationCounts: {}, skillSessionCounts: {} },
      items: [],
      experience: { invocations: [{ skillName: 'omk_chain_probe', cwd: dir }] },
    } as unknown as ObservationInboxReport;
    expect(inferSkillCwds([withExperience]).get('omk_chain_probe')).toBe(dir);

    const withoutEvidence = reportWith([{ skillName: 'omk_chain_probe' }]);
    expect(inferSkillCwds([withoutEvidence]).size).toBe(0);
    const built = buildSkillChainsForEvidence(['omk_chain_probe'], [withoutEvidence]);
    expect(built.chains.omk_chain_probe).toBeUndefined();
    expect(built.skipped).toEqual(['omk_chain_probe']);
  });
});

