import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  buildSdkIsolationOptions,
  claudeSdkExecutor,
} from '../../src/executors/anthropic/claude-sdk.js';

describe('buildSdkIsolationOptions', () => {
  it('allowedSkills=undefined → {} (SDK 默认全发现)', () => {
    assert.deepEqual(buildSdkIsolationOptions(undefined), {});
  });

  it('allowedSkills=[] → { skills:[], disallowedTools:[Skill] } (双堵 main + subagent)', () => {
    const opts = buildSdkIsolationOptions([]);
    assert.deepEqual(opts.skills, []);
    assert.deepEqual(opts.disallowedTools, ['Skill']);
  });

  it('allowedSkills=[react] → throw(非空白名单不再支持:无法真正隔离)', () => {
    assert.throws(() => buildSdkIsolationOptions(['react']), /白名单.*不再支持|无法真正隔离/);
  });

  it('allowedSkills=[a, b] → throw', () => {
    assert.throws(() => buildSdkIsolationOptions(['a', 'b']), /白名单.*不再支持|无法真正隔离/);
  });
});

// executor 层契约:非空白名单必须 fail-fast(在 timer / try 之前抛),不能被 catch 吞成
// ok:false 的 ExecResult —— 否则程序化调用(绕过 loadEvalConfig 校验)时 claude-sdk 会跟
// claude-cli / codex 的硬抛口径分叉,把配置错误伪装成全 sample 执行失败的报告。
describe('claudeSdkExecutor — 非空白名单 fail-fast', () => {
  it('allowedSkills=[x] → reject(抛错,不进评测管线)', async () => {
    await assert.rejects(
      claudeSdkExecutor({ model: 'haiku', prompt: 'p', allowedSkills: ['x'], timeoutMs: 1000 }),
      /白名单.*不再支持|无法真正隔离/,
    );
  });

  it('lean=true 也不绕过非空白名单校验 → reject', async () => {
    await assert.rejects(
      claudeSdkExecutor({ model: 'haiku', prompt: 'p', allowedSkills: ['x'], lean: true, timeoutMs: 1000 }),
      /白名单.*不再支持|无法真正隔离/,
    );
  });
});
