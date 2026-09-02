/**
 * 内容指纹工具单测。hashArtifactSource 是 install 受管记录与 eval 报告 artifactHashes 的共用指纹,
 * 落在 inputs 层供两侧消费——同一 skill 装出来与测出来的指纹必须落在同一空间。
 */
import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hashArtifactSource, isDistributablePath } from '../../src/inputs/content-hash.js';
import { digestNodeFileResource, digestNodeTreeResource } from '../../src/eval-workflows/runtime-adapter/resource-leases/node.js';

describe('content-hash', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omk-content-hash-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('目录-skill 覆盖资产改动,文件-skill 跟内容走', () => {
    const root = join(dir, 'review');
    mkdirSync(join(root, 'references'), { recursive: true });
    writeFileSync(join(root, 'SKILL.md'), '# review\n');
    writeFileSync(join(root, 'references', 'cmd.md'), 'asset v1\n');
    const h1 = hashArtifactSource(root, true);
    writeFileSync(join(root, 'references', 'cmd.md'), 'asset v2\n'); // 只改资产,不动 SKILL.md
    const h2 = hashArtifactSource(root, true);
    assert.notEqual(h1, h2, '资产改动必须改变目录树 hash');

    const file = join(dir, 'notes.md');
    writeFileSync(file, 'body v1\n');
    const f1 = hashArtifactSource(file, false);
    writeFileSync(file, 'body v2\n');
    assert.notEqual(f1, hashArtifactSource(file, false), '文件-skill hash 随内容变');
  });

  it('与 Evaluation Core file/tree resource digest 严格同空间', async () => {
    const root = join(dir, 'canonical');
    mkdirSync(join(root, 'empty'), { recursive: true });
    writeFileSync(join(root, 'SKILL.md'), '# canonical\n');
    const executable = join(root, 'run.sh');
    writeFileSync(executable, '#!/bin/sh\n');
    chmodSync(executable, 0o755);

    const tree = await digestNodeTreeResource(root);
    assert.equal(`sha256:${hashArtifactSource(root, true)}`, tree.digest);

    const file = await digestNodeFileResource(join(root, 'SKILL.md'));
    assert.equal(`sha256:${hashArtifactSource(join(root, 'SKILL.md'), false)}`, file.digest);
  });

  it('忽略 .omk / evolve 等非分发产物,只补样本不算 artifact 漂移', () => {
    const root = join(dir, 'sk');
    mkdirSync(join(root, 'references'), { recursive: true });
    writeFileSync(join(root, 'SKILL.md'), '# sk\n');
    writeFileSync(join(root, 'references', 'a.md'), 'asset\n');
    const base = hashArtifactSource(root, true);
    mkdirSync(join(root, '.omk'), { recursive: true });
    writeFileSync(join(root, '.omk', 'eval-samples.json'), '[]\n');
    mkdirSync(join(root, 'evolve'), { recursive: true });
    writeFileSync(join(root, 'evolve', 'sk.r1.md'), 'cand\n');
    assert.equal(hashArtifactSource(root, true), base, '.omk / evolve 不该计入 artifact hash');
  });

  it('仅源根第一层 evolve 排除,嵌套 references/evolve 是合法资产计入 hash', () => {
    const root = join(dir, 'sk2');
    mkdirSync(join(root, 'references', 'evolve'), { recursive: true });
    writeFileSync(join(root, 'SKILL.md'), '# sk2\n');
    writeFileSync(join(root, 'references', 'evolve', 'guide.md'), 'v1\n');
    const h1 = hashArtifactSource(root, true);
    writeFileSync(join(root, 'references', 'evolve', 'guide.md'), 'v2\n');
    assert.notEqual(hashArtifactSource(root, true), h1, '嵌套 references/evolve 资产改动应改变 hash');
    const before = hashArtifactSource(root, true);
    mkdirSync(join(root, 'evolve'), { recursive: true });
    writeFileSync(join(root, 'evolve', 'cand.md'), 'x\n');
    assert.equal(hashArtifactSource(root, true), before, '仅源根第一层 evolve 排除');
  });

  it('isDistributablePath:任意层级排除隐藏/系统目录,仅源根排除 evolve', () => {
    assert.equal(isDistributablePath([]), true, '源根永远算');
    assert.equal(isDistributablePath(['SKILL.md']), true);
    assert.equal(isDistributablePath(['references', 'cmd.md']), true);
    assert.equal(isDistributablePath(['.omk', 'eval-samples.json']), false, '扁平路径里 .omk 段也要拦');
    assert.equal(isDistributablePath(['node_modules', 'x', 'y.js']), false);
    assert.equal(isDistributablePath(['evolve', 'cand.md']), false, '源根第一层 evolve 排除');
    assert.equal(isDistributablePath(['references', 'evolve', 'guide.md']), true, '嵌套 evolve 是合法资产');
  });
});
