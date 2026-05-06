import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { parseJudgeModelsArg } from '../../src/cli/parse-run-config.js';

/**
 * `parseJudgeModelsArg` 是 `--judge-models executor:model[,executor:model,...]`
 * CLI 参数的统一解析器，`eval` / `evolve` 共享同一份解析。
 */
describe('parseJudgeModelsArg', () => {
  it('单条 executor:model 解析为 1-entry 数组', () => {
    assert.deepEqual(parseJudgeModelsArg('claude:haiku'), [
      { executor: 'claude', model: 'haiku' },
    ]);
  });

  it('多条逗号分隔为 ensemble 数组,保留输入顺序', () => {
    assert.deepEqual(
      parseJudgeModelsArg('claude:opus,openai:gpt-4o'),
      [
        { executor: 'claude', model: 'opus' },
        { executor: 'openai', model: 'gpt-4o' },
      ],
    );
  });

  it('reject 重复 executor:model (ensemble 聚合按 judge id 去重)', () => {
    assert.throws(
      () => parseJudgeModelsArg('claude:haiku,claude:haiku'),
      /duplicate entry "claude:haiku"/,
    );
  });

  it('reject 缺 executor 部分', () => {
    assert.throws(() => parseJudgeModelsArg(':haiku'), /must be 'executor:model'/);
  });

  it('reject 缺 model 部分', () => {
    assert.throws(() => parseJudgeModelsArg('claude:'), /must be 'executor:model'/);
  });

  it('reject 空串', () => {
    assert.throws(() => parseJudgeModelsArg(''), /cannot be empty/);
  });

  it('reject 全空 entry (",,,")', () => {
    assert.throws(() => parseJudgeModelsArg(',,,'), /cannot be empty/);
  });

  it('model 中含 ":" 视为合法 (e.g. openai-api:gpt-4o:2025-04-01)', () => {
    // 解析时按第一个 ":" split,model 部分允许再含 ":"。
    assert.deepEqual(parseJudgeModelsArg('openai-api:gpt-4o:2025-04-01'), [
      { executor: 'openai-api', model: 'gpt-4o:2025-04-01' },
    ]);
  });
});
