import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TraceEvidenceStore } from '../../src/observability/knowledge-extraction/adapters/trace-evidence.js';
import { EVIDENCE_PROJECTION_VERSION } from '../../src/observability/knowledge-extraction/evidence.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function temp(): string {
  const root = mkdtempSync(join(tmpdir(), 'omk-trace-evidence-'));
  roots.push(root);
  return root;
}

function logFile(name: string, records: object[]): string {
  const path = join(temp(), name);
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
  return path;
}

const SESSION_ID = '11111111-2222-3333-4444-555555555555';

function claudeRecord(type: 'user' | 'assistant', text: string): object {
  return {
    type,
    uuid: `${type}-1`,
    sessionId: SESSION_ID,
    timestamp: '2026-09-12T00:00:00.000Z',
    cwd: '/repo-a',
    gitBranch: 'main',
    message: type === 'user'
      ? { role: 'user', content: text }
      : { role: 'assistant', model: 'claude-sonnet-4', content: [{ type: 'text', text }] },
  };
}

function qoderRecord(type: 'user' | 'assistant', text: string): object {
  return {
    ...claudeRecord(type, text),
    origin: { kind: type === 'user' ? 'human' : 'synthetic' },
    isSidechain: false,
    userType: 'external',
    entrypoint: 'cli',
    version: '1.1.47',
  };
}

const QODER_BOOKKEEPING: object[] = [
  { type: 'workspace-directories', sessionId: SESSION_ID, directories: ['/repo-a'] },
  { type: 'runtime-config', sessionId: SESSION_ID, model: 'qmodel_38max', timestamp: 1_700_000_000_000 },
  { type: 'active-leaf', sessionId: SESSION_ID, leafUuid: 'user-1', explicit: true },
];

describe('TraceEvidenceStore across agent log formats', () => {
  it('archives a Qoder session and attributes the snapshot to the qoder source kind', () => {
    const path = logFile('qoder.jsonl', [
      ...QODER_BOOKKEEPING,
      qoderRecord('user', '发布门禁要求先跑 ci'),
      qoderRecord('assistant', '是，首次 push 前必须跑一次 yarn ci'),
    ]);
    const captured = new TraceEvidenceStore(temp()).capture({ path });

    expect(captured.sourceKind).toBe('qoder');
    expect(captured.projectionVersion).toBe(EVIDENCE_PROJECTION_VERSION);
    expect(captured.excerpts.some((excerpt) => excerpt.text.includes('yarn ci'))).toBe(true);
  });

  it('archives a Claude Code session without losing its own source identity', () => {
    const path = logFile('claude.jsonl', [
      claudeRecord('user', '收件箱报告放在哪个目录'),
      claudeRecord('assistant', '默认写在 .omk/observe/inbox'),
    ]);
    const captured = new TraceEvidenceStore(temp()).capture({ path });

    expect(captured.sourceKind).toBe('claude');
    expect(captured.excerpts.some((excerpt) => excerpt.text.includes('.omk/observe/inbox'))).toBe(true);
  });

  it('refuses to archive records whose agent format cannot be attributed', () => {
    const path = logFile('mystery.jsonl', [{ type: 'something-else', id: 'x' }]);
    expect(() => new TraceEvidenceStore(temp()).capture({ path }))
      .toThrow('do not identify a single supported agent log format');
  });
});
