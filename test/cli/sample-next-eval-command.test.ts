import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { sampleNextEvalCommand } from '../../src/cli/commands/sample.js';
import { formatSampleGenerationFailureHint } from '../../src/cli/lib/generation-failure-hint.js';
import { tCli } from '../../src/cli/lib/i18n.js';

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

  it('生成后提示先 dry-run 再正式 eval', () => {
    const command = "omk eval --control baseline --treatment 'skills/review skill'";
    const zh = tCli('cli.gen.review_hint', 'zh', { command });
    assert.match(zh, /预览任务：omk eval --control baseline --treatment 'skills\/review skill' --dry-run/);
    assert.match(zh, /跑评测：omk eval --control baseline --treatment 'skills\/review skill'/);

    const en = tCli('cli.gen.review_hint', 'en', { command });
    assert.match(en, /Preview the task plan: omk eval --control baseline --treatment 'skills\/review skill' --dry-run/);
    assert.match(en, /Run the eval: omk eval --control baseline --treatment 'skills\/review skill'/);
  });
});

describe('formatSampleGenerationFailureHint', () => {
  it('adds API-key guidance for OpenAI API sample generation failures', () => {
    const hint = formatSampleGenerationFailureHint(
      'OPENAI_API_KEY environment variable is not set',
      'openai-api',
      'zh',
      { CODEX_HOME: '/tmp/omk-empty-codex-home-for-tests' },
    );

    assert.ok(hint.includes('OPENAI_API_KEY / OPENAI_BASE_URL'), hint);
    assert.ok(hint.includes('--executor claude --model sonnet'), hint);
    assert.ok(hint.includes('--executor codex --model <codex-model>'), hint);
  });

  it('does not misclassify model-output JSON errors as auth failures', () => {
    const hint = formatSampleGenerationFailureHint(
      'generation failed after 3 attempts (JSON invalid): JSON 解析失败',
      'claude',
      'zh',
      { CODEX_HOME: '/tmp/omk-empty-codex-home-for-tests' },
    );

    assert.equal(hint, '');
  });

  it('does not add vendor guidance for custom script executors', () => {
    const hint = formatSampleGenerationFailureHint(
      'OPENAI_API_KEY environment variable is not set',
      './sample-generator.sh',
      'zh',
      { CODEX_HOME: '/tmp/omk-empty-codex-home-for-tests' },
    );

    assert.equal(hint, '');
  });
});
