import { afterEach, beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultFlatSkillSamplesFile,
  defaultSkillLocalSamplesFile,
  findDeprecatedSkillSamplesHint,
  findDoctorSamplesPath,
  findDoctorDeprecatedSamplesHint,
  findFlatSkillSamplesPath,
  findNamedSkillSamplesPath,
  findSkillSamplesPath,
  findSingleTreatmentDeprecatedSamplesHint,
  findSingleTreatmentSamplesPath,
  hasUsableSamplesPath,
} from '../../src/inputs/sample-locator.js';

describe('sample-locator', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'omk-sample-locator-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('目录 skill 只从 .omk 读取 skill-local samples', () => {
    const skillRoot = join(root, 'skills', 'review');
    mkdirSync(join(skillRoot, '.omk'), { recursive: true });
    writeFileSync(join(skillRoot, 'SKILL.md'), '# review\n');
    writeFileSync(join(skillRoot, 'eval-samples.json'), '[]\n');
    writeFileSync(join(skillRoot, '.omk', 'samples.json'), '[]\n');

    assert.equal(findSkillSamplesPath(skillRoot), join(skillRoot, '.omk'));
  });

  it('目录 skill 下的 eval-samples 不再作为 skill-local 兼容路径', () => {
    const skillRoot = join(root, 'skills', 'review');
    mkdirSync(join(skillRoot, '.omk'), { recursive: true });
    writeFileSync(join(skillRoot, 'SKILL.md'), '# review\n');
    writeFileSync(join(skillRoot, 'eval-samples.yaml'), '[]\n');

    assert.equal(findSkillSamplesPath(skillRoot), null);
  });

  it('目录 skill 下的旧 eval-samples 会返回迁移提示', () => {
    const skillRoot = join(root, 'skills', 'review');
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(join(skillRoot, 'SKILL.md'), '# review\n');
    writeFileSync(join(skillRoot, 'eval-samples.yaml'), '[]\n');

    assert.deepEqual(findDeprecatedSkillSamplesHint(skillRoot), {
      oldPath: join(skillRoot, 'eval-samples.yaml'),
      newPath: join(skillRoot, '.omk', 'samples.json'),
    });
    assert.deepEqual(findSingleTreatmentDeprecatedSamplesHint('review', join(root, 'skills'), root), {
      oldPath: join(skillRoot, 'eval-samples.yaml'),
      newPath: join(skillRoot, '.omk', 'samples.json'),
    });
    assert.deepEqual(findDoctorDeprecatedSamplesHint(skillRoot, root), {
      oldPath: join(skillRoot, 'eval-samples.yaml'),
      newPath: join(skillRoot, '.omk', 'samples.json'),
    });
  });

  it('目录 skill 用 .omk,扁平 skill 兼容 sidecar', () => {
    const skillDir = join(root, 'skills');
    const dirSkill = join(skillDir, 'classifier');
    mkdirSync(join(dirSkill, '.omk'), { recursive: true });
    writeFileSync(join(dirSkill, 'SKILL.md'), '# classifier\n');
    writeFileSync(join(dirSkill, '.omk', 'cases.yaml'), '[]\n');

    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'summarizer.md'), '# summarizer\n');
    writeFileSync(join(skillDir, 'summarizer.eval-samples.yml'), '[]\n');

    assert.equal(findNamedSkillSamplesPath(skillDir, 'classifier'), join(dirSkill, '.omk'));
    assert.equal(findFlatSkillSamplesPath(skillDir, 'summarizer'), join(skillDir, 'summarizer.eval-samples.yml'));
  });

  it('只有目录 skill 时不读取同名 paired sidecar', () => {
    const skillDir = join(root, 'skills');
    const skillRoot = join(skillDir, 'classifier');
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(join(skillRoot, 'SKILL.md'), '# classifier\n');
    writeFileSync(join(skillDir, 'classifier.eval-samples.json'), '[]\n');

    assert.equal(findNamedSkillSamplesPath(skillDir, 'classifier'), null);
  });

  it('短名解析命中扁平 skill 时不回退读取同名目录 .omk', () => {
    const skillDir = join(root, 'skills');
    mkdirSync(join(skillDir, 'dual', '.omk'), { recursive: true });
    writeFileSync(join(skillDir, 'dual.md'), '# dual file\n');
    writeFileSync(join(skillDir, 'dual', 'SKILL.md'), '# dual dir\n');
    writeFileSync(join(skillDir, 'dual', '.omk', 'samples.json'), '[]\n');

    assert.equal(findNamedSkillSamplesPath(skillDir, 'dual'), null);
  });

  it('短名解析命中扁平 skill 时使用扁平 paired sidecar', () => {
    const skillDir = join(root, 'skills');
    mkdirSync(join(skillDir, 'dual', '.omk'), { recursive: true });
    writeFileSync(join(skillDir, 'dual.md'), '# dual file\n');
    writeFileSync(join(skillDir, 'dual', 'SKILL.md'), '# dual dir\n');
    writeFileSync(join(skillDir, 'dual', '.omk', 'samples.json'), '[]\n');
    writeFileSync(join(skillDir, 'dual.eval-samples.json'), '[]\n');

    assert.equal(findNamedSkillSamplesPath(skillDir, 'dual'), join(skillDir, 'dual.eval-samples.json'));
  });

  it('短名解析命中扁平 skill 时不提示同名目录旧 eval-samples', () => {
    const skillDir = join(root, 'skills');
    mkdirSync(join(skillDir, 'dual'), { recursive: true });
    writeFileSync(join(skillDir, 'dual.md'), '# dual file\n');
    writeFileSync(join(skillDir, 'dual', 'SKILL.md'), '# dual dir\n');
    writeFileSync(join(skillDir, 'dual', 'eval-samples.json'), '[]\n');

    assert.equal(findSingleTreatmentDeprecatedSamplesHint('dual', skillDir, root), null);
  });

  it('扁平 skill 不再读取同名目录下的 .omk', () => {
    const skillDir = join(root, 'skills');
    mkdirSync(join(skillDir, 'summarizer', '.omk'), { recursive: true });
    writeFileSync(join(skillDir, 'summarizer.md'), '# summarizer\n');
    writeFileSync(join(skillDir, 'summarizer', '.omk', 'samples.json'), '[]\n');

    assert.equal(findFlatSkillSamplesPath(skillDir, 'summarizer'), null);
  });

  it('单 treatment 自动发现短名对应的 skill-local samples', () => {
    const skillDir = join(root, 'skills');
    const skillRoot = join(skillDir, 'release');
    mkdirSync(join(skillRoot, '.omk'), { recursive: true });
    writeFileSync(join(skillRoot, 'SKILL.md'), '# release\n');
    writeFileSync(join(skillRoot, '.omk', 'samples.json'), '[]\n');
    writeFileSync(join(root, 'eval-samples.json'), '[]\n');

    assert.equal(findSingleTreatmentSamplesPath('release', skillDir, root), join(skillRoot, '.omk'));
  });

  it('doctor 针对 skill target 时优先使用 skill-local,针对 skills 目录时回到项目级', () => {
    const skillRoot = join(root, 'skills', 'review');
    mkdirSync(join(skillRoot, '.omk'), { recursive: true });
    writeFileSync(join(skillRoot, 'SKILL.md'), '# review\n');
    writeFileSync(join(skillRoot, '.omk', 'samples.json'), '[]\n');
    writeFileSync(join(root, 'eval-samples.json'), '[]\n');

    assert.equal(findDoctorSamplesPath(skillRoot, root), join(skillRoot, '.omk'));
    assert.equal(findDoctorSamplesPath(join(root, 'skills'), root), join(root, 'eval-samples.json'));
  });

  it('doctor 针对目录 skill target 时不会读取该 skill 根下的旧 eval-samples', () => {
    const skillRoot = join(root, 'skills', 'review');
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(join(skillRoot, 'SKILL.md'), '# review\n');
    writeFileSync(join(skillRoot, 'eval-samples.json'), '[]\n');
    writeFileSync(join(root, 'eval-samples.json'), '[]\n');

    assert.equal(findDoctorSamplesPath(skillRoot, root), join(root, 'eval-samples.json'));
  });

  it('默认写入路径区分目录 skill 与扁平 skill', () => {
    assert.equal(defaultSkillLocalSamplesFile(join(root, 'skills', 'review')), join(root, 'skills', 'review', '.omk', 'samples.json'));
    assert.equal(defaultFlatSkillSamplesFile(join(root, 'skills'), 'review'), join(root, 'skills', 'review.eval-samples.json'));
  });

  it('hasUsableSamplesPath 区分可加载样本目录与空目录', () => {
    const emptyDir = join(root, 'empty');
    const samplesDir = join(root, 'samples');
    mkdirSync(emptyDir, { recursive: true });
    mkdirSync(samplesDir, { recursive: true });
    writeFileSync(join(samplesDir, 'report.json'), '{}\n');
    assert.equal(hasUsableSamplesPath(emptyDir), false);
    assert.equal(hasUsableSamplesPath(samplesDir), false);

    writeFileSync(join(samplesDir, 'samples.json'), '[]\n');
    assert.equal(hasUsableSamplesPath(samplesDir), true);
  });
});
