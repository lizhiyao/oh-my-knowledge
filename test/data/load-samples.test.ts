import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSamples } from '../../lib/data-loaders/load-samples.js';

const tmp = (name: string) => join(tmpdir(), `omk-test-${Date.now()}-${name}`);

describe('loadSamples', () => {
  const cleanups: string[] = [];

  afterEach(() => {
    for (const f of cleanups) {
      try { unlinkSync(f); } catch { /* ignore */ }
    }
    cleanups.length = 0;
  });

  it('加载 JSON 样本文件', () => {
    const p = tmp('samples.json');
    cleanups.push(p);
    writeFileSync(p, JSON.stringify([
      { sample_id: 's1', prompt: '你好' },
      { sample_id: 's2', prompt: '世界' },
    ]));
    const samples = loadSamples(p);
    assert.equal(samples.length, 2);
    assert.equal(samples[0].sample_id, 's1');
    assert.equal(samples[1].prompt, '世界');
  });

  it('加载 YAML 样本文件', () => {
    const p = tmp('samples.yaml');
    cleanups.push(p);
    writeFileSync(p, `- sample_id: y1\n  prompt: hello\n- sample_id: y2\n  prompt: world\n`);
    const samples = loadSamples(p);
    assert.equal(samples.length, 2);
    assert.equal(samples[0].sample_id, 'y1');
    assert.equal(samples[1].prompt, 'world');
  });

  it('空文件抛出异常', () => {
    const p = tmp('empty.json');
    cleanups.push(p);
    writeFileSync(p, '[]');
    assert.throws(() => loadSamples(p), /无效的样本文件/);
  });

  it('无效内容抛出异常', () => {
    const p = tmp('invalid.json');
    cleanups.push(p);
    writeFileSync(p, '"not an array"');
    assert.throws(() => loadSamples(p), /无效的样本文件/);
  });

  it('缺少 sample_id 抛出异常', () => {
    const p = tmp('no-id.json');
    cleanups.push(p);
    writeFileSync(p, JSON.stringify([{ prompt: 'hello' }]));
    assert.throws(() => loadSamples(p), /缺少必填字段: sample_id/);
  });

  it('缺少 prompt 抛出异常', () => {
    const p = tmp('no-prompt.json');
    cleanups.push(p);
    writeFileSync(p, JSON.stringify([{ sample_id: 'x' }]));
    assert.throws(() => loadSamples(p), /缺少必填字段: prompt/);
  });
});
