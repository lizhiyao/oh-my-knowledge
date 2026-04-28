import { describe, it, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSamples } from '../../src/inputs/load-samples.js';

const tmp = (name: string) => join(tmpdir(), `omk-test-${Date.now()}-${name}`);

describe('loadSamples', () => {
  const cleanups: string[] = [];

  afterEach(() => {
    for (const f of cleanups) {
      try { unlinkSync(f); } catch { /* ignore */ }
    }
    cleanups.length = 0;
  });

  it('加载 JSON 用例文件', () => {
    const p = tmp('samples.json');
    cleanups.push(p);
    writeFileSync(p, JSON.stringify([
      { sample_id: 's1', prompt: '你好' },
      { sample_id: 's2', prompt: '世界' },
    ]));
    const { samples } = loadSamples(p);
    assert.equal(samples.length, 2);
    assert.equal(samples[0].sample_id, 's1');
    assert.equal(samples[1].prompt, '世界');
  });

  it('加载 YAML 用例文件', () => {
    const p = tmp('samples.yaml');
    cleanups.push(p);
    writeFileSync(p, `- sample_id: y1\n  prompt: hello\n- sample_id: y2\n  prompt: world\n`);
    const { samples } = loadSamples(p);
    assert.equal(samples.length, 2);
    assert.equal(samples[0].sample_id, 'y1');
    assert.equal(samples[1].prompt, 'world');
  });

  it('空文件抛出异常', () => {
    const p = tmp('empty.json');
    cleanups.push(p);
    writeFileSync(p, '[]');
    assert.throws(() => loadSamples(p), /invalid samples file/);
  });

  it('无效内容抛出异常', () => {
    const p = tmp('invalid.json');
    cleanups.push(p);
    writeFileSync(p, '"not an array"');
    assert.throws(() => loadSamples(p), /invalid samples file/);
  });

  it('缺少 sample_id 抛出异常', () => {
    const p = tmp('no-id.json');
    cleanups.push(p);
    writeFileSync(p, JSON.stringify([{ prompt: 'hello' }]));
    assert.throws(() => loadSamples(p), /required field: sample_id/);
  });

  it('缺少 prompt 抛出异常', () => {
    const p = tmp('no-prompt.json');
    cleanups.push(p);
    writeFileSync(p, JSON.stringify([{ sample_id: 'x' }]));
    assert.throws(() => loadSamples(p), /required field: prompt/);
  });

  // v0.22 — UltraReview follow-up #6: typeof check for prompt
  it('prompt 非字符串(数字)抛出异常', () => {
    const p = tmp('bad-prompt-type.json');
    cleanups.push(p);
    writeFileSync(p, JSON.stringify([{ sample_id: 'x', prompt: 123 }]));
    assert.throws(() => loadSamples(p), /invalid required field: prompt/);
  });

  // v0.22 — sample design metadata fields validation
  describe('sample design metadata (v0.22)', () => {
    it('接受 capability / difficulty / construct / provenance 4 个新字段', () => {
      const p = tmp('with-meta.json');
      cleanups.push(p);
      writeFileSync(p, JSON.stringify([{
        sample_id: 's1',
        prompt: 'p',
        capability: ['api-selection', 'error-diagnosis'],
        difficulty: 'medium',
        construct: 'necessity',
        provenance: 'human',
      }]));
      const { samples } = loadSamples(p);
      assert.deepEqual(samples[0].capability, ['api-selection', 'error-diagnosis']);
      assert.equal(samples[0].difficulty, 'medium');
      assert.equal(samples[0].construct, 'necessity');
      assert.equal(samples[0].provenance, 'human');
    });

    it('老 sample(无新字段)仍正常解析', () => {
      const p = tmp('legacy.json');
      cleanups.push(p);
      writeFileSync(p, JSON.stringify([{ sample_id: 's1', prompt: 'p' }]));
      const { samples } = loadSamples(p);
      assert.equal(samples[0].capability, undefined);
      assert.equal(samples[0].difficulty, undefined);
      assert.equal(samples[0].construct, undefined);
      assert.equal(samples[0].provenance, undefined);
    });

    it('difficulty 非法值 reject 含 sample_id 定位', () => {
      const p = tmp('bad-difficulty.json');
      cleanups.push(p);
      writeFileSync(p, JSON.stringify([{ sample_id: 's7', prompt: 'p', difficulty: 'easy?' }]));
      assert.throws(() => loadSamples(p), /s7.*invalid difficulty.*easy\?.*easy, medium, hard/);
    });

    it('provenance 非法值 reject', () => {
      const p = tmp('bad-prov.json');
      cleanups.push(p);
      writeFileSync(p, JSON.stringify([{ sample_id: 's1', prompt: 'p', provenance: 'random' }]));
      assert.throws(() => loadSamples(p), /invalid provenance/);
    });

    it('capability 必须是 array(reject single string)', () => {
      const p = tmp('bad-cap.json');
      cleanups.push(p);
      writeFileSync(p, JSON.stringify([{ sample_id: 's1', prompt: 'p', capability: 'api-selection' }]));
      assert.throws(() => loadSamples(p), /invalid capability.*string array/);
    });

    it('capability 数组里非字符串 reject', () => {
      const p = tmp('bad-cap-elem.json');
      cleanups.push(p);
      writeFileSync(p, JSON.stringify([{ sample_id: 's1', prompt: 'p', capability: ['ok', 123] }]));
      assert.throws(() => loadSamples(p), /capability\[1\] must be a non-empty string/);
    });

    it('construct 接受任意 string(允许自定义值)', () => {
      const p = tmp('custom-construct.json');
      cleanups.push(p);
      writeFileSync(p, JSON.stringify([{ sample_id: 's1', prompt: 'p', construct: 'my-custom-thing' }]));
      const { samples } = loadSamples(p);
      assert.equal(samples[0].construct, 'my-custom-thing');
    });
  });
});
