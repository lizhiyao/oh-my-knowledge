import { afterEach, beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultSkillLocalSamplesFile,
  findDoctorSamplesPath,
  findNamedSkillSamplesPath,
  findProjectSamplesFile,
  findSkillSamplesPath,
  findSingleTreatmentSamplesPath,
  hasUsableSamplesPath,
  SampleFileAmbiguityError,
} from '../../src/inputs/sample-locator.js';

describe('sample-locator canonical discovery', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'omk-sample-locator-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('项目级 JSON 与 YAML 都是一等 canonical 格式', () => {
    const json = join(root, 'eval-samples.json');
    writeFileSync(json, '{}\n');
    assert.equal(findProjectSamplesFile(root), json);

    rmSync(json);
    const yaml = join(root, 'eval-samples.yaml');
    writeFileSync(yaml, '{}\n');
    assert.equal(findProjectSamplesFile(root), yaml);
  });

  it('同一作用域 JSON 与 YAML 并存时拒绝静默选优先级', () => {
    writeFileSync(join(root, 'eval-samples.json'), '{}\n');
    writeFileSync(join(root, 'eval-samples.yaml'), '{}\n');
    assert.throws(() => findProjectSamplesFile(root), (error: unknown) => {
      assert.ok(error instanceof SampleFileAmbiguityError);
      assert.deepEqual(error.paths, [
        join(root, 'eval-samples.json'),
        join(root, 'eval-samples.yaml'),
      ]);
      return true;
    });
  });

  it('自动发现忽略 .yml、samples.* 与扁平 sidecar 旧命名', () => {
    writeFileSync(join(root, 'eval-samples.yml'), '{}\n');
    writeFileSync(join(root, 'samples.json'), '{}\n');
    writeFileSync(join(root, 'review.eval-samples.json'), '{}\n');
    assert.equal(findProjectSamplesFile(root), null);
  });

  it('目录 skill 只发现 .omk/eval-samples.{json,yaml} 单文件', () => {
    const skillRoot = join(root, 'skills', 'review');
    mkdirSync(join(skillRoot, '.omk'), { recursive: true });
    writeFileSync(join(skillRoot, 'SKILL.md'), '# review\n');
    writeFileSync(join(skillRoot, 'eval-samples.json'), '{}\n');
    writeFileSync(join(skillRoot, '.omk', 'samples.json'), '{}\n');
    assert.equal(findSkillSamplesPath(skillRoot), null);

    const canonical = join(skillRoot, '.omk', 'eval-samples.yaml');
    writeFileSync(canonical, '{}\n');
    assert.equal(findSkillSamplesPath(skillRoot), canonical);
    assert.equal(findNamedSkillSamplesPath(join(root, 'skills'), 'review'), canonical);
  });

  it('目录 skill 私有 JSON 与 YAML 并存时同样拒绝歧义', () => {
    const skillRoot = join(root, 'skills', 'review');
    mkdirSync(join(skillRoot, '.omk'), { recursive: true });
    writeFileSync(join(skillRoot, 'SKILL.md'), '# review\n');
    writeFileSync(join(skillRoot, '.omk', 'eval-samples.json'), '{}\n');
    writeFileSync(join(skillRoot, '.omk', 'eval-samples.yaml'), '{}\n');
    assert.throws(() => findSkillSamplesPath(skillRoot), SampleFileAmbiguityError);
  });

  it('同名 flat / directory skill 时遵循 file-first，不误读目录 skill 私有用例', () => {
    const skillDir = join(root, 'skills');
    const dirSkill = join(skillDir, 'dual');
    mkdirSync(join(dirSkill, '.omk'), { recursive: true });
    writeFileSync(join(skillDir, 'dual.md'), '# flat\n');
    writeFileSync(join(dirSkill, 'SKILL.md'), '# directory\n');
    writeFileSync(join(dirSkill, '.omk', 'eval-samples.json'), '{}\n');
    assert.equal(findNamedSkillSamplesPath(skillDir, 'dual'), null);
  });

  it('单 treatment 目录 skill 优先私有文件，扁平 skill 留给项目级回退', () => {
    const skillDir = join(root, 'skills');
    const dirSkill = join(skillDir, 'release');
    mkdirSync(join(dirSkill, '.omk'), { recursive: true });
    writeFileSync(join(dirSkill, 'SKILL.md'), '# release\n');
    const local = join(dirSkill, '.omk', 'eval-samples.json');
    writeFileSync(local, '{}\n');
    assert.equal(findSingleTreatmentSamplesPath('release', skillDir, root), local);

    writeFileSync(join(skillDir, 'flat.md'), '# flat\n');
    writeFileSync(join(skillDir, 'flat.eval-samples.json'), '{}\n');
    assert.equal(findSingleTreatmentSamplesPath('flat', skillDir, root), null);
  });

  it('doctor 的 skill target 优先私有文件，skills 目录 target 回到项目级', () => {
    const skillRoot = join(root, 'skills', 'review');
    mkdirSync(join(skillRoot, '.omk'), { recursive: true });
    writeFileSync(join(skillRoot, 'SKILL.md'), '# review\n');
    const local = join(skillRoot, '.omk', 'eval-samples.json');
    const project = join(root, 'eval-samples.yaml');
    writeFileSync(local, '{}\n');
    writeFileSync(project, '{}\n');

    assert.equal(findDoctorSamplesPath(skillRoot, root), local);
    assert.equal(findDoctorSamplesPath(join(root, 'skills'), root), project);
  });

  it('默认私有写入路径使用 canonical JSON 名', () => {
    assert.equal(
      defaultSkillLocalSamplesFile(join(root, 'skills', 'review')),
      join(root, 'skills', 'review', '.omk', 'eval-samples.json'),
    );
  });

  it('显式 --samples 仍允许单文件或含可加载分片的目录', () => {
    const emptyDir = join(root, 'empty');
    const samplesDir = join(root, 'custom-shards');
    mkdirSync(emptyDir, { recursive: true });
    mkdirSync(samplesDir, { recursive: true });
    writeFileSync(join(samplesDir, 'report.json'), '{}\n');
    assert.equal(hasUsableSamplesPath(emptyDir), false);
    assert.equal(hasUsableSamplesPath(samplesDir), false);

    writeFileSync(join(samplesDir, 'cases.yml'), '{}\n');
    assert.equal(hasUsableSamplesPath(samplesDir), true);
  });
});
