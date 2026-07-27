import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { normalizeToolIdentity } from '../../src/shared/tool-identity.js';

describe('source-neutral tool identity', () => {
  it('maps provider-specific shell and file events to canonical built-ins', () => {
    assert.deepEqual(
      ['command_execution', 'exec_command', 'Bash'].map((sourceName) =>
        normalizeToolIdentity({ sourceName }).name),
      ['Bash', 'Bash', 'Bash'],
    );
    assert.deepEqual(
      ['file_read', 'Read'].map((sourceName) =>
        normalizeToolIdentity({ sourceName }).name),
      ['Read', 'Read'],
    );
    assert.deepEqual(
      ['web_search', 'WebSearch'].map((sourceName) =>
        normalizeToolIdentity({ sourceName }).name),
      ['WebSearch', 'WebSearch'],
    );
  });

  it('does not reinterpret ambiguous custom tool names as built-ins', () => {
    for (const sourceName of ['run', 'exec', 'search']) {
      assert.equal(normalizeToolIdentity({ sourceName }).name, sourceName);
    }
  });

  it('normalizes Claude MCP names while retaining the runtime namespace', () => {
    assert.deepEqual(
      normalizeToolIdentity({ sourceName: 'mcp__github__fetch_file' }),
      {
        name: 'github.fetch_file',
        sourceName: 'mcp__github__fetch_file',
        namespace: 'mcp__github',
        provider: 'github',
        displayName: 'github.fetch_file',
      },
    );
  });

  it('removes Codex connector transport wrappers from the comparison name', () => {
    assert.deepEqual(
      normalizeToolIdentity({ sourceName: 'mcp__codex_apps__github__fetch_file' }),
      {
        name: 'github.fetch_file',
        sourceName: 'mcp__codex_apps__github__fetch_file',
        namespace: 'mcp__codex_apps__github',
        provider: 'github',
        displayName: 'github.fetch_file',
      },
    );
  });

  it('uses authoritative Codex MCP end-event identity without double-prefixing', () => {
    assert.equal(
      normalizeToolIdentity({
        sourceName: 'mcp_tool_call',
        provider: 'github',
        authoritativeName: 'fetch_file',
      }).name,
      'github.fetch_file',
    );
    assert.equal(
      normalizeToolIdentity({
        sourceName: 'mcp_tool_call',
        provider: 'github',
        authoritativeName: 'github.fetch_file',
      }).name,
      'github.fetch_file',
    );
  });

  it('keeps an already namespace-qualified custom tool identity idempotent', () => {
    assert.deepEqual(
      normalizeToolIdentity({
        sourceName: 'github.fetch_file',
        namespace: 'github',
      }),
      {
        name: 'github.fetch_file',
        namespace: 'github',
        provider: 'github',
        displayName: 'github.fetch_file',
      },
    );
  });
});
