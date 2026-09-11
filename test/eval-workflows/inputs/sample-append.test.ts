import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync, lstatSync, readlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { mergeAppendSamples, appendSamplesToFile, preflightSampleAppend } from '../../../src/eval-workflows/inputs/append-samples.js';
import type { Sample } from '../../../src/eval-workflows/inputs/contracts/sample.js';
import { createEvalSampleSetDocument } from '../../../src/eval-workflows/inputs/schemas/sample-set.js';

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

  it.each(['{broken', '{}', '{"schemaVersion":"omk.eval-sample-set/v2","samples":[{}]}'])('预检拒绝损坏或非法文档：%s', (raw) => {
    const file = join(dir, 'eval-samples.json');
    writeFileSync(file, raw);
    assert.throws(() => preflightSampleAppend(file));
    assert.equal(readFileSync(file, 'utf8'), raw);
  });

  it('生成期间文件被修改时保留外部改动', () => {
    const file = join(dir, 'eval-samples.json');
    writeFileSync(file, JSON.stringify(createEvalSampleSetDocument([s('original')])));
    const snapshot = preflightSampleAppend(file);
    const edited = JSON.stringify(createEvalSampleSetDocument([s('external')]));
    writeFileSync(file, edited);
    assert.throws(() => appendSamplesToFile(file, [s('generated')], undefined, snapshot), /changed during generation/);
    assert.equal(readFileSync(file, 'utf8'), edited);
  });

  it.each(['json', 'yaml'])('通过 %s 软链追加共享样本，保留链接和格式', (extension) => {
    const target = join(dir, 'shared.data');
    const file = join(dir, `eval-samples.${extension}`);
    const document = createEvalSampleSetDocument([s('original')]);
    writeFileSync(target, extension === 'json' ? JSON.stringify(document) : yaml.dump(document));
    symlinkSync('shared.data', file);
    const snapshot = preflightSampleAppend(file);
    assert.equal(appendSamplesToFile(file, [s('generated')], undefined, snapshot), 2);
    assert.ok(lstatSync(file).isSymbolicLink());
    assert.equal(readlinkSync(file), 'shared.data');
    const raw = readFileSync(target, 'utf8');
    const parsed = (extension === 'json' ? JSON.parse(raw) : yaml.load(raw)) as { samples: Sample[] };
    assert.deepEqual(ids(parsed.samples), ['original', 'generated']);
    assert.deepEqual(readdirSync(dir).sort(), [`eval-samples.${extension}`, 'shared.data']);
  });

  it('不同软链共享目标时，拒绝覆盖另一个入口已追加的内容', () => {
    const target = join(dir, 'shared.json');
    const first = join(dir, 'eval-samples.json');
    const second = join(dir, 'alias.json');
    writeFileSync(target, JSON.stringify(createEvalSampleSetDocument([s('original')])));
    symlinkSync(target, first);
    symlinkSync(target, second);
    const snapshot = preflightSampleAppend(first);
    appendSamplesToFile(second, [s('external')]);
    assert.throws(() => appendSamplesToFile(first, [s('generated')], undefined, snapshot), /changed during generation/);
    assert.deepEqual(ids(JSON.parse(readFileSync(target, 'utf8')).samples), ['original', 'external']);
    assert.ok(lstatSync(first).isSymbolicLink());
    assert.ok(lstatSync(second).isSymbolicLink());
  });

  it('生成期间软链重定向到相同内容的新目标也拒绝追加', () => {
    const original = join(dir, 'original.json');
    const replacement = join(dir, 'replacement.json');
    const file = join(dir, 'eval-samples.json');
    const content = JSON.stringify(createEvalSampleSetDocument([s('original')]));
    writeFileSync(original, content);
    writeFileSync(replacement, content);
    symlinkSync(original, file);
    const snapshot = preflightSampleAppend(file);
    rmSync(file);
    symlinkSync(replacement, file);
    assert.throws(() => appendSamplesToFile(file, [s('generated')], undefined, snapshot), /target changed during generation/);
    assert.equal(readFileSync(original, 'utf8'), content);
    assert.equal(readFileSync(replacement, 'utf8'), content);
    assert.equal(readlinkSync(file), replacement);
    assert.deepEqual(readdirSync(dir).sort(), ['eval-samples.json', 'original.json', 'replacement.json']);
  });

  it('版本化 JSON：追加并撞 id 去重，保留协议包装', () => {
    const f = join(dir, 'eval-samples.json');
    writeFileSync(f, JSON.stringify(createEvalSampleSetDocument([s('s001'), s('s002')]), null, 2));
    const total = appendSamplesToFile(f, [s('s001'), s('s003')]);
    assert.equal(total, 4);
    const parsed = JSON.parse(readFileSync(f, 'utf-8'));
    assert.equal(parsed.schemaVersion, 'omk.eval-sample-set/v2');
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
    assert.equal(parsed.schemaVersion, 'omk.eval-sample-set/v2');
    assert.deepEqual(parsed.samples.map((x) => x.sample_id), ['s001', 's002']);
  });
});

