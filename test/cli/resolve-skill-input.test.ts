/**
 * resolveSkillInput 的 isDirectorySkill 语义锁:**只看解析后形态、不看入参写法**。目录-skill 无论传目录还是
 * 传内部 SKILL.md 都判 true,扁平 .md 判 false —— 受管联动据此对齐 install 落的记录形态(P1 根因防回归:
 * 旧实现按「入参是不是目录」判,传 SKILL.md 文件路径会误得 false,匹配不到目录记录)。
 */
import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSkillInput } from '../../src/cli/lib/resolve-skill-input.js';

describe('resolveSkillInput isDirectorySkill', () => {
  let proj: string;
  let skillRoot: string;
  beforeEach(() => {
    proj = mkdtempSync(join(tmpdir(), 'omk-rsi-'));
    skillRoot = join(proj, 'mydir');
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(join(skillRoot, 'SKILL.md'), '# dir skill\n');
    writeFileSync(join(proj, 'flat.md'), '# flat skill\n');
  });
  afterEach(() => rmSync(proj, { recursive: true, force: true }));

  it('传目录 → isDirectorySkill=true,skillPath 落到内部 SKILL.md', () => {
    const r = resolveSkillInput(skillRoot, 'zh');
    assert.equal(r.isDirectorySkill, true);
    assert.equal(r.skillPath, join(skillRoot, 'SKILL.md'));
    assert.equal(r.skillDir, skillRoot);
  });

  it('传内部 SKILL.md 文件路径 → 仍 isDirectorySkill=true(与传目录等价)', () => {
    const r = resolveSkillInput(join(skillRoot, 'SKILL.md'), 'zh');
    assert.equal(r.isDirectorySkill, true, '帮助文档鼓励的写法,必须判为目录-skill');
    assert.equal(r.skillPath, join(skillRoot, 'SKILL.md'));
    assert.equal(r.skillDir, skillRoot);
  });

  it('传扁平 .md → isDirectorySkill=false', () => {
    const r = resolveSkillInput(join(proj, 'flat.md'), 'zh');
    assert.equal(r.isDirectorySkill, false);
    assert.equal(r.skillPath, join(proj, 'flat.md'));
    assert.equal(r.skillDir, proj);
  });
});
