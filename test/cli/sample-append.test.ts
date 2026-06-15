import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { mergeAppendSamples, appendSamplesToFile } from '../../src/cli/commands/sample.js';
import type { Sample } from '../../src/types/eval.js';

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

  it('纯数组 json:追加并撞 id 去重,仍是数组', () => {
    const f = join(dir, 'eval-samples.json');
    writeFileSync(f, JSON.stringify([s('s001'), s('s002')], null, 2));
    const total = appendSamplesToFile(f, [s('s001'), s('s003')]);
    assert.equal(total, 4);
    const parsed = JSON.parse(readFileSync(f, 'utf-8'));
    assert.ok(Array.isArray(parsed));
    assert.deepEqual(parsed.map((x: Sample) => x.sample_id), ['s001', 's002', 's001-2', 's003']);
  });

  it('wrapper object:保留 samples 外的其它顶层字段', () => {
    const f = join(dir, 'eval-samples.json');
    writeFileSync(f, JSON.stringify({ version: 2, note: 'keep me', samples: [s('s001')] }, null, 2));
    appendSamplesToFile(f, [s('s002')]);
    const parsed = JSON.parse(readFileSync(f, 'utf-8'));
    assert.equal(parsed.version, 2);
    assert.equal(parsed.note, 'keep me');
    assert.deepEqual(parsed.samples.map((x: Sample) => x.sample_id), ['s001', 's002']);
  });

  it('yaml 文件:round-trip 保留 yaml 格式', () => {
    const f = join(dir, 'eval-samples.yaml');
    writeFileSync(f, yaml.dump([s('s001')]));
    appendSamplesToFile(f, [s('s002')]);
    const parsed = yaml.load(readFileSync(f, 'utf-8')) as Sample[];
    assert.ok(Array.isArray(parsed));
    assert.deepEqual(parsed.map((x) => x.sample_id), ['s001', 's002']);
  });
});
