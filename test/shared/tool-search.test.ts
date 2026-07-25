import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  isFailedSearchToolCall,
  isSearchToolCall,
  toolCallQuery,
} from '../../src/shared/tool-search.js';
import type { ToolCallInfo } from '../../src/types/index.js';

function bashTc(command: string): ToolCallInfo {
  return {
    tool: 'Bash',
    input: { command },
    output: '',
    success: true,
  } as unknown as ToolCallInfo;
}

describe('toolCallQuery — Bash structured parsing', () => {
  // grep / rg
  it('extracts pattern + path from positional grep', () => {
    const q = toolCallQuery(bashTc('grep payment file.ts'));
    assert.equal(q.query, 'payment');
    assert.equal(q.path, 'file.ts');
  });

  it('extracts pattern from grep -r with flags', () => {
    const q = toolCallQuery(bashTc('grep -r --include=*.ts payment /repos'));
    assert.equal(q.query, 'payment');
    assert.equal(q.path, '/repos');
  });

  it('extracts pattern from grep -e <pat> form', () => {
    const q = toolCallQuery(bashTc('grep -e payment file.ts'));
    assert.equal(q.query, 'payment');
    assert.equal(q.path, 'file.ts');
  });

  it('extracts pattern from rg with -F flag', () => {
    const q = toolCallQuery(bashTc('rg -F payment src/'));
    assert.equal(q.query, 'payment');
    assert.equal(q.path, 'src/');
  });

  it('skips -A/-B/-C context flag values when looking for pattern', () => {
    const q = toolCallQuery(bashTc('grep -A 3 payment file.ts'));
    assert.equal(q.query, 'payment');
    assert.equal(q.path, 'file.ts');
  });

  it('strips quote chars from quoted pattern', () => {
    const q = toolCallQuery(bashTc("grep 'payment' file.ts"));
    assert.equal(q.query, 'payment');
  });

  // find
  it('extracts pattern from find -name', () => {
    const q = toolCallQuery(bashTc('find /repos -name payment.ts'));
    assert.equal(q.query, 'payment.ts');
  });

  it('extracts pattern from find -iname', () => {
    const q = toolCallQuery(bashTc('find / -iname *payment*.ts'));
    assert.equal(q.query, '*payment*.ts');
  });

  it('extracts pattern from find -path', () => {
    const q = toolCallQuery(bashTc('find / -path /foo/payment.ts'));
    assert.equal(q.query, '/foo/payment.ts');
  });

  // path-only commands (ls / cat / test / ...)
  it('returns path-only for ls', () => {
    const q = toolCallQuery(bashTc('ls /repos/payment-app/src/auth.ts'));
    assert.equal(q.query, undefined);
    assert.equal(q.path, '/repos/payment-app/src/auth.ts');
  });

  it('returns path-only for cat with flags', () => {
    const q = toolCallQuery(bashTc('cat -n /repos/payment-app/src/auth.ts'));
    assert.equal(q.query, undefined);
    assert.equal(q.path, '/repos/payment-app/src/auth.ts');
  });

  it('returns path-only for test -f', () => {
    const q = toolCallQuery(bashTc('test -f /missing/path'));
    assert.equal(q.query, undefined);
    assert.equal(q.path, '/missing/path');
  });

  // unknown / non-search commands
  it('returns empty for unknown command (no full-command leak)', () => {
    const q = toolCallQuery(bashTc('npm run test --watch'));
    assert.equal(q.query, undefined);
    assert.equal(q.path, undefined);
  });

  it('returns empty for git commands', () => {
    const q = toolCallQuery(bashTc('git log --oneline -5'));
    assert.equal(q.query, undefined);
    assert.equal(q.path, undefined);
  });

  // pipe / chained
  it('only parses the grep portion in piped command', () => {
    const q = toolCallQuery(bashTc('grep payment file.ts | wc -l'));
    assert.equal(q.query, 'payment');
    // path should be file.ts, not pipe artifacts
    assert.equal(q.path, 'file.ts');
  });

  it('parses grep portion from compound (cat ... && grep ...)', () => {
    const q = toolCallQuery(bashTc('cat /etc/hosts && grep payment file.ts'));
    // either grep extraction wins (preferred) or path-only on cat — both are
    // acceptable; assert query exists when grep matches
    assert.equal(q.query, 'payment');
  });

  it('treats Codex web search as a structured search signal', () => {
    const tc: ToolCallInfo = {
      tool: 'web_search',
      input: { type: 'search', query: 'payment schema' },
      output: '{"status":"failed"}',
      success: false,
    };
    assert.deepEqual(toolCallQuery(tc), { query: 'payment schema', path: undefined });
    assert.equal(isSearchToolCall(tc), true);
    assert.equal(isFailedSearchToolCall(tc), true);
  });
});
