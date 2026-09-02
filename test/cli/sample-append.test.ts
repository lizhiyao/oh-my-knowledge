import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { mergeAppendSamples, appendSamplesToFile, pickAppendTargetFile } from '../../src/cli/commands/sample.js';
import type { Sample } from '../../src/inputs/contracts/sample.js';
import { createEvalSampleSetDocument } from '../../src/inputs/schemas/sample-set.js';
import { SampleFileAmbiguityError } from '../../src/inputs/sample-locator.js';

const s = (id: string, prompt = 'p'): Sample => ({ sample_id: id, prompt }) as Sample;
const ids = (arr: Sample[]): string[] => arr.map((x) => x.sample_id);

describe('mergeAppendSamples (--append 合并 + id 去重)', () => {
  it('无冲突:已有 + 新用例顺序拼接,id 不变', () => {
    const merged = mergeAppendSamples([s('a'), s('b')], [s('c'), s('d')]);
    assert.deepEqual(ids(merged), ['a', 'b', 'c', 'd']);
  });

  it('撞 id:已有原样保留,新用例改名加 -2 后缀', () => {
    const merged = mergeAppendSamples([s('s001'), s('s002')], [s('s001'), s('s003')]);
    assert.deepEqual(ids(merged), ['s001', 's002', 's001-2', 's003']);
  });

  it('同批多条撞同一 id:依次 -2 / -3', () => {
    const merged = mergeAppendSamples([s('s001')], [s('s001'), s('s001')]);
    assert.deepEqual(ids(merged), ['s001', 's001-2', 's001-3']);
  });

  it('已有已含 -2 后缀:新用例跳到 -3,不二次相撞', () => {
    const merged = mergeAppendSamples([s('s001'), s('s001-2')], [s('s001')]);
    assert.deepEqual(ids(merged), ['s001', 's001-2', 's001-3']);
  });

  it('改名时保留其它字段,只换 sample_id', () => {
    const merged = mergeAppendSamples([s('x', 'old')], [s('x', 'new-prompt')]);
    assert.equal(merged.length, 2);
    assert.equal(merged[1].sample_id, 'x-2');
    assert.equal(merged[1].prompt, 'new-prompt');
  });

  it('已有为空:新用例原样返回', () => {
    const merged = mergeAppendSamples([], [s('a'), s('b')]);
    assert.deepEqual(ids(merged), ['a', 'b']);
  });

  it('reserved 集:新用例也避开跨文件保留的 id', () => {
    const merged = mergeAppendSamples([s('a')], [s('b'), s('c')], new Set(['b', 'c']));
    // a 原样;b/c 撞 reserved → b-2 / c-2
    assert.deepEqual(ids(merged), ['a', 'b-2', 'c-2']);
  });
});

describe('appendSamplesToFile (读+合并+格式保留写回)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'omk-append-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('版本化 JSON：追加并撞 id 去重，保留协议包装', () => {
    const f = join(dir, 'eval-samples.json');
    writeFileSync(f, JSON.stringify(createEvalSampleSetDocument([s('s001'), s('s002')]), null, 2));
    const total = appendSamplesToFile(f, [s('s001'), s('s003')]);
    assert.equal(total, 4);
    const parsed = JSON.parse(readFileSync(f, 'utf-8'));
    assert.equal(parsed.schemaVersion, 'omk.eval-sample-set/v1');
    assert.deepEqual(parsed.samples.map((x: Sample) => x.sample_id), ['s001', 's002', 's001-2', 's003']);
  });

  it('版本化 JSON：保留 requires', () => {
    const f = join(dir, 'eval-samples.json');
    writeFileSync(f, JSON.stringify(createEvalSampleSetDocument(
      [s('s001')],
      { tools: ['git'] },
    ), null, 2));
    appendSamplesToFile(f, [s('s002')]);
    const parsed = JSON.parse(readFileSync(f, 'utf-8'));
    assert.deepEqual(parsed.requires, { tools: ['git'] });
    assert.deepEqual(parsed.samples.map((x: Sample) => x.sample_id), ['s001', 's002']);
  });

  it('YAML 文件：round-trip 保留 YAML 与版本化包装', () => {
    const f = join(dir, 'eval-samples.yaml');
    writeFileSync(f, yaml.dump(createEvalSampleSetDocument([s('s001')])));
    appendSamplesToFile(f, [s('s002')]);
    const parsed = yaml.load(readFileSync(f, 'utf-8')) as {
      schemaVersion: string;
      samples: Sample[];
    };
    assert.equal(parsed.schemaVersion, 'omk.eval-sample-set/v1');
    assert.deepEqual(parsed.samples.map((x) => x.sample_id), ['s001', 's002']);
  });
});

describe('pickAppendTargetFile (目录模式选写回目标,确定性)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'omk-pick-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('空目录 → null', () => {
    assert.equal(pickAppendTargetFile(dir), null);
  });

  it('非 canonical 自定义文件不参与自动选取', () => {
    writeFileSync(join(dir, 'cases.json'), '[]');
    assert.equal(pickAppendTargetFile(dir), null);
  });

  it('canonical JSON → 选中该文件', () => {
    writeFileSync(join(dir, 'eval-samples.json'), '[]');
    assert.equal(pickAppendTargetFile(dir), join(dir, 'eval-samples.json'));
  });

  it('canonical YAML → 选中该文件', () => {
    writeFileSync(join(dir, 'eval-samples.yaml'), '[]');
    assert.equal(pickAppendTargetFile(dir), join(dir, 'eval-samples.yaml'));
  });

  it('canonical JSON 与 YAML 并存 → 拒绝静默选择', () => {
    writeFileSync(join(dir, 'eval-samples.json'), '[]');
    writeFileSync(join(dir, 'eval-samples.yaml'), '[]');
    assert.throws(() => pickAppendTargetFile(dir), SampleFileAmbiguityError);
  });
});
