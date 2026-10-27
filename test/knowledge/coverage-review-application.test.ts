import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { nativeStudyFixture, studyNativeResult } from './extraction-study-fixtures.js';
import { boundedExtractionPolicy } from '../../src/knowledge/extraction/generation-policy.js';
import { STRICT_EXTRACTION_PROMPT } from '../../src/knowledge/extraction/strict-prompt.js';
import { generateFrozenStrict30 } from './fixtures/frozen-strict30.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup(reply?: Parameters<typeof nativeStudyFixture>[1]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'omk-coverage-review-'))); roots.push(root);
  return nativeStudyFixture(root, reply);
}

describe('explicit coverage review through the production application (authored native returns)', () => {
  it('rejects the current strict default before creating a frozen-v30 private task or dispatching', async () => {
    const f = setup(), app = f.ports.application, model = f.model(), snapshotId = f.corpus.cases[0].window.snapshotId;
    await expect(app.generate(snapshotId, model, randomUUID(), undefined, { coverageReview: { previousRunId: randomUUID() } })).rejects.toThrow('unchanged strict30');
    expect(f.effects).not.toHaveBeenCalled(); expect(f.ports.runs.listManifests()).toEqual([]);
  });

  it('binds a new single call to complete archived raw, preserves both originals and reuses the ordinary admission path', async () => {
    const f = setup();
    const window = f.corpus.cases[0].window, app = f.ports.application, model = f.model();
    const first = await generateFrozenStrict30(app, window.snapshotId, model);
    const original = readFileSync(join(f.workspace, 'extraction-runs', `${first.runId}.json`));
    const id = randomUUID(), options = { coverageReview: { previousRunId: first.runId } };
    const reviewed = await generateFrozenStrict30(app, window.snapshotId, model, id, undefined, options);
    const input = JSON.parse(f.effects.mock.calls[1][0].prompt);
    expect(input.excerpts).toEqual(window.excerpts);
    expect(input.limitations).toEqual(window.limitations);
    expect(JSON.stringify(input)).toContain(JSON.stringify(first.rawOutput));
    expect(reviewed.inputDigest).not.toBe(first.inputDigest);
    expect(reviewed.promptHash).toBe(first.promptHash);
    expect(reviewed.attempts).toHaveLength(1);
    expect(reviewed.policy).toEqual(first.policy);
    expect(reviewed.status).toBe('completed');
    expect(reviewed.entityAnalysis?.revision.entities).toHaveLength(2);
    expect(reviewed.committed).toHaveLength(1);
    expect(reviewed.attempts[0].request.inputDigest).not.toBe(first.attempts[0].request.inputDigest);
    expect(readFileSync(join(f.workspace, 'extraction-runs', `${first.runId}.json`))).toEqual(original);
    const archived = f.ports.runs.readOutcome(reviewed.runId, reviewed.attempts[0].attemptId, reviewed.attempts[0].outcome);
    expect(archived.outcome).toMatchObject({ outcomeKind: 'result', result: { output: reviewed.rawOutput } });
    await generateFrozenStrict30(app, window.snapshotId, model, id, undefined, options);
    expect(f.effects).toHaveBeenCalledTimes(2);
    await expect(generateFrozenStrict30(app, window.snapshotId, model, id)).rejects.toThrow('identity conflict');
    // A review cannot recursively become a source-only first task.
    await expect(generateFrozenStrict30(app, window.snapshotId, model, randomUUID(), undefined,
      { coverageReview: { previousRunId: reviewed.runId } })).rejects.toThrow('source-only first task');
    expect(f.effects).toHaveBeenCalledTimes(2);
  });

  it('preserves all first-response bad items for review instead of passing only admitted entities', async () => {
    const f = setup((index, raw) => {
      if (index) return studyNativeResult(raw);
      const response = JSON.parse(raw);
      response.entities[0].collection = { invalid: 'untrusted full original' };
      return studyNativeResult(JSON.stringify(response));
    });
    const app = f.ports.application, id = f.corpus.cases[0].window.snapshotId;
    const first = await generateFrozenStrict30(app, id, f.model());
    expect(first.entityRejections?.length).toBeGreaterThan(0);
    const reviewed = await generateFrozenStrict30(app, id, f.model(), randomUUID(), undefined, { coverageReview: { previousRunId: first.runId } });
    expect(f.effects.mock.calls[1][0].prompt).toContain('untrusted full original');
    expect(reviewed.entityRejections).toEqual([]);
    expect(first.rawOutput).toContain('untrusted full original');
  });

  it('allows a complete malformed assistant string but never a missing or corrupt native archive', async () => {
    const f = setup((index, raw) => studyNativeResult(index ? raw : ' { malformed, 原始字节\n'));
    const app = f.ports.application, id = f.corpus.cases[0].window.snapshotId;
    const first = await generateFrozenStrict30(app, id, f.model());
    expect(first.status).toBe('failed');
    await generateFrozenStrict30(app, id, f.model(), randomUUID(), undefined, { coverageReview: { previousRunId: first.runId } });
    expect(f.effects.mock.calls[1][0].prompt).toContain(JSON.stringify(first.rawOutput));
    const path = join(f.workspace, 'extraction-runs', 'outcomes', first.runId, `${first.attempts[0].attemptId}.json`);
    const bytes = readFileSync(path); writeFileSync(path, Buffer.concat([bytes, Buffer.from(' ')]));
    await expect(generateFrozenStrict30(app, id, f.model(), randomUUID(), undefined, { coverageReview: { previousRunId: first.runId } })).rejects.toThrow();
    rmSync(path);
    await expect(generateFrozenStrict30(app, id, f.model(), randomUUID(), undefined, { coverageReview: { previousRunId: first.runId } })).rejects.toThrow();
    expect(f.effects).toHaveBeenCalledTimes(2);
  });

  it.each(['failed', 'refusal', 'tools'] as const)('does not reuse %s native text as a valid predecessor or consume another reservation', async mode => {
    const f = setup((_index, raw) => studyNativeResult(raw, mode === 'failed' ? { ok: false }
      : mode === 'refusal' ? { refusal: 'authored refusal' }
        : { toolCalls: [{ tool: 'authored unexpected tool', input: {}, output: null, success: true }] }));
    const app = f.ports.application, id = f.corpus.cases[0].window.snapshotId;
    const first = await generateFrozenStrict30(app, id, f.model());
    expect(first.status).toBe('failed');
    await expect(generateFrozenStrict30(app, id, f.model(), randomUUID(), undefined,
      { coverageReview: { previousRunId: first.runId } })).rejects.toThrow('complete archived native');
    expect(f.effects).toHaveBeenCalledTimes(1);
    expect(f.ports.runs.listManifests()).toHaveLength(1);
  });

  it('stops at an unsettled predecessor without starting a new effect', async () => {
    const f = setup(), app = f.ports.application, id = f.corpus.cases[0].window.snapshotId, firstId = randomUUID();
    await expect(generateFrozenStrict30(app, id, f.model(), firstId, undefined, {
      onOutcomeArchived() { throw new Error('authored observer interruption'); },
    })).rejects.toThrow('observer interruption');
    await expect(generateFrozenStrict30(app, id, f.model(), randomUUID(), undefined,
      { coverageReview: { previousRunId: firstId } })).rejects.toThrow('source-only first task');
    expect(f.effects).toHaveBeenCalledTimes(1);
    expect(f.ports.runs.listManifests()).toHaveLength(1);
  });

  it('blocks a complete native predecessor with failed cleanup before creating a review reservation', async () => {
    const f = setup(), app = f.ports.application, id = f.corpus.cases[0].window.snapshotId, model = f.model();
    const original = model.generate;
    model.generate = async (...args) => {
      const outcome = await original(...args);
      if (!('outcomeKind' in outcome) || outcome.outcomeKind !== 'result') throw new Error('Expected authored native return.');
      return { ...outcome, cleanupFailure: { diagnostic: 'Authored private-directory cleanup failure.' } };
    };
    const first = await generateFrozenStrict30(app, id, model);
    expect(first.status).toBe('completed');
    expect(f.ports.runs.readOutcome(first.runId, first.attempts[0].attemptId).outcome).toHaveProperty('cleanupFailure');
    await expect(generateFrozenStrict30(app, id, f.model(), randomUUID(), undefined,
      { coverageReview: { previousRunId: first.runId } })).rejects.toThrow('complete archived native');
    expect(f.effects).toHaveBeenCalledTimes(1);
    expect(f.ports.runs.listManifests()).toHaveLength(1);
  });

  it('rejects different sources, model conditions, profiles, recursive predecessors and bounded retries before reservation', async () => {
    const f = setup(), app = f.ports.application, model = f.model(), window = f.corpus.cases[0].window;
    const first = await generateFrozenStrict30(app, window.snapshotId, model);
    const options = { coverageReview: { previousRunId: first.runId } };
    const otherSource = join(f.root, 'other.jsonl'); writeFileSync(otherSource, readFileSync(resolve(f.root, 'source.jsonl')));
    const other = app.capture({ path: otherSource });
    const policy = boundedExtractionPolicy({ maxInvocations: 2, maxReasks: 1, maxTotalTokens: 2176,
      maxOutputTokens: 64, profileId: 'loopback-test/v1' });
    await expect(generateFrozenStrict30(app, window.snapshotId, model, randomUUID(), undefined, { ...options, policy })).rejects.toThrow('single-invocation');
    await expect(generateFrozenStrict30(app, other.snapshotId, model, randomUUID(), undefined, options)).rejects.toThrow('source-only first task');
    for (const changed of [{ ...model, model: 'different' }, { ...model, timeoutMs: 1 }, { ...model, maxOutputTokens: 65 }]) {
      await expect(generateFrozenStrict30(app, window.snapshotId, changed, randomUUID(), undefined, options)).rejects.toThrow('execution configuration');
    }
    await expect(generateFrozenStrict30(app, window.snapshotId, model, first.runId, undefined, options)).rejects.toThrow('distinct predecessor');
    await expect(generateFrozenStrict30(app, window.snapshotId, model, randomUUID(), undefined, { ...options,
      promptProfile: { profileVersion: 'knowledge-extraction-prompt-profile/v1', promptVersion: 'knowledge-extraction-v35', system: STRICT_EXTRACTION_PROMPT } })).rejects.toThrow('unchanged strict30');
    expect(f.effects).toHaveBeenCalledTimes(1);
    expect(f.ports.runs.listManifests()).toHaveLength(1);
  });
});
