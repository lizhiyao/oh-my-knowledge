import { describe, it, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSamples } from '../../src/inputs/load-samples.js';

const tmp = (name: string) => join(tmpdir(), `omk-test-${Date.now()}-${name}`);

describe('loadSamples', () => {
  it.each(['json', 'yaml'])('rejects duplicate sample_id in a single %s file', (format) => {
    const samples = [
      { sample_id: 'shared', prompt: 'first' },
      { sample_id: 'shared', prompt: 'second' },
    ];
    const file = writeSampleFile(
      `duplicate.${format}`,
      format === 'json'
        ? JSON.stringify(samples)
        : '- sample_id: shared\n  prompt: first\n- sample_id: shared\n  prompt: second\n',
    );
    assert.throws(
      () => loadSamples(file),
      /duplicate sample_id "shared" at samples\[1\] \(first defined at samples\[0\]\)/,
    );
  });

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

  describe('execution contract', () => {
    const invalidContractCases = [
      {
        name: 'dimensions must contain non-empty rubric text',
        sample: { dimensions: { quality: '' } },
        error: /dimensions.*non-empty string rubrics/,
      },
      {
        name: 'unknown assertion type',
        sample: { assertions: [{ type: 'containz', value: 'token' }] },
        error: /unsupported assertion type.*containz/,
      },
      {
        name: 'zero-weight assertion',
        sample: { assertions: [{ type: 'contains', value: 'token', weight: 0 }] },
        error: /weight.*positive finite number/,
      },
      {
        name: 'invalid regex is rejected before grading',
        sample: { assertions: [{ type: 'regex', pattern: '[', flags: 'i' }] },
        error: /regex.*invalid pattern or flags/,
      },
      {
        name: 'async assertion nested in sync assert-set',
        sample: {
          assertions: [{
            type: 'assert-set',
            children: [{ type: 'semantic_similarity', reference: 'answer' }],
          }],
        },
        error: /async assertion type.*semantic_similarity.*cannot be nested/,
      },
      {
        name: 'mock match typo cannot broaden interception',
        sample: {
          mocks: [{
            tool: 'Bash',
            match: { command_globb: 'git *' },
            return: 'ok',
          }],
        },
        error: /match.*unsupported field/,
      },
      {
        name: 'mock must define a return',
        sample: { mocks: [{ tool: 'Bash' }] },
        error: /mock requires.*return/,
      },
      {
        name: 'environment rejects unknown fields',
        sample: { environment: { cli_available: ['git'], typo: true } },
        error: /environment.*invalid shape/,
      },
      {
        name: 'allowedTools must be a string array',
        sample: { allowedTools: ['Read', 1] },
        error: /allowedTools.*array of non-empty strings/,
      },
      {
        name: 'mocksStrict must be boolean',
        sample: { mocksStrict: 'true' },
        error: /mocksStrict.*boolean/,
      },
    ];

    it.each(invalidContractCases)('rejects invalid execution contract: $name', ({ name, sample, error }) => {
      const p = writeJsonSamples(`bad-contract-${name}.json`, [{
        sample_id: 's1',
        prompt: 'p',
        ...sample,
      }]);
      assert.throws(() => loadSamples(p), error);
    });

    const invalidRequiresCases = [
      { name: 'null', requires: null, error: /requires.*must be an object/ },
      { name: 'unknown field', requires: { tool: ['git'] }, error: /requires.*unsupported field/ },
      { name: 'non-string item', requires: { tools: ['git', 1] }, error: /requires\.tools.*non-empty strings/ },
    ];

    it.each(invalidRequiresCases)('rejects invalid requires: $name', ({ name, requires, error }) => {
      const p = writeJsonSamples(`bad-requires-${name}.json`, {
        requires,
        samples: [{ sample_id: 's1', prompt: 'p' }],
      });
      assert.throws(() => loadSamples(p), error);
    });
  });

  // sample design metadata fields validation
  describe('sample design metadata', () => {
    it('接受 capability / difficulty / construct / provenance / covers 字段', () => {
      const p = writeJsonSamples('with-meta.json', [{
        sample_id: 's1',
        prompt: 'p',
        capability: ['api-selection', 'error-diagnosis'],
        difficulty: 'medium',
        construct: 'necessity',
        provenance: 'human',
        covers: [
          { targetKind: 'reference', ref: 'references/release.md' },
          { targetKind: 'workflow_node', ref: 'release.check' },
        ],
      }]);
      const { samples } = loadSamples(p);
      assert.deepEqual(samples[0].capability, ['api-selection', 'error-diagnosis']);
      assert.equal(samples[0].difficulty, 'medium');
      assert.equal(samples[0].construct, 'necessity');
      assert.equal(samples[0].provenance, 'human');
      assert.deepEqual(samples[0].covers, [
        { targetKind: 'reference', ref: 'references/release.md' },
        { targetKind: 'workflow_node', ref: 'release.check' },
      ]);
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
      {
        name: 'covers is not array',
        file: 'bad-covers.json',
        value: [{ sample_id: 's1', prompt: 'p', covers: 'references/a.md' }],
        error: /invalid covers.*array/,
      },
      {
        name: 'covers targetKind invalid',
        file: 'bad-covers-kind.json',
        value: [{ sample_id: 's1', prompt: 'p', covers: [{ targetKind: 'file', ref: 'references/a.md' }] }],
        error: /covers\[0\] invalid targetKind/,
      },
      {
        name: 'covers ref empty',
        file: 'bad-covers-ref.json',
        value: [{ sample_id: 's1', prompt: 'p', covers: [{ targetKind: 'reference', ref: '' }] }],
        error: /covers\[0\] invalid ref/,
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

    it('maps prototype-shaped sample ids to their own source files', () => {
      const d = makeDir('prototype-ids');
      const protoPath = join(d, 'a.json');
      const constructorPath = join(d, 'b.json');
      writeFileSync(
        protoPath,
        JSON.stringify([{ sample_id: '__proto__', prompt: 'one' }]),
      );
      writeFileSync(
        constructorPath,
        JSON.stringify([{ sample_id: 'constructor', prompt: 'two' }]),
      );

      const loaded = loadSamples(d);
      assert.equal(Object.hasOwn(loaded.sampleSourceById, '__proto__'), true);
      assert.equal(loaded.sampleSourceById.__proto__, protoPath);
      assert.equal(Object.hasOwn(loaded.sampleSourceById, 'constructor'), true);
      assert.equal(loaded.sampleSourceById.constructor, constructorPath);
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

    // P2-1 source-aware:目录模式下 baseDir = 目录自身,sourceFiles 列所有合并的文件
    it('directory mode: baseDir 等于目录自身;sourceFiles 含所有合并文件(已排序)', () => {
      const d = makeDir('source-aware');
      writeFileSync(join(d, 'b.json'), JSON.stringify([{ sample_id: 's1', prompt: 'a' }]));
      writeFileSync(join(d, 'a.json'), JSON.stringify([{ sample_id: 's2', prompt: 'b' }]));
      const { baseDir, sourceFiles } = loadSamples(d);
      assert.equal(baseDir, d);
      assert.equal(sourceFiles.length, 2);
      // 排序后:a.json 在前,b.json 在后
      assert.ok(sourceFiles[0].endsWith('a.json'));
      assert.ok(sourceFiles[1].endsWith('b.json'));
    });

    it('single-file mode: baseDir 等于 dirname(file);sourceFiles = [file]', () => {
      const d = makeDir('singlefile');
      const f = join(d, 'samples.json');
      writeFileSync(f, JSON.stringify([{ sample_id: 's1', prompt: 'a' }]));
      const { baseDir, sourceFiles } = loadSamples(f);
      assert.equal(baseDir, d);
      assert.deepEqual(sourceFiles, [f]);
    });
  });
});
