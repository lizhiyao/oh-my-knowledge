import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { sampleNextEvalCommand } from '../../src/cli/commands/sample.js';

describe('sampleNextEvalCommand', () => {
  it('目录 skill 用目录路径作为 treatment', () => {
    assert.equal(
      sampleNextEvalCommand({
        isDirectorySkill: true,
        skillDir: resolve('skills/review'),
        skillPath: resolve('skills/review/SKILL.md'),
      }),
      'omk eval --control baseline --treatment skills/review',
    );
  });

  it('传内部 SKILL.md 的目录 skill 仍提示目录路径', () => {
    assert.equal(
      sampleNextEvalCommand({
        isDirectorySkill: true,
        skillDir: resolve('skills/review'),
        skillPath: resolve('skills/review/SKILL.md'),
      }),
      'omk eval --control baseline --treatment skills/review',
    );
  });

  it('扁平 .md skill 用文件路径作为 treatment', () => {
    assert.equal(
      sampleNextEvalCommand({
        isDirectorySkill: false,
        skillDir: resolve('skills'),
        skillPath: resolve('skills/review.md'),
      }),
      'omk eval --control baseline --treatment skills/review.md',
    );
  });

  it('路径含空格时 shell quote，保证可复制运行', () => {
    assert.equal(
      sampleNextEvalCommand({
        isDirectorySkill: true,
        skillDir: resolve('skills/review skill'),
        skillPath: resolve('skills/review skill/SKILL.md'),
      }),
      "omk eval --control baseline --treatment 'skills/review skill'",
    );
  });
});
