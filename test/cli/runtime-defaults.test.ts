import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'vitest';
import { prepareCliEvaluation } from '../../src/cli/lib/prepare-evaluation.js';
import {
  defaultJudgeModel,
  resolveCliExecutor,
  resolveCliModel,
  resolveRuntimeSelection,
} from '../../src/cli/lib/runtime-defaults.js';

const tempDirs: string[] = [];

function codexEnv(model = 'gpt-test'): NodeJS.ProcessEnv {
  const root = mkdtempSync(join(tmpdir(), 'omk-codex-runtime-'));
  tempDirs.push(root);
  mkdirSync(join(root, '.codex'), { recursive: true });
  writeFileSync(join(root, '.codex', 'config.toml'), `model = "${model}"\n`);
  return {
    PATH: '/test/bin',
    CODEX_HOME: join(root, '.codex'),
    CODEX_THREAD_ID: 'thread-test',
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Codex-first CLI runtime defaults', () => {
  it('keeps an explicit executor and model authoritative', () => {
    const runtime = resolveRuntimeSelection(
      { executor: 'claude-sdk', model: 'opus' },
      { env: codexEnv() },
    );
    assert.deepEqual(runtime, {
      executor: 'claude-sdk',
      model: 'opus',
      judgeModel: 'haiku',
    });
  });

  it('selects codex in a Codex host and reads the configured model', () => {
    const runtime = resolveRuntimeSelection({}, { env: codexEnv('gpt-codex-configured') });
    assert.deepEqual(runtime, {
      executor: 'codex',
      model: 'gpt-codex-configured',
      judgeModel: 'gpt-codex-configured',
    });
  });

  it('selects codex when it is the only installed agent CLI', () => {
    const env = { PATH: '/test/bin', CODEX_HOME: codexEnv().CODEX_HOME };
    const executor = resolveCliExecutor(undefined, {
      env,
      commandExists: (command) => command === 'codex',
    });
    assert.equal(executor, 'codex');
  });

  it('keeps the legacy claude default when both CLIs exist outside a Codex host', () => {
    const executor = resolveCliExecutor(undefined, {
      env: { PATH: '/test/bin' },
      commandExists: () => true,
    });
    assert.equal(executor, 'claude');
  });

  it('supports OMK_EXECUTOR and OMK_MODEL as environment preferences', () => {
    const runtime = resolveRuntimeSelection({}, {
      env: {
        PATH: '/test/bin',
        OMK_EXECUTOR: 'codex-sdk',
        OMK_MODEL: 'gpt-env',
      },
    });
    assert.deepEqual(runtime, {
      executor: 'codex-sdk',
      model: 'gpt-env',
      judgeModel: 'gpt-env',
    });
  });

  it('does not pass a Claude model alias to Codex when no model is configured', () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-codex-no-model-'));
    tempDirs.push(root);
    const env = { PATH: '/test/bin', CODEX_HOME: root };
    assert.throws(
      () => resolveCliModel('codex', undefined, { env, lang: 'en' }),
      /Codex executor needs an explicit model/,
    );
  });

  it('uses the task model as the Codex judge default', () => {
    assert.equal(defaultJudgeModel('codex', 'gpt-task'), 'gpt-task');
    assert.equal(defaultJudgeModel('codex-sdk', 'gpt-task'), 'gpt-task');
    assert.equal(defaultJudgeModel('claude', 'sonnet'), 'haiku');
  });

  it('applies the Codex runtime to eval task and judge defaults together', () => {
    const env = codexEnv('gpt-eval');
    const { request } = prepareCliEvaluation({
      control: 'baseline',
      treatment: 'demo',
      samples: 'eval-samples.json',
    }, {
      env,
      commandExists: (command) => command === 'codex',
    });
    assert.equal(request.values.targetRuntime.executorId, 'codex');
    assert.equal(request.values.targetRuntime.model, 'gpt-eval');
    assert.deepEqual(request.values.judges.members, [{ executorId: 'codex', model: 'gpt-eval' }]);
  });

  it('allows OMK_JUDGE_MODELS to override the inferred judge only', () => {
    const env = {
      ...codexEnv('gpt-task'),
      OMK_JUDGE_MODELS: 'openai-api:gpt-judge',
    };
    const { request } = prepareCliEvaluation({
      control: 'baseline',
      treatment: 'demo',
      samples: 'eval-samples.json',
    }, { env });
    assert.equal(request.values.targetRuntime.executorId, 'codex');
    assert.equal(request.values.targetRuntime.model, 'gpt-task');
    assert.deepEqual(request.values.judges.members, [{ executorId: 'openai-api', model: 'gpt-judge' }]);
  });
});
