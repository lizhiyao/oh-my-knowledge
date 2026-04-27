import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveArtifacts } from '../../src/inputs/skill-loader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = join(__dirname, '..', '..', 'examples', 'code-review', 'skills');
const MULTI_SKILL_DIR = join(__dirname, '..', '..', 'examples', 'multi-skills', 'skills');

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
      /baseline cannot be bound to a cwd/,
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

  it('file-skill 不设 skillRoot(cwd 走默认,即用户项目目录)', () => {
    const artifacts = resolveArtifacts(SKILL_DIR, ['v1']);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].skillRoot, undefined);
  });

  it('directory-skill 把 skillRoot 设到 SKILL.md 所在目录', () => {
    const artifacts = resolveArtifacts(MULTI_SKILL_DIR, ['classifier']);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].name, 'classifier');
    assert.equal(artifacts[0].kind, 'skill');
    assert.equal(artifacts[0].skillRoot, join(MULTI_SKILL_DIR, 'classifier'));
  });

  it('显式 @cwd 覆盖,但 skillRoot 仍记录在 artifact 上(优先级在 task-planner 处理)', () => {
    const artifacts = resolveArtifacts(MULTI_SKILL_DIR, ['classifier@/tmp/override']);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].cwd, '/tmp/override');
    assert.equal(artifacts[0].skillRoot, join(MULTI_SKILL_DIR, 'classifier'));
  });

  it('file-path 指向 SKILL.md 同 directory-skill 处理:设 skillRoot 为该目录', () => {
    const skillMd = join(MULTI_SKILL_DIR, 'classifier', 'SKILL.md');
    const artifacts = resolveArtifacts(SKILL_DIR, [skillMd]);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].source, 'file-path');
    assert.equal(artifacts[0].skillRoot, dirname(skillMd));
  });

  it('file-path 指向单文件 .md 不设 skillRoot', () => {
    const v1Path = join(SKILL_DIR, 'v1.md');
    const artifacts = resolveArtifacts(MULTI_SKILL_DIR, [v1Path]);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].source, 'file-path');
    assert.equal(artifacts[0].skillRoot, undefined);
  });
});
