import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sampleSourceExists, resolveSampleOutFile } from '../../src/cli/commands/evolve.js';

// sampleSourceExists 是 evolve 自动生成的「损坏文件不覆盖」守卫核心:
// 区分「用例源已存在(存在但解析失败 → 报错不覆盖)」与「确实没有用例(可生成)」。
describe('sampleSourceExists', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'omk-sse-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('文件不存在 → false(可生成)', () => {
    assert.equal(sampleSourceExists(join(dir, 'eval-samples.json')), false);
  });

  it('文件存在(带后缀)→ true(即便内容损坏,也判定为源已存在)', () => {
    const f = join(dir, 'eval-samples.json');
    writeFileSync(f, '{ broken json');
    assert.equal(sampleSourceExists(f), true);
  });

  it('空目录 → false(无候选用例文件,可生成)', () => {
    assert.equal(sampleSourceExists(dir), false);
  });

  it('目录含候选用例文件 → true', () => {
    writeFileSync(join(dir, 'samples.json'), '[]');
    assert.equal(sampleSourceExists(dir), true);
  });

  it('目录只含 reserved 前缀文件(report/health/_)→ false(非用例,可生成)', () => {
    writeFileSync(join(dir, 'report-x.json'), '{}');
    writeFileSync(join(dir, 'health.json'), '{}');
    writeFileSync(join(dir, '_meta.json'), '{}');
    assert.equal(sampleSourceExists(dir), false);
  });

  it('目录含 .yaml/.yml 候选 → true', () => {
    writeFileSync(join(dir, 'cases.yaml'), 'samples: []');
    assert.equal(sampleSourceExists(dir), true);
  });

  it('无扩展名文件 → true(statSync 判型,不被当目录绕过守卫)', () => {
    const f = join(dir, 'samples-noext');
    writeFileSync(f, '{ broken json');
    assert.equal(sampleSourceExists(f), true);
  });

  it('带点的目录名(samples.v2/)按目录处理:空 → false,含候选 → true', () => {
    const sub = join(dir, 'samples.v2');
    mkdirSync(sub);
    assert.equal(sampleSourceExists(sub), false);
    writeFileSync(join(sub, 'cases.json'), '[]');
    assert.equal(sampleSourceExists(sub), true);
  });
});

// resolveSampleOutFile 决定自动生成的落盘目标。与 sampleSourceExists 同用 statSync 判型,
// 不被「带点目录名」误当文件 —— 否则 writeFileSync 撞 EISDIR。
describe('resolveSampleOutFile', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'omk-outfile-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('不存在 + 有扩展名 → 原路径(当文件写)', () => {
    const f = join(dir, 'eval-samples.json');
    assert.equal(resolveSampleOutFile(f), f);
  });

  it('不存在 + 无扩展名 → 目录内 samples.json(当目录)', () => {
    const p = join(dir, 'omk-out');
    assert.equal(resolveSampleOutFile(p), join(p, 'samples.json'));
  });

  it('已存在的文件 → 原路径(覆盖)', () => {
    const f = join(dir, 'eval-samples.json');
    writeFileSync(f, '[]');
    assert.equal(resolveSampleOutFile(f), f);
  });

  it('已存在的普通目录 → 目录内 samples.json', () => {
    assert.equal(resolveSampleOutFile(dir), join(dir, 'samples.json'));
  });

  it('已存在的带点目录名(samples.v2/)→ 目录内 samples.json,不被当文件(防 EISDIR)', () => {
    const sub = join(dir, 'samples.v2');
    mkdirSync(sub);
    assert.equal(resolveSampleOutFile(sub), join(sub, 'samples.json'));
  });
});
