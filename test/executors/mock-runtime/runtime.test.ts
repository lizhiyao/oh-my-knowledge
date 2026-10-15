import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import {
  materializeForScript,
  type ScriptMockHandle,
} from '../../../src/executors/mock-runtime/runtime.js';

interface McpResponse {
  id: number;
  result?: { content: Array<{ text: string }> };
  error?: { code: number; message: string };
}

async function callMcp(
  handle: ScriptMockHandle,
  calls: Array<{ name: string; arguments: Record<string, unknown> }>,
): Promise<McpResponse[]> {
  const config = JSON.parse(readFileSync(handle.mcpConfigFile!, 'utf8')).mcpServers.files;
  const child = spawn(config.command, config.args, {
    env: { ...process.env, ...config.env }, timeout: 10_000, killSignal: 'SIGKILL',
  });
  let stdout = '';
  let stderr = '';
  const completed = new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(stderr || `MCP exited ${code}`)));
  });
  child.stdin.end(calls.map((params, id) => JSON.stringify({
    jsonrpc: '2.0', id, method: 'tools/call', params,
  })).join('\n') + '\n');
  await completed;
  assert.equal(stderr, '');
  const responses = stdout.trim().split('\n').map((line) => JSON.parse(line) as McpResponse);
  assert.equal(responses.length, calls.length);
  return responses;
}

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

  it('serves MCP mocks only when all input and path constraints match', async () => {
    const handle = materializeForScript([
      { tool: 'mcp__files__read', match: {
        file_path: '~/wanted/state.json', file_path_endswith: 'state.json',
        input: { mode: 'read' }, input_contains: 'needle', command_glob: 'read *',
        url_glob: 'https://docs/*',
      }, return: 'exact' },
      { tool: 'mcp__files__read', match: { file_path_endswith: 'tasks/state.json' }, return: 'suffix' },
    ], undefined, true, process.execPath)!;
    const dir = handle.rootDir;
    createdDirs.push(dir);

    assert.equal(handle.mcpConfigFile, join(dir, 'mcp.json'));
    assert.ok(existsSync(join(dir, 'fake-mcp-server.cjs')));
    const cfg = JSON.parse(readFileSync(handle.mcpConfigFile!, 'utf8'));
    assert.equal(cfg.mcpServers.files.command, process.execPath);
    assert.deepEqual(cfg.mcpServers.files.env, { OMK_MOCKS_FILE: join(dir, 'mocks.json') });
    assert.equal(JSON.parse(readFileSync(join(dir, 'mocks.json'), 'utf8')).strict, true);
    const valid = {
      file_path: join(homedir(), 'wanted/state.json'), mode: 'read',
      note: 'NEEDLE', command: 'read target', url: 'https://docs/page',
    };
    const inputs = [
      valid,
      { ...valid, file_path: '/other/state.json' },
      { ...valid, mode: 'write' },
      { ...valid, command: 'write target' },
      { ...valid, note: 'missing' },
      { ...valid, url: 'https://other/page' },
      { file_path: '/root/tasks/state.json' },
      { file_path: '/root/nottasks/state.json' },
      { file_path: 'C:\\root\\tasks/state.json' },
      {},
    ];
    const responses = await callMcp(handle, inputs.map((arguments_) => ({ name: 'read', arguments: arguments_ })));
    const expected = ['exact', null, null, null, null, null, 'suffix', null, 'suffix', null];
    for (let i = 0; i < responses.length; i++) {
      assert.equal(responses[i]!.error, undefined);
      const text = responses[i]!.result!.content[0]!.text;
      if (expected[i] === null) assert.match(text, /omk-mock-strict/);
      else assert.equal(text, expected[i]);
    }
    assert.deepEqual(handle.readStats(), {
      hits: 3, misses: 7,
      perMock: { 'mcp__files__read:1': 1, 'mcp__files__read:2': 2 },
    });
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

  it('shares sequence positions and atomic statistics across processes and fails closed on corrupt state', async () => {
    const sequence = Array.from({ length: 32 }, (_, i) => `state-${i}`);
    const handle = materializeForScript([
      { tool: 'mcp__files__read', match: { input: { track: 'read' } }, return_seq: sequence },
      { tool: '*', match: { input: { track: 'wild' } }, return_seq: ['wild-0', 'wild-1'] },
    ], undefined, true, process.execPath)!;
    createdDirs.push(handle.rootDir);
    const statsFile = join(handle.rootDir, 'hits.json');
    const parseErrors: unknown[] = [];
    const reader = setInterval(() => {
      if (!existsSync(statsFile)) return;
      try { JSON.parse(readFileSync(statsFile, 'utf8')); } catch (error) { parseErrors.push(error); }
    }, 1);
    let batches: McpResponse[][];
    try {
      batches = await Promise.all(Array.from({ length: 4 }, () => callMcp(handle,
        Array.from({ length: 8 }, () => ({ name: 'read', arguments: { track: 'read' } })),
      )));
    } finally {
      clearInterval(reader);
    }
    const outputs = batches.flat().map((response) => response.result?.content[0]?.text);
    assert.deepEqual(new Set(outputs), new Set(sequence));
    assert.deepEqual(parseErrors, []);
    const [saturated] = await callMcp(handle, [{ name: 'read', arguments: { track: 'read' } }]);
    assert.equal(saturated?.result?.content[0]?.text, 'state-31');
    const wild = await Promise.all(['alpha', 'beta'].map((name) => callMcp(handle, [
      { name, arguments: { track: 'wild' } },
    ])));
    assert.deepEqual(new Set(wild.flat().map((response) => response.result?.content[0]?.text)),
      new Set(['wild-0', 'wild-1']));
    assert.deepEqual(handle.readStats(), {
      hits: 35, misses: 0, perMock: { 'mcp__files__read:1': 33, '*:1': 2 },
    });

    for (const corrupt of ['{', JSON.stringify({ hits_total: -1, misses_total: 0, perMock: {} })]) {
      writeFileSync(statsFile, corrupt);
      const [invalid] = await callMcp(handle, [{ name: 'read', arguments: { track: 'read' } }]);
      assert.equal(invalid?.error?.code, -32603);
      assert.equal(readFileSync(statsFile, 'utf8'), corrupt);
      assert.equal(existsSync(statsFile + '.lock'), false);
    }
  });
});
