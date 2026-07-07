import { afterEach, beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatConnectivityFailureHint } from '../../src/cli/commands/eval/index.js';

const ORIGINAL_CODEX_HOME = process.env.CODEX_HOME;

describe('eval connectivity failure hint', () => {
  beforeEach(() => {
    process.env.CODEX_HOME = '/tmp/omk-empty-codex-home-for-tests';
  });

  afterEach(() => {
    if (ORIGINAL_CODEX_HOME === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = ORIGINAL_CODEX_HOME;
  });

  it('suggests Codex flags when default Claude preflight fails', () => {
    const hint = formatConnectivityFailureHint(
      'preflight failed [claude:sonnet]: Failed to authenticate. API Error: 401 Invalid authentication credentials',
      {
        executorName: 'claude',
        model: 'sonnet',
        judgeModels: [{ executor: 'claude', model: 'haiku' }],
        noJudge: false,
      },
      'zh',
    );

    assert.ok(hint.includes('--executor codex --model <codex-model> --judge-models codex:<codex-model>'), hint);
    assert.ok(hint.includes('costUSD'), hint);
  });

  it('fills Codex fallback flags from local Codex config when available', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-codex-eval-hint-'));
    await writeFile(join(dir, 'config.toml'), 'model = "gpt-5.5"\n');

    const hint = formatConnectivityFailureHint(
      'preflight failed [claude:sonnet]: auth failed',
      {
        executorName: 'claude',
        model: 'sonnet',
        judgeModels: [{ executor: 'claude', model: 'haiku' }],
        noJudge: false,
      },
      'zh',
      { CODEX_HOME: dir },
    );

    assert.ok(hint.includes('--executor codex --model gpt-5.5 --judge-models codex:gpt-5.5'), hint);
    assert.ok(hint.includes('model=gpt-5.5'), hint);
    assert.ok(!hint.includes('<codex-model>'), hint);
  });

  it('omits judge flags when the run has --no-judge', () => {
    const hint = formatConnectivityFailureHint(
      'preflight failed [claude:sonnet]: auth failed',
      {
        executorName: 'claude',
        model: 'sonnet',
        judgeModels: [{ executor: 'claude', model: 'haiku' }],
        noJudge: true,
      },
      'en',
    );

    assert.ok(hint.includes('--executor codex --model <codex-model>'), hint);
    assert.ok(!hint.includes('--judge-models'), hint);
  });

  it('keeps an explicit non-Claude judge when the Claude task runtime fails', () => {
    const hint = formatConnectivityFailureHint(
      'preflight failed [claude:sonnet]: auth failed',
      {
        executorName: 'claude',
        model: 'sonnet',
        judgeModels: [{ executor: 'openai-api', model: 'gpt-4o' }],
        noJudge: false,
      },
      'zh',
    );

    assert.ok(hint.includes('--executor codex --model <codex-model>'), hint);
    assert.ok(!hint.includes('--judge-models'), hint);
  });

  it('does not suggest Codex for non-Claude executor failures', () => {
    const hint = formatConnectivityFailureHint(
      'preflight failed [custom:sonnet]: custom executor failed',
      {
        executorName: './my-executor.sh',
        model: 'sonnet',
        judgeModels: [{ executor: './judge.sh', model: 'judge' }],
        noJudge: false,
      },
      'zh',
    );

    assert.equal(hint, '');
  });

  it('does not suggest Codex for non-preflight errors', () => {
    const hint = formatConnectivityFailureHint(
      'doctor failed: samples contract mismatch',
      {
        executorName: 'claude',
        model: 'sonnet',
        judgeModels: [{ executor: 'claude', model: 'haiku' }],
        noJudge: false,
      },
      'zh',
    );

    assert.equal(hint, '');
  });

  it('suggests API-key checks instead of Codex when an OpenAI API judge fails in a mixed run', () => {
    const hint = formatConnectivityFailureHint(
      'preflight failed [openai-api:gpt-4o]: missing OPENAI_API_KEY',
      {
        executorName: 'claude',
        model: 'sonnet',
        judgeModels: [{ executor: 'openai-api', model: 'gpt-4o' }],
        noJudge: false,
      },
      'zh',
    );

    assert.ok(hint.includes('OPENAI_API_KEY'), hint);
    assert.ok(!hint.includes('--executor codex'), hint);
  });

  it('honors the preflight target before API-key fallback text in mixed runs', () => {
    const hint = formatConnectivityFailureHint(
      'preflight failed [codex:gpt-5-codex]: missing OPENAI_API_KEY',
      {
        executorName: 'codex',
        model: 'gpt-5-codex',
        judgeModels: [{ executor: 'openai-api', model: 'gpt-4o-mini' }],
        noJudge: false,
      },
      'zh',
    );

    assert.ok(hint.includes('Codex CLI / SDK'), hint);
    assert.ok(hint.includes('--executor claude --model sonnet'), hint);
    assert.ok(!hint.includes('当前失败的是 OpenAI API 执行器'), hint);
  });

  it('suggests OpenAI API key checks for direct executor configuration errors', () => {
    const hint = formatConnectivityFailureHint(
      'OPENAI_API_KEY environment variable is not set',
      {
        executorName: 'openai-api',
        model: 'gpt-4o-mini',
        judgeModels: [{ executor: 'openai-api', model: 'gpt-4o-mini' }],
        noJudge: false,
      },
      'zh',
    );

    assert.ok(hint.includes('OPENAI_API_KEY'), hint);
    assert.ok(hint.includes('OPENAI_BASE_URL'), hint);
  });

  it('suggests OpenAI API model checks for preflight model failures', () => {
    const hint = formatConnectivityFailureHint(
      'preflight failed [openai-api:gpt-5]: invalid_request_error: The model `gpt-5` does not exist or you do not have access to it.',
      {
        executorName: 'openai-api',
        model: 'gpt-5',
        judgeModels: [{ executor: 'openai-api', model: 'gpt-5' }],
        noJudge: false,
      },
      'zh',
    );

    assert.ok(hint.includes('模型名看起来对当前端点不可用'), hint);
    assert.ok(hint.includes('--model / --judge-models、OPENAI_BASE_URL 与账号权限'), hint);
    assert.ok(!hint.includes('OPENAI_API_KEY / OPENAI_BASE_URL'), hint);
  });

  it('suggests Anthropic API key checks for direct executor configuration errors', () => {
    const hint = formatConnectivityFailureHint(
      'ANTHROPIC_API_KEY environment variable is not set',
      {
        executorName: 'anthropic-api',
        model: 'claude-sonnet-4-5',
        judgeModels: [{ executor: 'anthropic-api', model: 'claude-haiku-4-5' }],
        noJudge: false,
      },
      'en',
    );

    assert.ok(hint.includes('ANTHROPIC_API_KEY'), hint);
    assert.ok(hint.includes('ANTHROPIC_BASE_URL'), hint);
  });

  it('suggests Anthropic API model checks for preflight model failures', () => {
    const hint = formatConnectivityFailureHint(
      'preflight failed [anthropic-api:claude-unknown]: unsupported model: claude-unknown is not available for this account',
      {
        executorName: 'anthropic-api',
        model: 'claude-unknown',
        judgeModels: [{ executor: 'anthropic-api', model: 'claude-unknown' }],
        noJudge: false,
      },
      'zh',
    );

    assert.ok(hint.includes('模型名看起来对当前端点不可用'), hint);
    assert.ok(hint.includes('--model / --judge-models、ANTHROPIC_BASE_URL 与账号权限'), hint);
    assert.ok(!hint.includes('ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL'), hint);
  });

  it('suggests local Codex model checks for preflight model failures', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-codex-model-eval-hint-'));
    await writeFile(join(dir, 'config.toml'), 'model = "gpt-5.5"\n');

    const hint = formatConnectivityFailureHint(
      'preflight failed [codex:gpt-5]: invalid_request_error: The model `gpt-5` is not supported when using Codex with a ChatGPT account.',
      {
        executorName: 'codex',
        model: 'gpt-5',
        judgeModels: [{ executor: 'codex', model: 'gpt-5' }],
        noJudge: false,
      },
      'zh',
      { CODEX_HOME: dir },
    );

    assert.ok(hint.includes('模型名看起来不可用'), hint);
    assert.ok(hint.includes('--executor codex --model gpt-5.5 --judge-models codex:gpt-5.5'), hint);
    assert.ok(hint.includes('codex exec -m gpt-5.5 "hi"'), hint);
    assert.ok(!hint.includes('先确认 Codex CLI / SDK 已安装并完成登录'), hint);
  });

  it('does not treat API-key text as connectivity guidance for unrelated runtimes', () => {
    const hint = formatConnectivityFailureHint(
      'doctor failed: sample text mentions OPENAI_API_KEY',
      {
        executorName: 'claude',
        model: 'sonnet',
        judgeModels: [{ executor: 'claude', model: 'haiku' }],
        noJudge: false,
      },
      'zh',
    );

    assert.equal(hint, '');
  });

  it('suggests only judge flags when a Claude judge fails even if the task executor is custom', () => {
    const hint = formatConnectivityFailureHint(
      'preflight failed [claude:haiku]: auth failed',
      {
        executorName: './my-executor.sh',
        model: 'local-model',
        judgeModels: [{ executor: 'claude', model: 'haiku' }],
        noJudge: false,
      },
      'zh',
    );

    assert.ok(hint.includes('--judge-models codex:<codex-model>'), hint);
    assert.ok(!hint.includes('--executor codex'), hint);
  });

  it('suggests Claude and OpenAI API fallbacks when Codex task runtime is unavailable', () => {
    const hint = formatConnectivityFailureHint(
      'preflight failed [codex:gpt-5-codex]: authentication failed',
      {
        executorName: 'codex',
        model: 'gpt-5-codex',
        judgeModels: [{ executor: 'codex', model: 'gpt-5-codex' }],
        noJudge: false,
      },
      'zh',
    );

    assert.ok(hint.includes('OPENAI_API_KEY'), hint);
    assert.ok(hint.includes('--executor claude --model sonnet --judge-models claude:haiku'), hint);
    assert.ok(hint.includes('--executor openai-api --model <openai-model> --judge-models openai-api:<openai-model>'), hint);
  });

  it('suggests only judge flags for Claude and OpenAI API when a Codex judge is unavailable', () => {
    const hint = formatConnectivityFailureHint(
      'preflight failed [codex:gpt-5-codex]: authentication failed',
      {
        executorName: './my-executor.sh',
        model: 'local-model',
        judgeModels: [{ executor: 'codex', model: 'gpt-5-codex' }],
        noJudge: false,
      },
      'en',
    );

    assert.ok(hint.includes('OPENAI_API_KEY'), hint);
    assert.ok(hint.includes('--judge-models claude:haiku'), hint);
    assert.ok(hint.includes('--judge-models openai-api:<openai-model>'), hint);
    assert.ok(!hint.includes('--executor claude'), hint);
    assert.ok(!hint.includes('--executor openai-api'), hint);
  });

  it('uses executor:model target when task and judge share a model name', () => {
    const hint = formatConnectivityFailureHint(
      'preflight failed [openai-api:gpt-5-codex]: missing OPENAI_API_KEY',
      {
        executorName: 'codex',
        model: 'gpt-5-codex',
        judgeModels: [{ executor: 'openai-api', model: 'gpt-5-codex' }],
        noJudge: false,
      },
      'zh',
    );

    assert.ok(hint.includes('OPENAI_API_KEY'), hint);
    assert.ok(!hint.includes('Codex CLI'), hint);
    assert.ok(!hint.includes('--executor claude'), hint);
  });

  it('keeps compatibility with legacy model-only preflight errors', () => {
    const hint = formatConnectivityFailureHint(
      'preflight failed [sonnet]: auth failed',
      {
        executorName: 'claude',
        model: 'sonnet',
        judgeModels: [{ executor: 'claude', model: 'haiku' }],
        noJudge: false,
      },
      'zh',
    );

    assert.ok(hint.includes('--executor codex --model <codex-model>'), hint);
  });
});
