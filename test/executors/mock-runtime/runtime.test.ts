import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  materializeForScript,
} from '../../../src/executors/mock-runtime/runtime.js';

describe('materializeForScript', () => {
  let createdDirs: string[] = [];
  beforeEach(() => { createdDirs = []; });
  afterEach(() => {
    for (const d of createdDirs) try { rmSync(d, { recursive: true, force: true }); } catch { /* */ }
  });

  it('returns null when no mocks', () => {
    assert.equal(materializeForScript(undefined), null);
    assert.equal(materializeForScript([]), null);
  });

  it('cleanup is idempotent (safe to call twice)', () => {
    const handle = materializeForScript([{ tool: 'Read', return: 'x' }])!;
    createdDirs.push(handle.rootDir);
    handle.cleanup();
    handle.cleanup();  // no throw
    createdDirs = [];
  });

  it('readStats returns zeros before any calls', () => {
    const handle = materializeForScript([{ tool: 'Read', return: 'x' }])!;
    createdDirs.push(handle.rootDir);
    const stats = handle.readStats();
    assert.deepEqual(stats, { hits: 0, misses: 0, perMock: {} });
  });

  it('readStats parses written hits.json', () => {
    const handle = materializeForScript([{ tool: 'Read', return: 'x' }])!;
    const dir = handle.rootDir;
    createdDirs.push(dir);
    writeFileSync(
      join(dir, 'hits.json'),
      JSON.stringify({ perMock: { 'Read:1': 3 }, hits_total: 3, misses_total: 1 }),
    );
    const stats = handle.readStats();
    assert.deepEqual(stats, { hits: 3, misses: 1, perMock: { 'Read:1': 3 } });
  });

  it('writes one-shot MCP config for mcp tool mocks', () => {
    const handle = materializeForScript([
      { tool: 'mcp__clawdbot-dingtalk__message', return: '{"ok":true}' },
    ])!;
    const dir = handle.rootDir;
    createdDirs.push(dir);

    assert.equal(handle.mcpConfigFile, join(dir, 'mcp.json'));
    assert.ok(existsSync(join(dir, 'fake-mcp-server.cjs')));
    const cfg = JSON.parse(readFileSync(handle.mcpConfigFile!, 'utf8'));
    assert.equal(cfg.mcpServers['clawdbot-dingtalk'].command, 'node');
    assert.deepEqual(cfg.mcpServers['clawdbot-dingtalk'].env, { OMK_MOCKS_FILE: join(dir, 'mocks.json') });
  });

  it('pins the fake MCP launcher to an explicit Node executable', () => {
    const nodeExecutable = join('/runtime with spaces', 'node');
    const handle = materializeForScript(
      [{ tool: 'mcp__search__query', return: 'ok' }],
      undefined,
      false,
      nodeExecutable,
    )!;
    const dir = handle.rootDir;
    createdDirs.push(dir);
    const mcp = JSON.parse(readFileSync(handle.mcpConfigFile!, 'utf8'));
    assert.equal(mcp.mcpServers.search.command, nodeExecutable);
  });

  it('strict flag persists into mocks.json', () => {
    const handle = materializeForScript([{ tool: 'Read', return: 'x' }], undefined, true)!;
    const dir = handle.rootDir;
    createdDirs.push(dir);
    const cfg = JSON.parse(readFileSync(join(dir, 'mocks.json'), 'utf8'));
    assert.equal(cfg.strict, true);
  });
});
