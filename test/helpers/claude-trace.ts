import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTraceSessions, type TraceSession } from '../../src/observability/trace/source.js';

/** Exercise the production Claude parser before testing source-neutral projections. */
export function loadClaudeTraceFixture(records: readonly object[], runId: string): TraceSession {
  const root = mkdtempSync(join(tmpdir(), 'omk-claude-trace-'));
  try {
    const path = join(root, 'trace.jsonl');
    writeFileSync(path, records.map((record) => JSON.stringify({ ...record, sessionId: runId })).join('\n'));
    const [session] = loadTraceSessions(path);
    if (!session) throw new Error('Claude fixture did not produce a trace session');
    return session;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
