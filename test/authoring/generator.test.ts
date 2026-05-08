import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { generateSamples, sanitizeGeneratedSamples, buildSamplesPrompt } from '../../src/authoring/generator.js';
import type { Sample } from '../../src/types/index.js';

describe('generateSamples', () => {
  it('is a function', () => {
    assert.equal(typeof generateSamples, 'function');
  });

  it('throws on invalid executor (script not found)', async () => {
    await assert.rejects(
      () => generateSamples({ skillContent: 'test', count: 1, executorName: 'nonexistent' }),
      /ENOENT|failed/,
    );
  });
});

describe('buildSamplesPrompt', () => {
  it('embeds skill content and count', () => {
    const prompt = buildSamplesPrompt({ skillContent: '# my skill', count: 7 });
    assert.ok(prompt.includes('# my skill'));
    assert.ok(prompt.includes('生成 7 个评测用例'));
  });

  it('omits explicit count when count is undefined (LLM auto-decides)', () => {
    const prompt = buildSamplesPrompt({ skillContent: 's', count: undefined });
    // 不应包含具体数字 + "个评测用例"的强制句式
    assert.ok(!/生成 \d+ 个评测用例/.test(prompt), 'should not contain "生成 N 个评测用例"');
    // 应明确告诉 LLM 自行判断
    assert.ok(prompt.includes('自行判断'), 'should ask LLM to auto-decide count');
  });

  it('omits the focus block when focus is undefined', () => {
    const prompt = buildSamplesPrompt({ skillContent: 's', count: 3 });
    assert.ok(!prompt.includes('额外要求'));
  });

  it('omits the focus block when focus is whitespace-only', () => {
    const prompt = buildSamplesPrompt({ skillContent: 's', count: 3, focus: '   \n  ' });
    assert.ok(!prompt.includes('额外要求'));
  });

  it('injects focus text into the prompt when provided', () => {
    const focus = '重点覆盖 PROJECT 空 → WORKSPACE 兜底的多步流程';
    const prompt = buildSamplesPrompt({ skillContent: 's', count: 5, focus });
    assert.ok(prompt.includes('额外要求'), 'should include the focus header');
    assert.ok(prompt.includes(focus), 'should include the focus body verbatim');
    // focus 须排在 count 指令之后,作为追加约束(避免 LLM 把 focus 当主指令而忽略 count)
    assert.ok(prompt.indexOf('生成 5 个评测用例') < prompt.indexOf('额外要求'));
  });

  it('trims surrounding whitespace from focus', () => {
    const prompt = buildSamplesPrompt({ skillContent: 's', count: 3, focus: '  scenario X  \n' });
    assert.ok(prompt.includes('scenario X'));
    assert.ok(!prompt.includes('  scenario X  '));
  });
});

