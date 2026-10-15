import { beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function jsonl(records: unknown[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n');
}

export function businessActionTag(name: string, text: string): string {
  const tag = ['ai', 'ma-cmd'].join('');
  return `<${tag} name="${name}">${text}</${tag}>`;
}

export function businessChannel(): string {
  return ['ai', 'ma'].join('');
}

/** Raw source records keep intentional omissions; do not normalize evidence in fixtures. */
export function asstRec(uuid: string, content: unknown[], opts: { sessionId?: string; timestamp?: string; cwd?: string } = {}): object {
  return {
    type: 'assistant',
    uuid,
    parentUuid: null,
    sessionId: opts.sessionId ?? 's1',
    timestamp: opts.timestamp ?? '2026-04-19T10:00:00.000Z',
    cwd: opts.cwd ?? '/tmp/p',
    gitBranch: 'main',
    message: {
      role: 'assistant',
      model: 'claude-opus-4-7',
      content,
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  };
}

export function userRec(uuid: string, content: unknown, opts: { sessionId?: string; timestamp?: string } = {}): object {
  return {
    type: 'user',
    uuid,
    parentUuid: null,
    sessionId: opts.sessionId ?? 's1',
    timestamp: opts.timestamp ?? '2026-04-19T10:00:00.000Z',
    message: { role: 'user', content },
  };
}

export function writeSession(dir: string, name: string, records: unknown[]): string {
  const path = join(dir, name);
  writeFileSync(path, jsonl(records));
  return path;
}

export function traceFixture() {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'omk-trace-')); });
  afterEach(() => { rmSync(directory, { recursive: true, force: true }); });
  return { get directory() { return directory; } };
}
