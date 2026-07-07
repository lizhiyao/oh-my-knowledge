import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexExecutorFlags, codexModelHint, getCodexModelSuggestion } from '../../src/cli/lib/codex-model-hint.js';
import { formatSampleGenerationFailureHint } from '../../src/cli/lib/generation-failure-hint.js';

describe('codex model hint', () => {
  it('reads the top-level model from CODEX_HOME/config.toml', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-codex-home-'));
    await writeFile(join(dir, 'config.toml'), [
      'model = "gpt-5.5"',
      'model_reasoning_effort = "xhigh"',
      '',
      '[profiles.other]',
      'model = "ignored"',
    ].join('\n'));

    const env = { CODEX_HOME: dir };

    assert.deepEqual(getCodexModelSuggestion(env), {
      model: 'gpt-5.5',
      fromConfig: true,
      configPath: join(dir, 'config.toml'),
    });
    assert.equal(codexExecutorFlags(env), '--executor codex --model gpt-5.5');
    assert.ok(codexModelHint('zh', env).includes('model=gpt-5.5'));
  });

  it('falls back to a placeholder when no local Codex model is configured', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-empty-codex-home-'));
    await mkdir(join(dir, 'nested'), { recursive: true });

    const hint = codexModelHint('zh', { CODEX_HOME: dir });

    assert.equal(codexExecutorFlags({ CODEX_HOME: dir }), '--executor codex --model <codex-model>');
    assert.ok(hint.includes('<codex-model>'), hint);
    assert.ok(hint.includes(join(dir, 'config.toml')), hint);
  });

  it('gives Codex model-specific guidance when sample generation hits an unsupported model', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-codex-model-hint-'));
    await writeFile(join(dir, 'config.toml'), 'model = "gpt-5.5"\n');

    const hint = formatSampleGenerationFailureHint(
      `{"type":"error","status":400,"error":{"message":"The 'gpt-5' model is not supported when using Codex with a ChatGPT account."}}`,
      'codex',
      'zh',
      { CODEX_HOME: dir },
    );

    assert.ok(hint.includes('模型名看起来不可用'), hint);
    assert.ok(hint.includes('--executor codex --model gpt-5.5'), hint);
    assert.ok(hint.includes('codex exec -m gpt-5.5 "hi"'), hint);
    assert.ok(hint.includes('--executor claude --model sonnet'), hint);
  });
});
