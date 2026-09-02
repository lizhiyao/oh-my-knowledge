import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { buildHealthPrompt } from '../../../../src/knowledge-artifacts/doctor/health/prompt-builder.js';
import type { HealthDimensionSpec } from '../../../../src/knowledge-artifacts/doctor/health/dimension-spec.js';

const dim = (id: string, displayName: string): HealthDimensionSpec => ({
  id,
  displayName,
  labelKey: `cli.doctor.health.dim.${id}`,
  severity: 'warn',
  promptSection: `内容: ${id}`,
});

const baseInput = {
  skillName: 'test-skill',
  skillContent: '你是一个助手。',
  skillRoot: '/tmp/skills/test-skill',
  subFiles: ['scripts/foo.sh', 'references/api.md'],
  siblingSkills: ['other-skill-a', 'other-skill-b'],
};

describe('buildHealthPrompt', () => {
  it('numbers dimensions automatically by registration order', () => {
    const dims = [dim('a', 'A 维度'), dim('b', 'B 维度'), dim('c', 'C 维度')];
    const prompt = buildHealthPrompt(baseInput, dims);
    assert.ok(prompt.includes('## 1. A 维度 (id: `a`)'));
    assert.ok(prompt.includes('## 2. B 维度 (id: `b`)'));
    assert.ok(prompt.includes('## 3. C 维度 (id: `c`)'));
  });

  it('inlines skill content (no Read needed for SKILL.md)', () => {
    const dims = [dim('a', 'A')];
    const prompt = buildHealthPrompt(baseInput, dims);
    assert.ok(prompt.includes('```markdown\n你是一个助手。\n```'));
  });

  it('builds dim_id enum from registered ids', () => {
    const dims = [dim('foo', 'Foo'), dim('bar-baz', 'Bar')];
    const prompt = buildHealthPrompt(baseInput, dims);
    assert.ok(prompt.includes('"foo" | "bar-baz"'));
  });

  it('includes "checklist must contain exactly N items" for N dims', () => {
    const dims = [dim('a', 'A'), dim('b', 'B'), dim('c', 'C')];
    const prompt = buildHealthPrompt(baseInput, dims);
    assert.ok(prompt.includes('恰好包含 3 项'));
  });

  it('lists sibling skills + sub-files in the input block', () => {
    const dims = [dim('a', 'A')];
    const prompt = buildHealthPrompt(baseInput, dims);
    assert.ok(prompt.includes('`other-skill-a`'));
    assert.ok(prompt.includes('`other-skill-b`'));
    assert.ok(prompt.includes('scripts/foo.sh'));
    assert.ok(prompt.includes('references/api.md'));
  });

  it('hints "no sub-files" when subFiles empty', () => {
    const prompt = buildHealthPrompt({ ...baseInput, subFiles: [] }, [dim('a', 'A')]);
    assert.ok(prompt.includes('no sub-files'));
  });

  it('hints "single .md skill" when skillRoot is null', () => {
    const prompt = buildHealthPrompt({ ...baseInput, skillRoot: null }, [dim('a', 'A')]);
    assert.ok(prompt.includes('skill 是单文件 .md'));
  });

  it('includes common rules (同根因合并 / Finding level / overall_health)', () => {
    const prompt = buildHealthPrompt(baseInput, [dim('a', 'A')]);
    assert.ok(prompt.includes('同根因合并'));
    assert.ok(prompt.includes('Finding level 判定'));
    assert.ok(prompt.includes('overall_health'));
  });
});
