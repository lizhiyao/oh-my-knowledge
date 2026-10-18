import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import type { ExecutorInput } from '../../../../src/executors/contracts/ports.js';
import type { ExecResult } from '../../../../src/executors/contracts/result.js';
import type { DoctorReport } from '../../../../src/knowledge/artifacts/doctor/contracts.js';
import { runDoctorFix } from '../../../../src/knowledge/artifacts/doctor/fixer.js';
import { projectLayout } from '../../../../src/evidence/storage/layout.js';

const state = vi.hoisted(() => ({ invoke: vi.fn(), answers: [] as string[], closed: 0 }));
vi.mock('../../../../src/executors/index.js', () => ({ createExecutor: () => state.invoke }));
vi.mock('node:readline', async (original) => ({
  ...await original<typeof import('node:readline')>(),
  createInterface: () => ({
    [Symbol.asyncIterator]() {
      return { async next() {
        const value = state.answers.shift();
        return value === undefined ? { done: true as const, value: undefined } : { done: false as const, value };
      } };
    },
    close() { state.closed += 1; },
  }),
}));

const roots: string[] = [];
beforeEach(() => {
  state.invoke.mockReset();
  state.answers = ['apply', 'apply', 'apply', 'yes'];
  state.closed = 0;
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function result(output: string, ok = true): ExecResult {
  return {
    ok, output: ok ? output : null, ...(ok ? {} : { error: 'fixture failure' }),
    durationMs: 1, durationApiMs: 1, inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, cacheCreationTokens: 0, tokenUsageReportedByExecutor: false,
    costUSD: 0, costReportedByExecutor: false, stopReason: ok ? 'end_turn' : 'error', numTurns: 1,
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'omk-doctor-fix-'));
  roots.push(root);
  const files = ['a', 'b'].map((name) => join(root, name, 'SKILL.md'));
  const originals = ['\n# A\nold-a\nKeep A.\n', '\n# B\nold-b\nKeep B.\n'];
  files.forEach((path, index) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, originals[index]); });
  const report: DoctorReport = {
    kind: 'doctor', schemaVersion: 'fixture/v1', id: 'fixture', timestamp: '2026-10-16T00:00:00Z',
    cliVersion: 'fixture', cwd: root, executorName: 'fixture', model: 'fixture', outcome: 'failed',
    totals: { pass: 0, warn: 0, fail: 2 }, ruleStats: { pass: 0, warn: 0, fail: 3, skipped: 0, total: 3 },
    skills: files.map((skillPath, index) => ({
      skillName: index === 0 ? 'a' : 'b', skillPath, status: 'fail',
      results: Array.from({ length: index === 0 ? 2 : 1 }, (_, rule) => ({
        ruleId: `rule-${index}-${rule}`, severity: 'fatal', labelKey: 'fixture',
        status: 'fail', message: `issue-for-${index}`, hint: `direction-for-${index}`, durationMs: 1,
      })),
    })),
  };
  const options = { report, executorName: 'fixture', model: 'fixture', timeoutMs: 1_000 };
  const plan = { issues: ['i1', 'i2', 'i3'].map((issueId) => ({
    issueId, title: issueId, summary: 'fixture', options: [
      { id: 'apply', label: 'Apply', description: `selected-${issueId}`, recommended: true, risk: 'low' },
    ],
  })) };
  return { root, files, originals, options, plan };
}

function editingResponse(input: ExecutorInput): ExecResult {
  const request = JSON.parse(input.prompt) as { currentContent: string };
  const marker = request.currentContent.includes('old-a') ? 'a' : 'b';
  return result(JSON.stringify({
    summary: `updated ${marker}`, edits: [{ oldText: `old-${marker}`, newText: `new-${marker}` }],
  }));
}

it('groups selected issues by file, applies exact edits and retains original backups', async () => {
  const value = fixture();
  state.invoke.mockImplementation(async (input: ExecutorInput) => input.system?.includes('omk.doctor-fix-plan/v2')
    ? result(JSON.stringify(value.plan)) : editingResponse(input));
  await expect(runDoctorFix(value.options)).resolves.toBe(true);
  expect(state.invoke).toHaveBeenCalledTimes(3);
  const edits = state.invoke.mock.calls.slice(1).map(([input]) => input as ExecutorInput);
  const requests = edits.map((input) => JSON.parse(input.prompt));
  expect(requests.map((request) => request.issues.map((issue: { id: string }) => issue.id)))
    .toEqual([['i1', 'i2'], ['i3']]);
  for (let index = 0; index < 2; index += 1) {
    expect(edits[index].cwd).toBe(dirname(realpathSync(value.files[index])));
    expect(requests[index].currentContent).toBe(value.originals[index]);
    expect(readFileSync(value.files[index], 'utf8')).toBe(value.originals[index].replace('old-', 'new-'));
  }
  const backups = projectLayout(value.root).doctorFixBackupsDir;
  const [backup] = readdirSync(backups);
  for (let index = 0; index < 2; index += 1) {
    expect(readFileSync(join(backups, backup, relative(value.root, value.files[index])), 'utf8')).toBe(value.originals[index]);
  }
  expect(state.answers).toEqual([]);
  expect(state.closed).toBe(1);
});

it.each(['failure', 'abort', 'concurrent-edit'] as const)('does not report full success after %s on a later file', async (mode) => {
  const value = fixture();
  const controller = new AbortController();
  state.invoke.mockImplementation(async (input: ExecutorInput) => {
    if (input.system?.includes('omk.doctor-fix-plan/v2')) return result(JSON.stringify(value.plan));
    if (JSON.parse(input.prompt).currentContent.includes('old-b')) {
      if (mode === 'failure') return result('', false);
      if (mode === 'abort') controller.abort(new Error('fixture aborted'));
      if (mode === 'concurrent-edit') writeFileSync(value.files[1], 'external edit\n');
    }
    return editingResponse(input);
  });
  await expect(runDoctorFix({ ...value.options, signal: controller.signal }))
    .rejects.toThrow(mode === 'abort' ? /fixture aborted/ : /未全部完成/);
  expect(readFileSync(value.files[0], 'utf8')).toBe(value.originals[0].replace('old-', 'new-'));
  expect(readFileSync(value.files[1], 'utf8')).toBe(mode === 'concurrent-edit' ? 'external edit\n' : value.originals[1]);
  expect(state.closed).toBe(1);
});

it('refuses to treat closed input as user confirmation', async () => {
  const value = fixture();
  state.answers = [];
  state.invoke.mockResolvedValue(result(JSON.stringify(value.plan)));
  await expect(runDoctorFix(value.options)).rejects.toThrow(/未获得.*确认/);
  expect(state.invoke).toHaveBeenCalledTimes(1);
  expect(existsSync(projectLayout(value.root).doctorFixBackupsDir)).toBe(false);
  value.files.forEach((path, index) => expect(readFileSync(path, 'utf8')).toBe(value.originals[index]));
});

it('rejects plans for unrequested issues before presenting choices or writing files', async () => {
  const value = fixture();
  value.plan.issues[0].issueId = 'unrequested';
  state.invoke.mockResolvedValue(result(JSON.stringify(value.plan)));
  await expect(runDoctorFix(value.options)).rejects.toThrow(/requested issue/);
  expect(state.invoke).toHaveBeenCalledTimes(3);
  expect(existsSync(projectLayout(value.root).doctorFixBackupsDir)).toBe(false);
  value.files.forEach((path, index) => expect(readFileSync(path, 'utf8')).toBe(value.originals[index]));
});
