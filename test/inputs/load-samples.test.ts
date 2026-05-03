import { describe, it, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSamples } from '../../src/inputs/load-samples.js';

const tmp = (name: string) => join(tmpdir(), `omk-test-${Date.now()}-${name}`);

describe('loadSamples', () => {
  const cleanups: string[] = [];

  function writeSampleFile(name: string, content: string): string {
    const p = tmp(name);
    cleanups.push(p);
    writeFileSync(p, content);
    return p;
  }

  function writeJsonSamples(name: string, value: unknown): string {
    return writeSampleFile(name, JSON.stringify(value));
  }

  afterEach(() => {
    for (const f of cleanups) {
      try { unlinkSync(f); } catch { /* ignore */ }
    }
    cleanups.length = 0;
  });

  it('加载 JSON 用例文件', () => {
    const p = writeJsonSamples('samples.json', [
      { sample_id: 's1', prompt: '你好' },
      { sample_id: 's2', prompt: '世界' },
    ]);
    const { samples } = loadSamples(p);
    assert.equal(samples.length, 2);
    assert.equal(samples[0].sample_id, 's1');
    assert.equal(samples[1].prompt, '世界');
  });

  it('加载 YAML 用例文件', () => {
    const p = writeSampleFile('samples.yaml', `- sample_id: y1\n  prompt: hello\n- sample_id: y2\n  prompt: world\n`);
    const { samples } = loadSamples(p);
    assert.equal(samples.length, 2);
    assert.equal(samples[0].sample_id, 'y1');
    assert.equal(samples[1].prompt, 'world');
  });

  it('rejects invalid sample file shapes', () => {
    const cases = [
      { name: 'empty array', file: 'empty.json', value: [], error: /invalid samples file/ },
      { name: 'non-array content', file: 'invalid.json', value: 'not an array', error: /invalid samples file/ },
      { name: 'missing sample_id', file: 'no-id.json', value: [{ prompt: 'hello' }], error: /required field: sample_id/ },
      { name: 'missing prompt', file: 'no-prompt.json', value: [{ sample_id: 'x' }], error: /required field: prompt/ },
      { name: 'non-string prompt', file: 'bad-prompt-type.json', value: [{ sample_id: 'x', prompt: 123 }], error: /invalid required field: prompt/ },
    ];

    for (const testCase of cases) {
      const p = writeJsonSamples(testCase.file, testCase.value);
      assert.throws(() => loadSamples(p), testCase.error, testCase.name);
    }
  });

  // sample design metadata fields validation
  describe('sample design metadata', () => {
    it('接受 capability / difficulty / construct / provenance 4 个新字段', () => {
      const p = writeJsonSamples('with-meta.json', [{
        sample_id: 's1',
        prompt: 'p',
        capability: ['api-selection', 'error-diagnosis'],
        difficulty: 'medium',
        construct: 'necessity',
        provenance: 'human',
      }]);
      const { samples } = loadSamples(p);
      assert.deepEqual(samples[0].capability, ['api-selection', 'error-diagnosis']);
      assert.equal(samples[0].difficulty, 'medium');
      assert.equal(samples[0].construct, 'necessity');
      assert.equal(samples[0].provenance, 'human');
    });

    it('老 sample(无新字段)仍正常解析', () => {
      const p = writeJsonSamples('legacy.json', [{ sample_id: 's1', prompt: 'p' }]);
      const { samples } = loadSamples(p);
      assert.equal(samples[0].capability, undefined);
      assert.equal(samples[0].difficulty, undefined);
      assert.equal(samples[0].construct, undefined);
      assert.equal(samples[0].provenance, undefined);
    });

    it('rejects invalid sample design metadata', () => {
      const cases = [
        {
          name: 'difficulty invalid value includes sample_id',
          file: 'bad-difficulty.json',
          value: [{ sample_id: 's7', prompt: 'p', difficulty: 'easy?' }],
          error: /s7.*invalid difficulty.*easy\?.*easy, medium, hard/,
        },
        {
          name: 'provenance invalid value',
          file: 'bad-prov.json',
          value: [{ sample_id: 's1', prompt: 'p', provenance: 'random' }],
          error: /invalid provenance/,
        },
        {
          name: 'capability single string',
          file: 'bad-cap.json',
          value: [{ sample_id: 's1', prompt: 'p', capability: 'api-selection' }],
          error: /invalid capability.*string array/,
        },
        {
          name: 'capability array contains non-string',
          file: 'bad-cap-elem.json',
          value: [{ sample_id: 's1', prompt: 'p', capability: ['ok', 123] }],
          error: /capability\[1\] must be a non-empty string/,
        },
      ];

      for (const testCase of cases) {
        const p = writeJsonSamples(testCase.file, testCase.value);
        assert.throws(() => loadSamples(p), testCase.error, testCase.name);
      }
    });

    it('construct 接受任意 string(允许自定义值)', () => {
      const p = writeJsonSamples('custom-construct.json', [{ sample_id: 's1', prompt: 'p', construct: 'my-custom-thing' }]);
      const { samples } = loadSamples(p);
      assert.equal(samples[0].construct, 'my-custom-thing');
    });
  });
});
