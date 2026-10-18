import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareEntityLinkLive, executeEntityLinkLive, checkEntityLinkLive, parseEntityLinkLiveArguments,
  type EntityLinkLiveRuntime, type EntityLinkLiveRequest } from '../../scripts/bench/entity-link-live.js';
import { reviewDigest } from '../../scripts/bench/entity-extraction-review.js';
import { ENTITY_LINK_CORPUS_VERSION, ENTITY_LINK_GUIDE_VERSION, ENTITY_LINK_CHECK_VERSION } from '../../scripts/bench/entity-link-review-corpus.js';
import { canonicalLinkReview, EntityLinkMeasurementIdentitySchema } from '../../scripts/bench/entity-link-review.js';
import { canonicalJson } from '../../src/knowledge/store.js';
import { EntityLinkModelInputSchema, EntityLinkExecutionOutcomeSchema } from '../../src/knowledge/entities/link-invocation.js';
import { checkEntityLinkSuggestion } from '../../src/knowledge/entities/links.js';
import { createEntityLinkExecutionRequest, configuredEntityLinkExecutor } from '../../src/knowledge/adapters/entity-link-executor.js';
import { ENTITY_LINK_PROMPT, ENTITY_LINK_PROMPT_HASH, ENTITY_LINK_PROMPT_VERSION, ENTITY_LINK_RESPONSE_JSON_SCHEMA,
  ENTITY_LINK_RESPONSE_SCHEMA_HASH } from '../../src/knowledge/entity-linking/entity-link-prompt.js';
import { assertExecutorInputCapabilities } from '../../src/executors/core/capabilities.js';
import { observeExtractionException } from '../../src/knowledge/extraction/generation.js';
import type { ExecutorFn } from '../../src/executors/contracts/ports.js';

let root: string, repository: string, bundle: string, output: string;
const uuid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const hash = (name: string) => reviewDigest(name);
const host = { runtimeDigest: hash('runtime'), checkerDigest: hash('checker'), dependencyDigest: hash('dependencies'), nodeVersion: process.versions.node,
  validatorVersion: 'fixture-zod-version', validatorDigest: hash('actual zod runtime'),
  nodeBinaryDigest: hash('node binary'), codexBinaryDigest: hash('codex binary'), codexBinaryPath: '/fixed/test/codex', runnerDigest: hash('runner') };
function input(index: number) {
  const side = (number: number) => {
    const entityId = uuid(number), mentionId = uuid(number + 1), quote = `Alpha ${number}`;
    return { binding: { analysisId: uuid(number + 2), entityId, entityRevisionId: uuid(number + 3), generation: 1, snapshotId: uuid(number + 4),
      sourceVersion: hash(`source ${number}`), owner: null, mentionIds: [mentionId] },
    entity: { entityId, label: quote, description: `来源 ${number} 的完整实体描述`, qualifiers: [], identityStatus: 'proposed' as const,
      possibleEntityIds: [], uncertainties: [], referentKind: 'object' as const, componentRef: null, collection: null },
    mentions: [{ mentionId, entityId, selection: { evidenceRef: `case-${index}:record-${number}`, start: 0, end: quote.length, quote },
      basis: 'explicit' as const, rationale: '逐字来源' }], limitations: ['仅使用选定来源，不补充窗口外事实。'] };
  };
  return EntityLinkModelInputSchema.parse({ protocolId: 'entity-link-model-input/v1', left: side(index * 20 + 1), right: side(index * 20 + 11) });
}
const corpus = { corpusVersion: ENTITY_LINK_CORPUS_VERSION, guideVersion: ENTITY_LINK_GUIDE_VERSION, provenance: 'synthetic', authors: ['test-ai-author'],
  cases: Array.from({ length: 6 }, (_, index) => ({ caseId: `case-${index}`, projectGroup: `project-${index}`, conversationGroup: `conversation-${index}`,
    split: index < 3 ? 'development' : 'validation', tags: ['synthetic'], input: input(index),
    expectedAssessment: (['same_object', 'different_objects', 'insufficient_evidence'] as const)[index % 3], referenceRationale: '模型输出前确定的来源判断。',
    semanticChecks: ['人工逐项核对语义。'], limitations: ['合成用例不代表真实分布。'] })) };
