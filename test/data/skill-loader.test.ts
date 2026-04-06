import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveArtifacts } from '../../lib/data-loaders/skill-loader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = join(__dirname, '..', '..', 'examples', 'code-review', 'skills');

describe('resolveArtifacts', () => {
  it('baseline 产生 kind 为 baseline 的 artifact', () => {
    const artifacts = resolveArtifacts(SKILL_DIR, ['baseline']);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].name, 'baseline');
    assert.equal(artifacts[0].kind, 'baseline');
    assert.equal(artifacts[0].source, 'baseline');
    assert.equal(artifacts[0].content, null);
  });

  it('文件 variant 产生带 content 的 artifact', () => {
    const artifacts = resolveArtifacts(SKILL_DIR, ['v1']);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].name, 'v1');
    assert.equal(artifacts[0].kind, 'skill');
    assert.equal(typeof artifacts[0].content, 'string');
    assert.ok((artifacts[0].content as string).length > 0);
  });

  it('baseline + 文件 variant 组合', () => {
    const artifacts = resolveArtifacts(SKILL_DIR, ['baseline', 'v1', 'v2']);
    assert.equal(artifacts.length, 3);
    assert.equal(artifacts[0].kind, 'baseline');
    assert.equal(artifacts[1].kind, 'skill');
    assert.equal(artifacts[2].kind, 'skill');
  });

  it('baseline@cwd 不再受支持', () => {
    assert.throws(
      () => resolveArtifacts(SKILL_DIR, ['baseline@/tmp/project-a']),
      /baseline 不能绑定 cwd/,
    );
  });

  it('unknown@cwd 作为 cwd-only baseline artifact', () => {
    const artifacts = resolveArtifacts(SKILL_DIR, ['project-env@/tmp/project-b']);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].name, 'project-env');
    assert.equal(artifacts[0].kind, 'baseline');
    assert.equal(artifacts[0].content, null);
    assert.equal(artifacts[0].cwd, '/tmp/project-b');
  });
});
