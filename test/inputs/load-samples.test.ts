import { describe, it, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync, mkdirSync, rmSync } from 'node:fs';
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

  const invalidShapeCases = [
    { name: 'empty array', file: 'empty.json', value: [], error: /invalid samples file/ },
    { name: 'non-array content', file: 'invalid.json', value: 'not an array', error: /invalid samples file/ },
    { name: 'missing sample_id', file: 'no-id.json', value: [{ prompt: 'hello' }], error: /required field: sample_id/ },
    { name: 'missing prompt', file: 'no-prompt.json', value: [{ sample_id: 'x' }], error: /required field: prompt/ },
    { name: 'non-string prompt', file: 'bad-prompt-type.json', value: [{ sample_id: 'x', prompt: 123 }], error: /invalid required field: prompt/ },
  ];

  it.each(invalidShapeCases)('rejects invalid sample file shape: $name', ({ file, value, error }) => {
    const p = writeJsonSamples(file, value);
    assert.throws(() => loadSamples(p), error);
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

    const invalidMetadataCases = [
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

    it.each(invalidMetadataCases)('rejects invalid sample design metadata: $name', ({ file, value, error }) => {
      const p = writeJsonSamples(file, value);
      assert.throws(() => loadSamples(p), error);
    });

    it('construct 接受任意 string(允许自定义值)', () => {
      const p = writeJsonSamples('custom-construct.json', [{ sample_id: 's1', prompt: 'p', construct: 'my-custom-thing' }]);
      const { samples } = loadSamples(p);
      assert.equal(samples[0].construct, 'my-custom-thing');
    });
  });

  // Directory mode (`.omk/` 多文件 bundle):loadSamples 接收目录路径时,
  // glob 当中的 *.json/*.yaml,排除 report*/health*/_*,合并 samples,sample_id 跨文件去重。
  describe('directory mode (.omk/ bundle)', () => {
    const dirCleanups: string[] = [];
    function makeDir(name: string): string {
      const d = join(tmpdir(), `omk-test-dir-${Date.now()}-${Math.random().toString(36).slice(2,8)}-${name}`);
      mkdirSync(d, { recursive: true });
      dirCleanups.push(d);
      return d;
    }
    afterEach(() => {
      for (const d of dirCleanups) {
        try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
      }
      dirCleanups.length = 0;
    });

    it('merges samples from multiple json files in deterministic name-sorted order', () => {
      const d = makeDir('multi');
      writeFileSync(join(d, 'workflow.json'), JSON.stringify([{ sample_id: 's001', prompt: 'a' }]));
      writeFileSync(join(d, 'platform.json'), JSON.stringify([{ sample_id: 's002', prompt: 'b' }]));
      writeFileSync(join(d, 'ironlaw.json'),  JSON.stringify([{ sample_id: 's003', prompt: 'c' }]));
      const { samples } = loadSamples(d);
      // sorted: ironlaw < platform < workflow
      assert.deepEqual(samples.map((s) => s.sample_id), ['s003', 's002', 's001']);
    });

    it('skips reserved file prefixes (report*, health*, _*)', () => {
      const d = makeDir('reserved');
      writeFileSync(join(d, 'samples.json'),       JSON.stringify([{ sample_id: 's1', prompt: 'a' }]));
      writeFileSync(join(d, 'report-2026.json'),    JSON.stringify([{ sample_id: 'should-skip-1', prompt: 'x' }]));
      writeFileSync(join(d, 'health.json'),         JSON.stringify([{ sample_id: 'should-skip-2', prompt: 'x' }]));
      writeFileSync(join(d, '_scratch.json'),       JSON.stringify([{ sample_id: 'should-skip-3', prompt: 'x' }]));
      const { samples } = loadSamples(d);
      assert.deepEqual(samples.map((s) => s.sample_id), ['s1']);
    });

    it('rejects duplicate sample_id across files', () => {
      const d = makeDir('dup');
      writeFileSync(join(d, 'a.json'), JSON.stringify([{ sample_id: 'shared', prompt: 'one' }]));
      writeFileSync(join(d, 'b.json'), JSON.stringify([{ sample_id: 'shared', prompt: 'two' }]));
      assert.throws(() => loadSamples(d), /duplicate sample_id "shared"/);
    });

    it('errors when directory has no eligible sample files', () => {
      const d = makeDir('empty');
      writeFileSync(join(d, 'report.json'), JSON.stringify([{ sample_id: 's1', prompt: 'p' }]));
      assert.throws(() => loadSamples(d), /no sample files found in directory/);
    });

    it('unions requires from object-wrapper format across files', () => {
      const d = makeDir('requires-merge');
      writeFileSync(join(d, 'a.json'), JSON.stringify({
        requires: { tools: ['integration-tool'], env: ['FOO'] },
        samples: [{ sample_id: 's1', prompt: 'a' }],
      }));
      writeFileSync(join(d, 'b.json'), JSON.stringify({
        requires: { tools: ['integration-tool', 'git'], files: ['x.txt'] },
        samples: [{ sample_id: 's2', prompt: 'b' }],
      }));
      const { requires } = loadSamples(d);
      assert.deepEqual(new Set(requires?.tools), new Set(['integration-tool', 'git']));
      assert.deepEqual(requires?.env, ['FOO']);
      assert.deepEqual(requires?.files, ['x.txt']);
    });
  });
});