function native(prompt: string) {
  const parsed = EntityLinkModelInputSchema.parse(JSON.parse(prompt));
  return { ok: true, output: JSON.stringify({ responseKind: 'entity-link-suggestion', schemaVersion: 1,
    leftEntityId: parsed.left.binding.entityId, rightEntityId: parsed.right.binding.entityId, assessment: 'insufficient_evidence',
    leftMentionIds: parsed.left.binding.mentionIds, rightMentionIds: parsed.right.binding.mentionIds, rationale: '没有跨窗口连续性证据。' }),
  durationMs: 12, durationApiMs: 0, inputTokens: 13, outputTokens: 8, cacheReadTokens: 3, cacheCreationTokens: 0, tokenUsageReportedByExecutor: true,
  costUSD: 0, costReportedByExecutor: false, stopReason: 'completed', numTurns: 1 };
}
function runtime(run?: (prompt: string) => unknown | Promise<unknown>) {
  const calls = vi.fn(async (request: { prompt: string; cwd?: string | null }) => {
    expect(existsSync(join(output, 'reserved', `${JSON.parse(request.prompt).left.mentions[0].selection.evidenceRef.split(':')[0]}.json`))).toBe(true);
    expect(request.cwd).toContain('omk-entity-link-');
    expect(readdirSync(request.cwd!)).toEqual([]);
    return await (run ? run(request.prompt) : native(request.prompt));
  });
  const adapter: EntityLinkLiveRuntime = {
    host: vi.fn(async () => ({ ...host })), parseInput: value => EntityLinkModelInputSchema.parse(value),
    createRequest: (selection, value) => createEntityLinkExecutionRequest(selection, value) as unknown as EntityLinkLiveRequest,
    configure: vi.fn((request: EntityLinkLiveRequest) => configuredEntityLinkExecutor(request as unknown as ReturnType<typeof createEntityLinkExecutionRequest>, {
      assertCapabilities: assertExecutorInputCapabilities,
      create: () => calls as unknown as ExecutorFn,
    })),
    parseOutcome: value => EntityLinkExecutionOutcomeSchema.parse(value),
    parseSuggestion: (value, selected) => checkEntityLinkSuggestion(value, { left: selected.left.binding, right: selected.right.binding }),
    observeException: observeExtractionException,
  };
  return { adapter, calls };
}
const options = () => ({ repository, bundle, output, executor: 'codex' as const, model: 'gpt-6.1-sol', maxCalls: 3,
  caseIds: ['case-0', 'case-1', 'case-2'], split: 'development' as const });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omk-link-live-test-')); repository = join(root, 'repository'); bundle = join(root, 'bundle'); output = join(root, 'capture');
  mkdirSync(repository); mkdirSync(bundle); mkdirSync(join(bundle, 'inputs'));
  const guideEn = 'Frozen English annotation guide.\n', guideZh = '冻结的中文标注指南。\n';
  const identity = EntityLinkMeasurementIdentitySchema.parse({ measurementVersion: 'omk-entity-link-measurement/v1',
    corpusVersion: ENTITY_LINK_CORPUS_VERSION, guideVersion: ENTITY_LINK_GUIDE_VERSION, checkVersion: ENTITY_LINK_CHECK_VERSION,
    corpusDigest: hash(JSON.stringify(corpus)), guideDigest: hash(guideEn + '\0' + guideZh),
    ...Object.fromEntries(['runtimeDigest', 'checkerDigest', 'dependencyDigest', 'nodeVersion', 'validatorVersion', 'validatorDigest', 'nodeBinaryDigest']
      .map(field => [field, host[field as keyof typeof host]])),
    promptHash: ENTITY_LINK_PROMPT_HASH, promptVersion: ENTITY_LINK_PROMPT_VERSION, responseSchemaHash: ENTITY_LINK_RESPONSE_SCHEMA_HASH });
  const measurementId = hash(canonicalLinkReview(identity));
  writeFileSync(join(bundle, 'manifest.json'), JSON.stringify({ ...identity, measurementId, exploratoryReady: true }));
  writeFileSync(join(bundle, 'annotation-guide.en.md'), guideEn); writeFileSync(join(bundle, 'annotation-guide.zh.md'), guideZh);
  writeFileSync(join(bundle, 'corpus.json'), JSON.stringify(corpus)); writeFileSync(join(bundle, 'system.prompt.txt'), ENTITY_LINK_PROMPT);
  writeFileSync(join(bundle, 'response-schema.json'), canonicalJson(ENTITY_LINK_RESPONSE_JSON_SCHEMA));
  writeFileSync(join(bundle, 'self-review.json'), JSON.stringify({ selfReviewVersion: 'omk-entity-author-review/v1', measurementId,
    reviewer: 'test-ai-author', reviewedAt: '2020-01-01T00:00:00Z', reviewedBeforeOutputs: true,
    decisions: corpus.cases.map(sample => ({ caseId: sample.caseId, decision: 'approved', rationale: '在输出前核对了完整来源。' })) }));
  for (const sample of corpus.cases) writeFileSync(join(bundle, 'inputs', `${sample.caseId}.json`), canonicalJson(sample.input));
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('explicit Codex entity-link capture slots (fixture executor only)', () => {
  it('prepares without constructing an executor; binds selection, production requests and known limits', async () => {
    const { adapter, calls } = runtime(); const plan = await prepareEntityLinkLive(options(), adapter);
    expect(calls).not.toHaveBeenCalled(); expect(adapter.configure).not.toHaveBeenCalled();
    expect(plan).toMatchObject({ executor: 'codex', model: 'gpt-6.1-sol', maxCalls: 3, limits: 'OMK-invocations-only;no-provider-request-token-or-USD-cap' });
    expect(plan.slots.map(slot => slot.caseId)).toEqual(options().caseIds);
    expect(readdirSync(join(output, 'reserved'))).toEqual([]);
    const request = JSON.parse(readFileSync(join(output, 'requests', 'case-0.json'), 'utf8'));
    expect(request.maxOutputTokens).toBeUndefined(); expect(request.system).toBe(ENTITY_LINK_PROMPT); expect(request.prompt).not.toContain('expectedAssessment');
    await expect(executeEntityLinkLive({ repository, directory: output, confirmPlanId: hash('wrong') }, {}, adapter)).rejects.toThrow('confirmation');
    expect(adapter.configure).not.toHaveBeenCalled();
  });
  it('archives every full native result before admission and never redispatches successful slots', async () => {
    const { adapter, calls } = runtime(); const parse = adapter.parseOutcome;
    adapter.parseOutcome = value => { expect(readdirSync(join(output, 'native')).length).toBeGreaterThan(0); return parse(value); };
    const plan = await prepareEntityLinkLive(options(), adapter);
    const completed = await executeEntityLinkLive({ repository, directory: output, confirmPlanId: plan.planId }, {}, adapter);
    expect(completed).toMatchObject({ complete: true, stopped: false }); expect(calls).toHaveBeenCalledTimes(3);
    expect(completed.capture.records[0].result).toMatchObject({ captureStatus: 'output', usage: { inputTokens: 13, outputTokens: 8, cacheReadTokens: 3,
      reportedByExecutor: true, costReportedByExecutor: false, costUSD: null } });
    expect(completed.capture.records[0].result).not.toHaveProperty('costUSD');
    const archived = readFileSync(join(output, 'native', 'case-0.json'), 'utf8');
    expect(JSON.parse(archived).result).toEqual(native(canonicalJson(corpus.cases[0].input)));
    expect(await checkEntityLinkLive({ repository, directory: output }, adapter)).toMatchObject({ complete: true, stopped: false });
    await executeEntityLinkLive({ repository, directory: output, confirmPlanId: plan.planId }, {}, adapter);
    expect(calls).toHaveBeenCalledTimes(3); expect(readFileSync(join(output, 'native', 'case-0.json'), 'utf8')).toBe(archived);
  });
  it('treats a reserved slot without native evidence as unknown, stopping without retrying or starting later slots', async () => {
    const { adapter, calls } = runtime(); const plan = await prepareEntityLinkLive(options(), adapter), slot = plan.slots[0];
    writeFileSync(join(output, 'reserved', `${slot.caseId}.json`), JSON.stringify({ reservationVersion: 'omk-entity-link-live-reservation/v1',
      planId: plan.planId, slot, reservedAt: new Date().toISOString() }));
    const result = await executeEntityLinkLive({ repository, directory: output, confirmPlanId: plan.planId }, {}, adapter);
    expect(result).toMatchObject({ unknown: ['case-0'], complete: false, stopped: true }); expect(calls).not.toHaveBeenCalled();
    expect(readdirSync(join(output, 'reserved'))).toEqual(['case-0.json']);
  });
  it('recovers missing derived records from archived native JSON without invoking that slot again', async () => {
    const { adapter, calls } = runtime(); const plan = await prepareEntityLinkLive(options(), adapter);
    await executeEntityLinkLive({ repository, directory: output, confirmPlanId: plan.planId }, {}, adapter);
    unlinkSync(join(output, 'records', 'case-0.json'));
    const replay = await checkEntityLinkLive({ repository, directory: output }, adapter);
    expect(replay.pendingRecords.map(item => item.caseId)).toEqual(['case-0']); expect(existsSync(join(output, 'records', 'case-0.json'))).toBe(false);
    await executeEntityLinkLive({ repository, directory: output, confirmPlanId: plan.planId }, {}, adapter);
    expect(calls).toHaveBeenCalledTimes(3); expect(existsSync(join(output, 'records', 'case-0.json'))).toBe(true);
  });
  it.each(['tools', 'usage', 'exception', 'invalid-output', 'binding', 'failed'] as const)('preserves %s evidence and stops remaining calls', async failure => {
    const { adapter, calls } = runtime(prompt => {
      if (failure === 'exception') throw new Error('native exception evidence');
      const value = native(prompt);
      if (failure === 'tools') return { ...value, toolCalls: [{ tool: 'exec' }] };
      if (failure === 'usage') return { ...value, tokenUsageReportedByExecutor: false, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
      if (failure === 'invalid-output') return { ...value, output: '{not json}' };
      if (failure === 'binding') return { ...value, output: JSON.stringify({ ...JSON.parse(value.output), leftEntityId: uuid(99999) }) };
      return { ...value, ok: false, output: null, error: 'fixture network failure', failure: { failureKind: 'network_error' } };
    });
    const plan = await prepareEntityLinkLive(options(), adapter);
    const result = await executeEntityLinkLive({ repository, directory: output, confirmPlanId: plan.planId }, {}, adapter);
    expect(result).toMatchObject({ complete: false, stopped: true }); expect(calls).toHaveBeenCalledTimes(1);
    expect(readdirSync(join(output, 'native'))).toEqual(['case-0.json']);
    expect(readdirSync(join(output, 'records'))).toEqual(['case-0.json']);
    if (failure === 'usage') {
      expect(result.capture.records[0].result).toMatchObject({ captureStatus: 'call_failure', failure: 'usage_unreported' });
      expect(result.records[0].usage).toMatchObject({ reportedByExecutor: false, inputTokens: null, outputTokens: null, cacheReadTokens: null, costUSD: null });
    }
    if (failure === 'invalid-output') expect(result.capture.records[0].result).toMatchObject({ captureStatus: 'output', output: '{not json}' });
    await executeEntityLinkLive({ repository, directory: output, confirmPlanId: plan.planId }, {}, adapter); expect(calls).toHaveBeenCalledTimes(1);
  });
  it('archives deeply nested native tool evidence before any recursive validator can reject it', async () => {
    const nested: { child?: unknown } = {}, depth = 6000; let current = nested;
    for (let index = 0; index < depth; index++) { const child = {}; current.child = child; current = child; }
    const { adapter, calls } = runtime(prompt => ({ ...native(prompt), toolCalls: [{ input: nested }] }));
    const plan = await prepareEntityLinkLive(options(), adapter);
    const result = await executeEntityLinkLive({ repository, directory: output, confirmPlanId: plan.planId }, {}, adapter);
    expect(calls).toHaveBeenCalledTimes(1); expect(result.stopped).toBe(true);
    let archived = JSON.parse(readFileSync(join(output, 'native', 'case-0.json'), 'utf8')).result.toolCalls[0].input;
    for (let index = 0; index < depth; index++) { expect(archived).toHaveProperty('child'); archived = archived.child; }
    expect(archived).toEqual({});
  });
  it('labels missing usage flags as unspecified compatibility evidence instead of provider reporting', async () => {
    const { adapter } = runtime(prompt => { const value: Partial<ReturnType<typeof native>> = native(prompt); delete value.tokenUsageReportedByExecutor; return value; });
    const plan = await prepareEntityLinkLive(options(), adapter);
    const result = await executeEntityLinkLive({ repository, directory: output, confirmPlanId: plan.planId }, {}, adapter);
    expect(result.records[0].usage).toMatchObject({ reportedByExecutor: false, reportingUnspecified: true, inputTokens: 13, outputTokens: 8, costUSD: null });
  });
  it.each(['failure', 'refusal'] as const)('never projects flagged %s results as captured output', async flag => {
    const { adapter, calls } = runtime(prompt => ({ ...native(prompt), [flag]: flag === 'failure' ? { failureKind: 'network_error' } : 'fixture refusal' }));
    // Exercise the defensive projection even if a legacy producer admits inconsistent flags.
    adapter.parseOutcome = value => value as ReturnType<EntityLinkLiveRuntime['parseOutcome']>;
    const plan = await prepareEntityLinkLive(options(), adapter);
    const result = await executeEntityLinkLive({ repository, directory: output, confirmPlanId: plan.planId }, {}, adapter);
    expect(calls).toHaveBeenCalledTimes(1);
    expect(result.records[0]).toMatchObject({ admission: 'failed_execution', captureRecord: { result: { captureStatus: 'call_failure', failure: 'failed_execution' } } });
    expect(result.capture.records[0].result).not.toHaveProperty('output');
    expect(JSON.parse(readFileSync(join(output, 'native', 'case-0.json'), 'utf8')).result).toHaveProperty(flag);
  });
  it.each(['ok-false', 'failure', 'refusal', 'cancelled'].flatMap(flag => [0, 0.125].map(costUSD => ({ flag, costUSD }))))
    ('retains explicitly reported failed usage metadata for $flag / $costUSD', async ({ flag, costUSD }) => {
      const { adapter } = runtime(prompt => ({ ...native(prompt), ok: !['ok-false', 'cancelled'].includes(flag), costUSD, costReportedByExecutor: true,
        ...(flag === 'failure' ? { failure: { failureKind: 'network_error' } } : {}),
        ...(flag === 'cancelled' ? { failure: { failureKind: 'cancelled' } } : {}), ...(flag === 'refusal' ? { refusal: 'fixture refusal' } : {}) }));
      adapter.parseOutcome = value => value as ReturnType<EntityLinkLiveRuntime['parseOutcome']>;
      const plan = await prepareEntityLinkLive(options(), adapter);
      const result = await executeEntityLinkLive({ repository, directory: output, confirmPlanId: plan.planId }, {}, adapter);
      expect(result.capture.records[0].result).toMatchObject({ captureStatus: flag === 'cancelled' ? 'cancelled' : 'call_failure', costUSD, durationMs: 12 });
      expect(JSON.parse(readFileSync(join(output, 'native', 'case-0.json'), 'utf8')).result).toMatchObject({ costUSD, costReportedByExecutor: true });
    });
  it('checks host, input, review readiness, paths and record integrity before any new call', async () => {
    const { adapter, calls } = runtime();
    await expect(prepareEntityLinkLive({ ...options(), output: join(repository, 'forbidden') }, adapter)).rejects.toThrow('outside');
    await expect(prepareEntityLinkLive({ ...options(), maxCalls: 2 }, adapter)).rejects.toThrow('one unique case');
    await expect(prepareEntityLinkLive({ ...options(), caseIds: ['case-0', 'case-0', 'case-1'] }, adapter)).rejects.toThrow('one unique case');
    const plan = await prepareEntityLinkLive(options(), adapter);
    writeFileSync(join(output, 'inputs', 'case-0.json'), canonicalJson(corpus.cases[1].input));
    await expect(executeEntityLinkLive({ repository, directory: output, confirmPlanId: plan.planId }, {}, adapter)).rejects.toThrow('selected input');
    expect(calls).not.toHaveBeenCalled();
    writeFileSync(join(output, 'inputs', 'case-0.json'), canonicalJson(corpus.cases[0].input));
    adapter.host = async () => ({ ...host, codexBinaryDigest: hash('changed binary') });
    await expect(checkEntityLinkLive({ repository, directory: output }, adapter)).rejects.toThrow('host or frozen bundle');
    adapter.host = async () => ({ ...host });
    await executeEntityLinkLive({ repository, directory: output, confirmPlanId: plan.planId }, {}, adapter);
    const saved = JSON.parse(readFileSync(join(output, 'records', 'case-0.json'), 'utf8')); saved.nativeDigest = hash('forged');
    writeFileSync(join(output, 'records', 'case-0.json'), JSON.stringify(saved));
    await expect(checkEntityLinkLive({ repository, directory: output }, adapter)).rejects.toThrow('native archive');
  });
  it('refuses symlink inputs and a manifest that claims readiness without an approved author record', async () => {
    const { adapter, calls } = runtime();
    const reviewPath = join(bundle, 'self-review.json'), review = JSON.parse(readFileSync(reviewPath, 'utf8')); review.decisions[0].decision = 'changes_requested';
    writeFileSync(reviewPath, JSON.stringify(review)); await expect(prepareEntityLinkLive(options(), adapter)).rejects.toThrow('approved author');
    review.decisions[0].decision = 'approved'; writeFileSync(reviewPath, JSON.stringify(review));
    const path = join(bundle, 'inputs', 'case-0.json'); unlinkSync(path); symlinkSync(join(bundle, 'inputs', 'case-1.json'), path);
    await expect(prepareEntityLinkLive(options(), adapter)).rejects.toThrow('regular evidence file'); expect(calls).not.toHaveBeenCalled();
  });
  it.each(['corpus', 'forged-corpus-digest', 'guide'] as const)('refuses changed %s under an old author receipt', async change => {
    const { adapter, calls } = runtime();
    if (change === 'guide') writeFileSync(join(bundle, 'annotation-guide.zh.md'), '换了标注规则。');
    else {
      const modified = JSON.parse(readFileSync(join(bundle, 'corpus.json'), 'utf8'));
      modified.cases[0].input.left.entity.description = '调用前被替换的来源对象描述';
      const bytes = JSON.stringify(modified); writeFileSync(join(bundle, 'corpus.json'), bytes);
      writeFileSync(join(bundle, 'inputs', 'case-0.json'), canonicalJson(modified.cases[0].input));
      if (change === 'forged-corpus-digest') {
        const manifest = JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8')); manifest.corpusDigest = hash(bytes);
        writeFileSync(join(bundle, 'manifest.json'), JSON.stringify(manifest));
      }
    }
    await expect(prepareEntityLinkLive(options(), adapter)).rejects.toThrow('measurement/corpus/annotation guide identity');
    expect(calls).not.toHaveBeenCalled(); expect(adapter.configure).not.toHaveBeenCalled();
  });
  it('binds copied annotation guides on reopen as well as initial preparation', async () => {
    const { adapter, calls } = runtime(); await prepareEntityLinkLive(options(), adapter);
    writeFileSync(join(output, 'annotation-guide.en.md'), 'A different annotation guide.');
    await expect(checkEntityLinkLive({ repository, directory: output }, adapter)).rejects.toThrow('annotation guide identity');
    expect(calls).not.toHaveBeenCalled();
  });
  it('requires a named mode and explicit complete CLI flags, never inferring execution', () => {
    expect(() => parseEntityLinkLiveArguments([])).toThrow('explicitly');
    expect(() => parseEntityLinkLiveArguments(['execute', '--repository', repository, '--out', output])).toThrow('explicit flags');
    expect(parseEntityLinkLiveArguments(['check', '--repository', repository, '--out', output]).command).toBe('check');
    expect(() => parseEntityLinkLiveArguments(['check', '--repository', repository, '--out', output, '--model', 'implicit'])).toThrow('Unknown');
  });
});
