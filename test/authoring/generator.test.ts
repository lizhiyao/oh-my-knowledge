import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { generateSamples, sanitizeGeneratedSamples } from '../../src/authoring/generator.js';
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

// v0.22 — sanitize boundary (UltraReview Bug #1 fix)
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

  it('throws on missing prompt(required field)', () => {
    const samples: Sample[] = [{ sample_id: 's1' } as Sample];
    assert.throws(() => sanitizeGeneratedSamples(samples), /missing required prompt field/);
  });
});
