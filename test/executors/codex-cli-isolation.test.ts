import { it } from 'vitest';
import assert from 'node:assert/strict';
import { codexCliExecutor } from '../../src/executors/openai/codex/cli.js';
import { codexSdkExecutor } from '../../src/executors/openai/codex/sdk.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { createScriptExecutor } from '../../src/executors/script/index.js';
import { createCodexArchiveProducer } from '../../src/executors/openai/codex/archive.js';
import { MAX_BUFFER } from '../../src/executors/core/limits.js';
import { createExecutor } from '../../src/executors/index.js';
import { createHash } from 'node:crypto';

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

it('retains real process and terminal diagnostics with partial evidence and schema cleanup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'omk-codex-schema-fixture-'));
  const bin = join(root, 'bin'); mkdirSync(bin);
  const cwd = join(root, 'empty'); mkdirSync(cwd);
  const capture = join(root, 'capture.json');
  const privateCwd = mkdtempSync(join(tmpdir(), 'omk-knowledge-text-'));
  const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };
  writeFileSync(join(bin, 'codex'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const outcome = process.env.OMK_SCHEMA_FIXTURE_OUTCOME;
const schemaPath = args[args.indexOf('--output-schema') + 1];
const capture = { schemaPath, schema: JSON.parse(fs.readFileSync(schemaPath, 'utf8')), mode: fs.statSync(schemaPath).mode & 0o777, args };
// The parent may cancel as soon as capture exists; publish only a complete snapshot.
const publishCapture = () => {
  const temporary = process.env.OMK_SCHEMA_FIXTURE_CAPTURE + '.pending';
  fs.writeFileSync(temporary, JSON.stringify(capture));
  fs.renameSync(temporary, process.env.OMK_SCHEMA_FIXTURE_CAPTURE);
};
if (outcome === 'amplify') {
  process.stdout.write(Buffer.concat([Buffer.from('{"type":"item.completed","item":{"id":"x","type":"mcp__'), Buffer.alloc(1024, 0xff), Buffer.from('__x"}}\\n')]));
  process.stderr.write(Buffer.concat([Buffer.alloc(1024), Buffer.from(' Bearer a Basic b ' + process.env.EXAMPLE_API_KEY)]));
  publishCapture();
  process.exit(2);
}
process.on('SIGTERM', () => process.exit(0));
if (outcome === 'reconnect') console.log(JSON.stringify({type:'error',message:'Reconnecting... waiting for network (Connection failed: error sending request)'}));
console.log(JSON.stringify({type:'item.completed',item:{id:'answer',type:'agent_message',text:'original partial answer'}}));
if (outcome !== 'missing-terminal') console.log(JSON.stringify({type:outcome === 'failed-turn' ? 'turn.failed' : 'turn.completed',
  ...(outcome === 'failed-turn' ? {error:{message:'terminal provider failure'}} : {}),
  usage:{input_tokens:12,cached_input_tokens:2,output_tokens:3}}));
publishCapture();
if (outcome === 'failure') { console.error('fixture process stderr'); process.exit(2); }
if (outcome !== 'cancel' && outcome !== 'timeout') process.exit(0);
setInterval(() => {}, 1000);
`, { mode: 0o700 });
  try {
    for (const reason of [null, undefined, 'stopped', 42, { failureKind: 'buffer-limit', stdout: 3, stderr: 4 }]) {
      const controller = new AbortController(); controller.abort(reason);
      const result = await codexCliExecutor({ model: 'fixture', prompt: '', cwd, abortSignal: controller.signal,
        outputFormat: { mode: 'json-schema', name: 'fixture', schema } },
      { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, OMK_SCHEMA_FIXTURE_CAPTURE: capture });
      assert.equal(result.ok, false); assert.equal(result.failure?.failureKind, 'cancelled');
      assert.ok(result.error?.endsWith('[codex-cli terminalType=none; terminalCount=0; processCode=unknown; processSignal=unknown; processFailure=unknown; killedByTimeout=unknown; killedBySignal=unknown]'));
      assert.equal(existsSync(capture), false);
      assert.deepEqual(readdirSync(cwd), []);
    }
    for (const outcome of ['success', 'reconnect', 'failure', 'failed-turn', 'missing-terminal', 'cancel', 'timeout', 'amplify']) {
      rmSync(capture, { force: true });
      const controller = new AbortController();
      const request = { model: 'fixture', prompt: '-JSON input', timeoutMs: outcome === 'timeout' ? 1000 : 5000,
        outputFormat: { mode: 'json-schema' as const, name: 'fixture', schema } };
      const producer = createCodexArchiveProducer({ PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
        OMK_SCHEMA_FIXTURE_CAPTURE: capture, OMK_SCHEMA_FIXTURE_OUTCOME: outcome, EXAMPLE_API_KEY: 'long-fixture-credential' });
      if (outcome === 'success') {
        let refusedGates = 0;
        const refused = producer.configure('codex', request, () => { refusedGates++; throw new Error('reservation refused'); });
        await assert.rejects(() => refused.execute({ ...request, cwd: privateCwd }), /reservation refused/);
        assert.equal(refusedGates, 1); assert.equal(existsSync(capture), false); assert.deepEqual(readdirSync(privateCwd), []);
      }
      let dispatchGates = 0;
      const configured = producer.configure('codex', request, () => { dispatchGates++; assert.equal(existsSync(capture), false); });
      assert.ok(configured.evidence.maxOutcomeJsonBytes > 256 * 1024 * 1024);
      assert.ok(configured.evidence.maxOutcomeJsonBytes < 512 * 1024 * 1024);
      const promise = configured.execute({ ...request, cwd: privateCwd, abortSignal: controller.signal });
      try {
        if (outcome === 'cancel') {
          const deadline = Date.now() + 3000;
          while (!existsSync(capture) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
          assert.equal(existsSync(capture), true);
          controller.abort();
        }
        const result = await promise;
        assert.equal(dispatchGates, 1);
        const observed = JSON.parse(readFileSync(capture, 'utf8'));
        assert.deepEqual(observed.schema, schema);
        assert.equal(observed.mode, 0o600);
        assert.equal(observed.args.at(-2), '--');
        assert.equal(observed.args.at(-1), '-JSON input');
        assert.equal(existsSync(dirname(observed.schemaPath)), false);
        assert.deepEqual(readdirSync(cwd), []);
        assert.deepEqual(readdirSync(privateCwd), []);
        const successful = outcome === 'success' || outcome === 'reconnect';
        assert.equal(result.ok, successful);
        if (successful) {
          assert.equal(result.error, undefined);
          assert.equal(result.stopReason, 'end_turn');
        } else {
          const diagnostic = result.error?.match(/\[codex-cli [^\]]+\]$/)?.[0];
          assert.ok(diagnostic);
          assert.ok(Buffer.byteLength(diagnostic) <= 512);
          const terminalType = outcome === 'missing-terminal' || outcome === 'amplify' ? 'none'
            : outcome === 'failed-turn' ? 'turn.failed' : 'turn.completed';
          const processFailure = outcome === 'failure' || outcome === 'amplify' ? 'nonzero-exit'
            : outcome === 'cancel' ? 'abort' : outcome === 'timeout' ? 'timeout' : 'none';
          assert.equal(diagnostic, `[codex-cli terminalType=${terminalType}; terminalCount=${terminalType === 'none' ? 0 : 1}; `
            + `processCode=${outcome === 'failure' || outcome === 'amplify' ? 2 : 0}; processSignal=null; `
            + `processFailure=${processFailure}; killedByTimeout=${outcome === 'timeout'}; killedBySignal=${outcome === 'cancel' ? 'SIGTERM' : 'null'}]`);
        }
        assert.ok(Buffer.byteLength(JSON.stringify({ outcomeKind: 'result', result })) < configured.evidence.maxOutcomeJsonBytes);
        if (outcome === 'amplify') {
          assert.equal(result.failure?.failureKind, 'invalid_response');
          assert.equal(result.toolCalls?.length, 1);
          assert.deepEqual(result.turns?.[0].toolCalls, result.toolCalls);
          assert.equal(result.toolCalls?.[0].sourceTool, `mcp__${'\ufffd'.repeat(1024)}__x`);
          assert.ok(result.error?.includes('\0'.repeat(1024)));
          assert.ok(result.error?.includes('Bearer [REDACTED] Basic [REDACTED] [REDACTED]'));
          assert.equal(result.error?.includes('long-fixture-credential'), false);
          assert.ok(Buffer.byteLength(JSON.stringify(result)) > 27 * 1024);
          continue;
        }
        assert.equal(result.output, 'original partial answer');
        assert.equal(result.inputTokens, outcome === 'missing-terminal' ? 0 : 10);
        assert.equal(result.cacheReadTokens, outcome === 'missing-terminal' ? 0 : 2);
        assert.equal(result.outputTokens, outcome === 'missing-terminal' ? 0 : 3);
        if (outcome === 'failure') assert.match(result.error ?? '', /^fixture process stderr;/);
        if (outcome === 'failed-turn') assert.match(result.error ?? '', /terminal provider failure/);
        if (outcome === 'missing-terminal') assert.match(result.error ?? '', /no turn.completed\/turn.failed event/);
        if (outcome === 'cancel') assert.equal(result.failure?.failureKind, 'cancelled');
        if (outcome === 'timeout') assert.equal(result.failure?.failureKind, 'timeout');
      } finally {
        controller.abort();
        await promise;
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(privateCwd, { recursive: true, force: true }); }
});

it('proves a frozen Codex return profile and rejects unbound configuration before executor creation or dispatch', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'omk-knowledge-text-'));
  const schema = { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false };
  const request = { model: 'fixture', system: 'frozen rules', prompt: 'selected text', timeoutMs: 5000,
    outputFormat: { mode: 'json-schema' as const, name: 'fixture', schema } };
  const environment = { PATH: 'frozen-path', EXAMPLE_API_KEY: 'long-frozen-credential' };
  let creates = 0, calls = 0;
  const producer = createCodexArchiveProducer(environment, (name, options) => {
    creates++; assert.equal(name, 'codex'); assert.equal(options.env.PATH, 'frozen-path');
    assert.equal(Object.isFrozen(options.env), true);
    return async input => {
      calls++; assert.equal(input.prompt, request.prompt); assert.equal(input.cwd, cwd);
      assert.equal(input.outputFormat?.mode, 'json-schema');
      if (input.outputFormat?.mode === 'json-schema') assert.equal(Object.isFrozen(input.outputFormat.schema), true);
      return { ok: false, output: 'original partial result', durationMs: -500, durationApiMs: 0,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
        tokenUsageReportedByExecutor: false, costUSD: 0, costReportedByExecutor: false,
        stopReason: 'error', numTurns: 0, failure: { failureKind: 'invalid_response' } };
    };
  });
  try {
    environment.PATH = 'caller-mutated-path';
    const evidence = producer.inspect('codex', request);
    assert.equal(creates, 0); assert.equal(calls, 0);
    assert.deepEqual(evidence.sourceChannels.slice(0, 2).map(channel => channel.maxBytes), [MAX_BUFFER, MAX_BUFFER]);
    assert.match(evidence.producerRevision, /^sha256:[a-f0-9]{64}$/);
    for (const [path, expected] of Object.entries((evidence.proof as { sourceDigests: Record<string, string> }).sourceDigests)) {
      assert.equal(createHash('sha256').update(readFileSync(new URL(`../../${path}`, import.meta.url))).digest('hex'), expected,
        `Codex archive proof premise changed: ${path}`);
    }
    assert.equal(producer.inspect('codex', { ...request, prompt: 'different bytes' }).producerRevision, evidence.producerRevision);
    assert.notDeepEqual(producer.inspect('codex', { ...request, prompt: 'different bytes' }).proof, evidence.proof);
    for (const invalid of [{ ...request, maxOutputTokens: 1 }, { ...request, prompt: 'bad\0argv' },
      { ...request, skillDir: '/unbound/discovery' }, { ...request, cwd }, { ...request, model: ' ' },
      { ...request, prompt: '界'.repeat(350_000) }, { ...request, timeoutMs: Infinity }]) {
      assert.throws(() => producer.configure('codex', invalid));
    }
    assert.throws(() => producer.configure('codex-sdk', request), /requires codex/);
    const short = createCodexArchiveProducer({ EXAMPLE_API_KEY: 'short' }, createExecutor);
    assert.throws(() => short.inspect('codex', request), /short credential/);
    const huge = createCodexArchiveProducer({ VALUE: 'x'.repeat(256 * 1024) }, createExecutor);
    assert.throws(() => huge.inspect('codex', request), /environment capacity/);
    let accessorCalls = 0;
    const accessor = Object.defineProperty({}, 'type', { enumerable: true, get() { accessorCalls++; return 'object'; } });
    assert.throws(() => producer.configure('codex', { ...request, outputFormat: { ...request.outputFormat, schema: accessor } }), /accessors/);
    const hooked = { toJSON() { accessorCalls++; return {}; } };
    assert.throws(() => producer.configure('codex', { ...request, outputFormat: { ...request.outputFormat, schema: hooked } }), /serialization hooks/);
    let deep: Record<string, unknown> = {};
    for (let index = 0; index < 130; index++) deep = { nested: deep };
    assert.throws(() => producer.configure('codex', { ...request, outputFormat: { ...request.outputFormat, schema: deep } }), /schema depth/);
    assert.equal(accessorCalls, 0); assert.equal(creates, 0);
    let gates = 0;
    const configured = producer.configure('codex', request, () => { gates++; });
    assert.equal(creates, 1); assert.equal(calls, 0);
    await assert.rejects(() => configured.execute({ ...request, cwd, prompt: 'drifted bytes' }), /identity conflict/);
    await assert.rejects(() => configured.execute({ ...request, cwd: dirname(cwd) }), /private cwd/);
    await assert.rejects(() => configured.execute({ ...request, cwd, abortSignal: AbortSignal.abort() }));
    assert.equal(calls, 0); assert.equal(gates, 0);
    const result = await configured.execute({ ...request, cwd });
    assert.equal(result.output, 'original partial result'); assert.equal(result.durationMs, -500); assert.equal(calls, 1); assert.equal(gates, 1);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