// sanitize boundary (UltraReview Bug #1 fix)
describe('sanitizeGeneratedSamples', () => {
  it('default-stamps provenance: "llm-generated" when missing', () => {
    const samples: Sample[] = [{ sample_id: 's1', prompt: 'p' }];
    sanitizeGeneratedSamples(samples);
    assert.equal(samples[0].provenance, 'llm-generated');
  });

  it('preserves valid LLM-output provenance value', () => {
    const samples: Sample[] = [{ sample_id: 's1', prompt: 'p', provenance: 'human' }];
    sanitizeGeneratedSamples(samples);
    assert.equal(samples[0].provenance, 'human');
  });

  it('strips invalid provenance enum + auto-stamps llm-generated', () => {
    // 之前的 bug: `if (!s.provenance)` 只看 truthy, 'invalid' 会保留 → 写盘 → 下次 loadSamples reject
    const samples: Sample[] = [{ sample_id: 's1', prompt: 'p', provenance: 'invalid' as Sample['provenance'] }];
    const { stripped } = sanitizeGeneratedSamples(samples);
    assert.equal(samples[0].provenance, 'llm-generated', 'invalid provenance must be replaced');
    assert.ok(stripped.some((s) => s.includes('provenance')));
  });

  it('strips invalid difficulty enum', () => {
    const samples: Sample[] = [{ sample_id: 's1', prompt: 'p', difficulty: 'Easy' as Sample['difficulty'] }];
    const { stripped } = sanitizeGeneratedSamples(samples);
    assert.equal(samples[0].difficulty, undefined, 'invalid difficulty must be deleted');
    assert.ok(stripped.some((s) => s.includes('difficulty')));
  });

  it('strips capability when not string[]', () => {
    const samples: Sample[] = [{ sample_id: 's1', prompt: 'p', capability: 'single' as unknown as string[] }];
    const { stripped } = sanitizeGeneratedSamples(samples);
    assert.equal(samples[0].capability, undefined);
    assert.ok(stripped.some((s) => s.includes('capability')));
  });

  it('strips capability when array contains non-strings', () => {
    const samples: Sample[] = [{ sample_id: 's1', prompt: 'p', capability: ['ok', 123] as unknown as string[] }];
    sanitizeGeneratedSamples(samples);
    assert.equal(samples[0].capability, undefined);
  });

  it('preserves valid capability + difficulty + construct + provenance', () => {
    const samples: Sample[] = [{
      sample_id: 's1', prompt: 'p',
      capability: ['api-selection'], difficulty: 'medium', construct: 'capability', provenance: 'llm-generated',
    }];
    const { stripped } = sanitizeGeneratedSamples(samples);
    assert.deepEqual(samples[0].capability, ['api-selection']);
    assert.equal(samples[0].difficulty, 'medium');
    assert.equal(samples[0].construct, 'capability');
    assert.equal(stripped.length, 0);
  });

  it('default sample_id when missing', () => {
    const samples: Sample[] = [{ prompt: 'p' } as Sample];
    sanitizeGeneratedSamples(samples);
    assert.equal(samples[0].sample_id, 's001');
  });

  it('auto-sets mocksStrict=true when mocks exist but mocksStrict missing', () => {
    const samples: Sample[] = [{
      sample_id: 's1',
      prompt: 'p',
      mocks: [{ tool: 'Bash', match: { command_glob: '*foo*' }, return: 'ok' }],
    }];
    sanitizeGeneratedSamples(samples);
    assert.equal(samples[0].mocksStrict, true, 'mocksStrict should default to true when mocks present');
  });

  it('preserves explicit mocksStrict=false (escape hatch)', () => {
    const samples: Sample[] = [{
      sample_id: 's1',
      prompt: 'p',
      mocks: [{ tool: 'Bash', match: { command_glob: '*foo*' }, return: 'ok' }],
      mocksStrict: false,
    }];
    sanitizeGeneratedSamples(samples);
    assert.equal(samples[0].mocksStrict, false, 'explicit false must be preserved');
  });

  it('does not set mocksStrict when sample has no mocks', () => {
    const samples: Sample[] = [{ sample_id: 's1', prompt: 'p' }];
    sanitizeGeneratedSamples(samples);
    assert.equal(samples[0].mocksStrict, undefined);
  });

  it('preserves valid tripwire boolean', () => {
    const samples: Sample[] = [{ sample_id: 's1', prompt: 'p', tripwire: true }];
    sanitizeGeneratedSamples(samples);
    assert.equal(samples[0].tripwire, true);
  });

  it('strips non-boolean tripwire (LLM 偶尔返回 "true" 字符串)', () => {
    const samples: Sample[] = [{ sample_id: 's1', prompt: 'p', tripwire: 'true' as unknown as boolean }];
    const { stripped } = sanitizeGeneratedSamples(samples);
    assert.equal(samples[0].tripwire, undefined);
    assert.ok(stripped.some((s) => s.includes('tripwire')));
  });

  it('throws on missing prompt(required field)', () => {
    const samples: Sample[] = [{ sample_id: 's1' } as Sample];
    assert.throws(() => sanitizeGeneratedSamples(samples), /missing or invalid required prompt field/);
  });

  it('throws on non-string prompt(LLM 偶尔返回 number / null)', () => {
    const samples: Sample[] = [{ sample_id: 's1', prompt: 456 as unknown as string }];
    assert.throws(() => sanitizeGeneratedSamples(samples), /missing or invalid required prompt field.*number/);
  });

  it('default sample_id when type is non-string(LLM 返回 number)', () => {
    // Bug #2:写盘后下游 loadSamples 会 reject 整文件 — generator boundary 应规范化
    const samples: Sample[] = [{ sample_id: 123 as unknown as string, prompt: 'p' }];
    sanitizeGeneratedSamples(samples);
    assert.equal(samples[0].sample_id, 's001', 'non-string sample_id should be replaced with default');
  });

  it('default sample_id when empty string', () => {
    const samples: Sample[] = [{ sample_id: '', prompt: 'p' }];
    sanitizeGeneratedSamples(samples);
    assert.equal(samples[0].sample_id, 's001');
  });
});
