import { it } from 'vitest';
import assert from 'node:assert/strict';
import { codexCliExecutor } from '../../src/executors/openai/codex/cli.js';
import { codexSdkExecutor } from '../../src/executors/openai/codex/sdk.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { createScriptExecutor } from '../../src/executors/script/index.js';

it('refuses unprovable Codex skill isolation before opening either runtime, including an empty cwd', async () => {
  for (const execute of [codexCliExecutor, codexSdkExecutor]) {
    for (const allowedSkills of [[], ['one'], ['one', 'two']]) {
      for (const cwd of [undefined, '', '/tmp/isolated']) {
        await assert.rejects(() => execute({ model: 'fixture', prompt: '', cwd, allowedSkills }), /不支持显式 allowedSkills 隔离/);
      }
    }
  }
});

it('rejects unsupported output capabilities on direct SDK and custom adapters before opening a runtime', async () => {
  for (const execute of [codexSdkExecutor, createScriptExecutor('codex')]) {
    for (const request of [{ outputFormat: { mode: 'prompt-json' } as const }, { maxOutputTokens: 10 }]) {
      await assert.rejects(() => execute({ model: 'fixture', prompt: '', ...request }), /不支持/);
    }
  }
});

it('keeps a private schema available to the actual child and cleans it after success, failure, cancellation and timeout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'omk-codex-schema-fixture-'));
  const bin = join(root, 'bin'); mkdirSync(bin);
  const cwd = join(root, 'empty'); mkdirSync(cwd);
  const capture = join(root, 'capture.json');
  const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };
  writeFileSync(join(bin, 'codex'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const schemaPath = args[args.indexOf('--output-schema') + 1];
const capture = { schemaPath, schema: JSON.parse(fs.readFileSync(schemaPath, 'utf8')), mode: fs.statSync(schemaPath).mode & 0o777, args };
console.log(JSON.stringify({type:'item.completed',item:{id:'answer',type:'agent_message',text:'original partial answer'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:12,cached_input_tokens:2,output_tokens:3}}));
fs.writeFileSync(process.env.OMK_SCHEMA_FIXTURE_CAPTURE, JSON.stringify(capture));
if (process.env.OMK_SCHEMA_FIXTURE_OUTCOME === 'success') process.exit(0);
if (process.env.OMK_SCHEMA_FIXTURE_OUTCOME === 'failure') process.exit(2);
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`, { mode: 0o700 });
  try {
    for (const reason of [null, undefined, 'stopped', 42, { failureKind: 'buffer-limit', stdout: 3, stderr: 4 }]) {
      const controller = new AbortController(); controller.abort(reason);
      const result = await codexCliExecutor({ model: 'fixture', prompt: '', cwd, abortSignal: controller.signal,
        outputFormat: { mode: 'json-schema', name: 'fixture', schema } },
      { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, OMK_SCHEMA_FIXTURE_CAPTURE: capture });
      assert.equal(result.ok, false); assert.equal(result.failure?.failureKind, 'cancelled');
      assert.equal(existsSync(capture), false);
      assert.deepEqual(readdirSync(cwd), []);
    }
    for (const outcome of ['success', 'failure', 'cancel', 'timeout']) {
      rmSync(capture, { force: true });
      const controller = new AbortController();
      const promise = codexCliExecutor({ model: 'fixture', prompt: '-JSON input', cwd, abortSignal: controller.signal,
        timeoutMs: outcome === 'timeout' ? 1000 : 5000, outputFormat: { mode: 'json-schema', name: 'fixture', schema } },
      { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, OMK_SCHEMA_FIXTURE_CAPTURE: capture, OMK_SCHEMA_FIXTURE_OUTCOME: outcome });
      try {
        if (outcome === 'cancel') {
          const deadline = Date.now() + 3000;
          while (!existsSync(capture) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
          assert.equal(existsSync(capture), true);
          controller.abort();
        }
        const result = await promise;
        const observed = JSON.parse(readFileSync(capture, 'utf8'));
        assert.deepEqual(observed.schema, schema);
        assert.equal(observed.mode, 0o600);
        assert.equal(observed.args.at(-2), '--');
        assert.equal(observed.args.at(-1), '-JSON input');
        assert.equal(existsSync(dirname(observed.schemaPath)), false);
        assert.deepEqual(readdirSync(cwd), []);
        assert.equal(result.ok, outcome === 'success');
        assert.equal(result.output, 'original partial answer');
        assert.equal(result.inputTokens, 10);
        assert.equal(result.cacheReadTokens, 2);
        assert.equal(result.outputTokens, 3);
        if (outcome === 'cancel') assert.equal(result.failure?.failureKind, 'cancelled');
        if (outcome === 'timeout') assert.equal(result.failure?.failureKind, 'timeout');
      } finally {
        controller.abort();
        await promise;
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
