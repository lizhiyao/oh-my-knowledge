import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, vi } from 'vitest';
import EvalCommand from '../../src/cli/commands/eval/index.js';
import { runCommand } from '../helpers/run-command.js';
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
  vi.unstubAllGlobals();
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
      (error: unknown) => error instanceof Error && error.message.includes('Codex executor needs an explicit model')
        && 'oclif' in error && (error.oclif as { exit: number }).exit === 2,
    );
  });

  it.each(['codex', 'codex-sdk', 'openai-api', 'anthropic-api', '/custom/executor'])('uses the selected task model for %s judges', (executor) => {
    assert.equal(defaultJudgeModel(executor, 'explicit-task'), 'explicit-task');
    assert.equal(defaultJudgeModel('claude', 'sonnet'), 'haiku');
    assert.equal(defaultJudgeModel('claude-sdk', 'opus'), 'haiku');
  });

  it.each(['openai-api', 'anthropic-api', '/custom/executor'])('requires an explicit model for %s and preserves overrides', (executor) => {
    assert.throws(() => resolveRuntimeSelection({ executor }, { env: {}, lang: 'en' }),
      (error: unknown) => error instanceof Error && 'oclif' in error
        && (error.oclif as { exit: number }).exit === 2);
    assert.deepEqual(resolveRuntimeSelection({ executor }, { env: { OMK_MODEL: 'env-model' } }),
      { executor, model: 'env-model', judgeModel: 'env-model' });
    assert.deepEqual(resolveRuntimeSelection({ executor, model: 'explicit-model' }, { env: { OMK_MODEL: 'env-model' } }),
      { executor, model: 'explicit-model', judgeModel: 'explicit-model' });
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


describe('API runtime model wiring', () => {
  it.each(['openai-api', 'anthropic-api'])('%s carries the selected model into target and judge HTTP requests', async (executor) => {
    const root = mkdtempSync(join(tmpdir(), 'omk-api-model-wiring-'));
    tempDirs.push(root);
    const samples = join(root, 'eval-samples.json');
    const skill = join(root, 'review.md');
    writeFileSync(skill, '# Review\nGive an accurate answer.\n');
    writeFileSync(samples, JSON.stringify({
      schemaVersion: 'omk.eval-sample-set/v2',
      samples: [{ sample_id: 'model-check', prompt: 'Say Paris.', rubric: { accuracy: { criterion: 'Paris is stated.', weight: 1 } } }],
    }));
    const requests: Array<{ model: string }> = [];
    vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as { model: string };
      requests.push(request);
      const text = '{"reasoning":"Paris is stated","score":5,"reason":"correct"}';
      return new Response(JSON.stringify(executor === 'openai-api' && String(_url).endsWith('/chat/completions') ? {
        id: 'chat_fixture', model: request.model, choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      } : executor === 'openai-api' ? {
        id: 'resp_fixture', object: 'response', model: request.model, status: 'completed',
        output: [{ id: 'msg_fixture', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      } : {
        id: 'msg_fixture', type: 'message', role: 'assistant', model: request.model,
        content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { headers: { 'content-type': 'application/json' } });
    });
    const result = await runCommand(EvalCommand, [
      '--control', 'baseline', '--treatment', skill, '--samples', samples,
      '--executor', executor, '--model', 'selected-model', '--skip-connectivity', '--skip-doctor',
      '--no-serve', '--no-diagnostic', '--bootstrap-samples', '100', '--report-only',
    ], { cwd: root, env: {
      HOME: root, USERPROFILE: root, OMK_HOME: join(root, 'machine'),
      OPENAI_API_KEY: 'fixture-key', ANTHROPIC_API_KEY: 'fixture-key',
      OMK_JUDGE_MODELS: '', OMK_MODEL: '',
    } }).catch((error: { stderr: string }) => { throw new Error(error.stderr); });
    const output = JSON.parse(result.stdout) as { status: { runStatus: string; evidenceStatus: string } };
    assert.equal(output.status.runStatus, 'completed', result.stderr);
    assert.equal(output.status.evidenceStatus, 'complete', result.stderr);
    assert.ok(requests.length >= 4, 'two target executions plus their rubric judge requests');
    assert.deepEqual([...new Set(requests.map((request) => request.model))], ['selected-model']);
  });
});
