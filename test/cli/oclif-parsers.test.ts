import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import Eval from '../../src/cli/commands/eval/index.js';
import { DEFAULT_EVALUATION_GATE_THRESHOLD } from '../../src/eval-workflows/evaluation-defaults.js';
import EvalGoldCompare from '../../src/cli/commands/eval/gold/compare.js';
import Doctor from '../../src/cli/commands/doctor.js';
import Evolve from '../../src/cli/commands/evolve.js';
import Sample from '../../src/cli/commands/sample.js';
import Studio from '../../src/cli/commands/studio.js';
import ObserveInbox from '../../src/cli/commands/observe/inbox.js';

interface FlagLike {
  parse?: unknown;
  description?: unknown;
}

type FlagMap = Record<string, FlagLike>;
type ParseFn = (input: string) => Promise<string>;

function flagsOf(commandFlags: unknown): FlagMap {
  return commandFlags as FlagMap;
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parserFor(flags: FlagMap, name: string): ParseFn {
  const parse = flags[name]?.parse;
  assert.equal(typeof parse, 'function', `${name} should define a parser`);
  return parse as ParseFn;
}

async function assertParserWired(flags: FlagMap, name: string, invalidValue: string): Promise<void> {
  await assert.rejects(
    () => parserFor(flags, name)(invalidValue),
    new RegExp(`--${escapeRegex(name)}`),
    `${name} parser should report its flag name`,
  );
}

describe('oclif custom parsers', () => {
  it('wires every intended parser onto command flags', async () => {
    for (const name of [
      'concurrency',
      'retry',
      'repeat',
      'judge-repeat',
      'bootstrap-samples',
    ]) {
      await assertParserWired(flagsOf(Eval.flags), name, '1.5');
    }
    for (const name of [
      'timeout',
      'budget-usd',
      'budget-per-sample-usd',
      'budget-per-sample-ms',
      'threshold',
      'trivial-diff',
    ]) {
      await assertParserWired(flagsOf(Eval.flags), name, 'not-a-number');
    }
    await assertParserWired(flagsOf(Eval.flags), 'effort', 'turbo');

    for (const name of ['repeat', 'concurrency']) {
      await assertParserWired(flagsOf(Doctor.flags), name, '1.5');
    }
    await assertParserWired(flagsOf(Doctor.flags), 'effort', 'turbo');

    for (const name of ['rounds', 'concurrency']) {
      await assertParserWired(flagsOf(Evolve.flags), name, '1.5');
    }
    for (const name of ['target', 'timeout']) {
      await assertParserWired(flagsOf(Evolve.flags), name, 'not-a-number');
    }
    await assertParserWired(flagsOf(Evolve.flags), 'effort', 'turbo');

    await assertParserWired(flagsOf(Sample.flags), 'count', '1.5');
    await assertParserWired(flagsOf(Studio.flags), 'port', '1.5');
    await assertParserWired(flagsOf(ObserveInbox.flags), 'limit', '1.5');
    await assertParserWired(flagsOf(ObserveInbox.flags), 'explore', '1.5');
    await assertParserWired(flagsOf(EvalGoldCompare.flags), 'bootstrap-samples', '1.5');
    await assertParserWired(flagsOf(EvalGoldCompare.flags), 'seed', '1.5');
  });

  it('checks inclusive integer boundaries', async () => {
    const parsePort = parserFor(flagsOf(Studio.flags), 'port');
    assert.equal(await parsePort('0'), '0');
    assert.equal(await parsePort('65535'), '65535');
    await assert.rejects(() => parsePort('-1'), /--port.*0.*65535/);
    await assert.rejects(() => parsePort('65536'), /--port.*0.*65535/);

    const parseDoctorRepeat = parserFor(flagsOf(Doctor.flags), 'repeat');
    assert.equal(await parseDoctorRepeat('1'), '1');
    assert.equal(await parseDoctorRepeat('10'), '10');
    await assert.rejects(() => parseDoctorRepeat('0'), /--repeat.*1.*10/);
    await assert.rejects(() => parseDoctorRepeat('11'), /--repeat.*1.*10/);
  });

  it('keeps the --threshold help text wired to the shared Core input default', () => {
    // 裸字面量,常量调整后用户会读到错误默认值。断言 help 里出现的就是常量插值结果,
    // 防止有人把它退回成硬编码。
    const description = flagsOf(Eval.flags).threshold?.description;
    assert.equal(typeof description, 'string', 'threshold flag should carry a help description');
    assert.ok(
      (description as string).includes(String(DEFAULT_EVALUATION_GATE_THRESHOLD)),
      `--threshold help 应反映默认值(${DEFAULT_EVALUATION_GATE_THRESHOLD})，实际为:${String(description)}`,
    );
  });

  it('rejects non-decimal number literals', async () => {
    const parseThreshold = parserFor(flagsOf(Eval.flags), 'threshold');
    assert.equal(await parseThreshold('0.5'), '0.5');
    await assert.rejects(() => parseThreshold('0x10'), /--threshold/);
    await assert.rejects(() => parseThreshold('1e3'), /--threshold/);
  });

  it('distinguishes positive caps from zero-tolerance values', async () => {
    const parseBudget = parserFor(flagsOf(Eval.flags), 'budget-usd');
    const parseDurationBudget = parserFor(flagsOf(Eval.flags), 'budget-per-sample-ms');
    const parseTrivialDiff = parserFor(flagsOf(Eval.flags), 'trivial-diff');
    assert.equal(await parseBudget('0.0001'), '0.0001');
    await assert.rejects(() => parseBudget('0'), /--budget-usd[\s\S]*大于 0/);
    assert.equal(await parseDurationBudget('1'), '1');
    await assert.rejects(() => parseDurationBudget('1.5'), /--budget-per-sample-ms/);
    assert.equal(await parseTrivialDiff('0'), '0');
  });

  it('checks target score bounds', async () => {
    const parseTarget = parserFor(flagsOf(Evolve.flags), 'target');
    assert.equal(await parseTarget('0'), '0');
    assert.equal(await parseTarget('5'), '5');
    await assert.rejects(() => parseTarget('-1'), /--target.*0.*5/);
    await assert.rejects(() => parseTarget('1000'), /--target.*0.*5/);
  });

  it('keeps bootstrap seed non-negative', async () => {
    const parseSeed = parserFor(flagsOf(EvalGoldCompare.flags), 'seed');
    assert.equal(await parseSeed('0'), '0');
    await assert.rejects(() => parseSeed('-1'), /--seed[\s\S]*0/);
  });
});
