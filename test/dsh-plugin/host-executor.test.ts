import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, it } from 'vitest';
import {
  createDshHostExecutor,
  type DshAgentLike,
  type DshHostContextLike,
  type DshSessionLike,
} from '../../src/dsh-plugin/host-executor.js';

type UnknownRecord = Record<string, unknown>;

class FakeDshHost implements DshHostContextLike {
  readonly created: Array<{
    sessionId: string;
    cwd: string;
    parentSession?: string;
    provider?: string;
    model: string;
  }> = [];
  readonly promptSections: UnknownRecord[] = [];
  readonly deniedTools: string[][] = [];
  disposed = 0;
  runtimeContextSuppressed = 0;
  private readonly eventListeners = new Set<(session: DshSessionLike, event: UnknownRecord) => void>();
  private readonly createdListeners = new Set<(session: DshSessionLike) => void>();

  readonly agents = {
    create: async (options: Parameters<DshHostContextLike['agents']['create']>[0]) => {
      const events: UnknownRecord[] = [];
      const session: DshSessionLike = {
        id: options.sessionId,
        events,
        header: {
          cwd: options.meta.cwd,
          ...(options.meta.parentSession ? { parentSession: options.meta.parentSession } : {}),
        },
      };
      let settle: (() => void) | undefined;
      let idle = Promise.resolve();
      const agent: DshAgentLike = {
        id: options.sessionId,
        options: options.agentOptions,
        session,
        followup: (message) => {
          idle = new Promise<void>((resolve) => { settle = resolve; });
          if (message.content && Array.isArray(message.content)
            && (message.content[0] as UnknownRecord | undefined)?.text === '__hang__') return;
          this.emitEvent(session, { type: 'user/message', data: { message } });
          this.emitEvent(session, {
            type: 'tool/call',
            data: { callId: 'call-1', name: 'read', arguments: '{"path":"README.md"}' },
          });
          this.emitEvent(session, {
            type: 'tool/result',
            data: {
              message: {
                content: [{
                  type: 'tool-result',
                  toolCallId: 'call-1',
                  content: [{ type: 'text', text: 'fixture file' }],
                  isError: false,
                }],
              },
            },
          });
          this.emitEvent(session, {
            type: 'assistant/message',
            data: {
              message: { content: [{ type: 'text', text: 'host answer' }] },
              usage: { inputTokens: 9, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 1 },
            },
          });
          this.emitEvent(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
          settle?.();
        },
        whenIdle: () => idle,
        cancel: () => {
          this.emitEvent(session, {
            type: 'turn/end',
            data: { reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'test' } } },
          });
          settle?.();
        },
      };
      options.setup({
        agent,
        systemPrompt: {
          section: (section) => {
            this.promptSections.push(section);
            return () => undefined;
          },
          suppressRuntimeContext: () => {
            this.runtimeContextSuppressed += 1;
            return () => undefined;
          },
        },
        tools: {
          get: (name) => name === 'skill' ? {} : undefined,
          restrict: (filter) => {
            this.deniedTools.push([...filter.deny]);
            return () => undefined;
          },
        },
      });
      this.created.push({
        sessionId: options.sessionId,
        cwd: options.meta.cwd,
        ...(options.meta.parentSession ? { parentSession: options.meta.parentSession } : {}),
        ...(options.agentOptions.provider ? { provider: options.agentOptions.provider } : {}),
        model: options.agentOptions.model,
      });
      for (const listener of this.createdListeners) listener(session);
      return {
        agent,
        dispose: async () => { this.disposed += 1; },
      };
    },
  };

  on(
    event: 'session/event' | 'session/created',
    listener: ((session: DshSessionLike, entry: UnknownRecord) => void) | ((session: DshSessionLike) => void),
  ): () => void {
    if (event === 'session/event') {
      const typed = listener as (session: DshSessionLike, entry: UnknownRecord) => void;
      this.eventListeners.add(typed);
      return () => this.eventListeners.delete(typed);
    }
    const typed = listener as (session: DshSessionLike) => void;
    this.createdListeners.add(typed);
    return () => this.createdListeners.delete(typed);
  }

  private emitEvent(session: DshSessionLike, event: UnknownRecord): void {
    (session.events as UnknownRecord[]).push(event);
    for (const listener of this.eventListeners) listener(session, event);
  }
}

const parentAgent = {
  id: 'interactive-session',
  options: { provider: 'configured-provider', model: 'configured-model' },
  session: { id: 'interactive-session', events: [], header: { cwd: '/project' } },
  followup() {},
  whenIdle: () => Promise.resolve(),
  cancel() {},
} satisfies DshAgentLike;

describe('DSH host executor', () => {
  it('runs a fresh measurement session inside the existing DSH host', async () => {
    const host = new FakeDshHost();
    const executor = createDshHostExecutor(host, { parentAgent });
    const result = await executor({
      model: 'measured-model',
      system: 'only this controlled artifact',
      prompt: 'evaluate this',
      cwd: '/project',
      allowedSkills: [],
      timeoutMs: 1_000,
    });

    assert.equal(result.ok, true, result.error);
    assert.equal(result.output, 'host answer');
    assert.equal(result.inputTokens, 9);
    assert.equal(result.outputTokens, 4);
    assert.equal(result.cacheReadTokens, 2);
    assert.equal(result.cacheCreationTokens, 1);
    assert.equal(result.costReportedByExecutor, false);
    assert.equal(result.toolCalls?.[0]?.sourceTrace?.startsWith('dsh-host:'), true);
    assert.deepEqual(host.created.map(({ cwd, parentSession, provider, model }) => ({
      cwd, parentSession, provider, model,
    })), [{
      cwd: '/project',
      parentSession: 'interactive-session',
      provider: 'configured-provider',
      model: 'measured-model',
    }]);
    assert.deepEqual(host.promptSections, [{
      name: 'omk:evaluation',
      order: 0,
      text: 'only this controlled artifact',
      complete: true,
    }]);
    assert.equal(host.runtimeContextSuppressed, 1);
    assert.deepEqual(host.deniedTools, [['skill']]);
    assert.equal(host.disposed, 1);
  });

  it('cancels and disposes only the measurement agent on timeout', async () => {
    const host = new FakeDshHost();
    const executor = createDshHostExecutor(host, { parentAgent });
    const result = await executor({
      model: 'measured-model',
      prompt: '__hang__',
      timeoutMs: 5,
    });

    assert.equal(result.ok, false);
    assert.equal(result.stopReason, 'timeout');
    assert.match(result.error ?? '', /timed out/);
    assert.equal(host.disposed, 1);
  });

  it('rejects partial skill isolation before creating a DSH agent', async () => {
    const host = new FakeDshHost();
    const executor = createDshHostExecutor(host, { parentAgent });
    const result = await executor({
      model: 'measured-model',
      prompt: 'test',
      allowedSkills: ['ambient-skill'],
    });

    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /非空 skill 白名单/);
    assert.equal(host.created.length, 0);
  });
});

describe('DSH bundle metadata', () => {
  it('makes the published OMK package directly installable into a DSH profile', () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      dsh?: { bundle?: { patch?: string } };
    };
    assert.equal(manifest.dsh?.bundle?.patch, './dist/dsh-plugin/cordis.patch.yml');
    const patch = load(readFileSync(join(process.cwd(), 'src/dsh-plugin/cordis.patch.yml'), 'utf8')) as Array<{
      insert?: Array<{ id?: string; name?: string }>;
    }>;
    assert.deepEqual(patch[0]?.insert?.[0], {
      id: 'omk',
      name: 'oh-my-knowledge/dist/dsh-plugin/index.js',
    });
  });
});
