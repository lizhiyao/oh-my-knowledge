import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { afterEach, describe, it, vi } from 'vitest';
import {
  createDshHostExecutor,
  type DshAgentLike,
  type DshHostContextLike,
  type DshSessionLike,
} from '../../src/dsh-plugin/host-executor.js';
import { apply, inject } from '../../src/dsh-plugin/index.js';
import {
  buildManagedArtifactRecord,
  hashArtifactSource,
  loadManagedRecord,
  managedDir,
  managedRecordId,
  upsertManagedRecord,
} from '../../src/managed/index.js';
import { createEvalSampleSetDocument } from '../../src/inputs/schemas/sample-set.js';

type UnknownRecord = Record<string, unknown>;

class FakeDshHost implements DshHostContextLike {
  readonly created: Array<{
    sessionId: string;
    cwd: string;
    parentSession?: string;
    agentPreset?: string;
    provider?: string;
    model: string;
  }> = [];
  readonly promptSections: UnknownRecord[] = [];
  readonly deniedTools: string[][] = [];
  readonly composedPresets: Array<{ agentCtx: object; parentCtx: object }> = [];
  disposed = 0;
  runtimeContextSuppressed = 0;
  private readonly eventListeners = new Set<(session: DshSessionLike, event: UnknownRecord) => void>();
  private readonly createdListeners = new Set<(session: DshSessionLike) => void>();

  constructor(private readonly behavior: {
    cancelSettles?: boolean;
    disposeSettles?: boolean;
  } = {}, private readonly activePreset = 'standard') {}

  readonly agentPresets = {
    composedPreset: () => this.activePreset,
    composeFrom: (agentCtx: object, parentCtx: object) => {
      this.composedPresets.push({ agentCtx, parentCtx });
      return this.activePreset;
    },
  };

  readonly tools = {
    schemas: () => [
      { name: 'read', description: 'read files', parameters: { type: 'object' } },
      { name: 'skill', description: 'ambient skills', parameters: { type: 'object' } },
    ],
  };

  readonly agents = {
    create: async (options: Parameters<DshHostContextLike['agents']['create']>[0]) => {
      const events: UnknownRecord[] = [];
      const session: DshSessionLike = {
        id: options.sessionId,
        events,
        header: {
          cwd: options.meta.cwd,
          ...(options.meta.parentSession ? { parentSession: options.meta.parentSession } : {}),
          ...(options.meta.agentPreset ? { agentPreset: options.meta.agentPreset } : {}),
        },
      };
      let settle: (() => void) | undefined;
      let idle = Promise.resolve();
      type SetupContext = Parameters<typeof options.setup>[0];
      const scope = { agent: undefined as DshAgentLike | undefined };
      const agentCtx: SetupContext = {
        get agent() { return scope.agent; },
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
            this.deniedTools.push([...(filter.deny ?? [])]);
            return () => undefined;
          },
        },
      };
      const agent: DshAgentLike = {
        id: options.sessionId,
        options: options.agentOptions,
        ctx: agentCtx,
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
          if (this.behavior.cancelSettles !== false) settle?.();
        },
      };
      scope.agent = agent;
      options.setup(agentCtx);
      this.created.push({
        sessionId: options.sessionId,
        cwd: options.meta.cwd,
        ...(options.meta.parentSession ? { parentSession: options.meta.parentSession } : {}),
        ...(options.meta.agentPreset ? { agentPreset: options.meta.agentPreset } : {}),
        ...(options.agentOptions.provider ? { provider: options.agentOptions.provider } : {}),
        model: options.agentOptions.model,
      });
      for (const listener of this.createdListeners) listener(session);
      return {
        agent,
        dispose: async () => {
          this.disposed += 1;
          if (this.behavior.disposeSettles === false) await new Promise<void>(() => undefined);
        },
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
  ctx: { name: 'interactive-agent-context' },
  session: {
    id: 'interactive-session',
    events: [],
    header: { cwd: '/project', agentPreset: 'standard' },
  },
  followup() {},
  whenIdle: () => Promise.resolve(),
  cancel() {},
} satisfies DshAgentLike;

describe('DSH host executor', () => {
  afterEach(() => vi.useRealTimers());

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
    assert.deepEqual(host.created.map(({ cwd, parentSession, agentPreset, provider, model }) => ({
      cwd, parentSession, agentPreset, provider, model,
    })), [{
      cwd: '/project',
      parentSession: 'interactive-session',
      agentPreset: 'standard',
      provider: 'configured-provider',
      model: 'measured-model',
    }]);
    assert.equal(host.composedPresets.length, 1);
    assert.equal(host.composedPresets[0]?.parentCtx, parentAgent.ctx);
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

  it('uses the shared default timeout when the eval config omits timeoutMs', async () => {
    vi.useFakeTimers();
    const { DEFAULT_TIMEOUT_MS } = await import('../../src/executors/core/limits.js');
    const host = new FakeDshHost();
    const executor = createDshHostExecutor(host, { parentAgent });
    const pending = executor({ model: 'measured-model', prompt: '__hang__' });

    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS);
    const result = await pending;

    assert.equal(result.stopReason, 'timeout');
    assert.match(result.error ?? '', new RegExp(String(DEFAULT_TIMEOUT_MS)));
    assert.equal(host.disposed, 1);
  });

  it('returns after a bounded cleanup grace when cancellation and disposal never settle', async () => {
    const host = new FakeDshHost({ cancelSettles: false, disposeSettles: false });
    const executor = createDshHostExecutor(host, {
      parentAgent,
      cleanupTimeoutMs: 5,
    });
    const startedAt = Date.now();
    const result = await executor({
      model: 'measured-model',
      prompt: '__hang__',
      timeoutMs: 5,
    });

    assert.equal(result.stopReason, 'timeout');
    assert.match(result.error ?? '', /cancellation did not settle within 5ms/);
    assert.ok(Date.now() - startedAt < 500);
    assert.equal(host.disposed, 1);
  });

  it('binds the runtime fingerprint to the effective host composition', () => {
    const first = createDshHostExecutor(new FakeDshHost(), { parentAgent });
    const otherParent = {
      ...parentAgent,
      options: { ...parentAgent.options, provider: 'other-provider' },
    } satisfies DshAgentLike;
    const second = createDshHostExecutor(new FakeDshHost(), { parentAgent: otherParent });
    const firstRuntime = first.runtimeFingerprint?.('measured-model');
    const secondRuntime = second.runtimeFingerprint?.('measured-model');

    assert.equal(firstRuntime?.auditability?.status, 'partial');
    assert.match(firstRuntime?.binary?.contentHash ?? '', /^[a-f0-9]{64}$/);
    assert.equal(firstRuntime?.sdk?.name, 'oh-my-knowledge');
    assert.notEqual(firstRuntime?.fingerprint, secondRuntime?.fingerprint);
  });

  it('uses the live parent preset instead of the possibly stale session header', async () => {
    const host = new FakeDshHost({}, 'minimal');
    const executor = createDshHostExecutor(host, { parentAgent });
    const result = await executor({ model: 'measured-model', prompt: 'test' });

    assert.equal(result.ok, true, result.error);
    assert.equal(parentAgent.session.header.agentPreset, 'standard');
    assert.equal(host.created[0]?.agentPreset, 'minimal');
    const standard = createDshHostExecutor(new FakeDshHost({}, 'standard'), { parentAgent });
    assert.notEqual(
      executor.runtimeFingerprint?.('measured-model').fingerprint,
      standard.runtimeFingerprint?.('measured-model').fingerprint,
    );
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
      keywords?: string[];
    };
    assert.equal(manifest.dsh?.bundle?.patch, './dist/dsh-plugin/cordis.patch.yml');
    assert.ok(manifest.keywords?.includes('deepseek-harness'));
    assert.ok(manifest.keywords?.includes('dsh-plugin'));
    const patch = load(readFileSync(join(process.cwd(), 'src/dsh-plugin/cordis.patch.yml'), 'utf8')) as Array<{
      insert?: Array<{ id?: string; name?: string }>;
    }>;
    assert.deepEqual(patch[0]?.insert?.[0], {
      id: 'omk',
      name: 'oh-my-knowledge/dsh-plugin',
    });
    assert.ok(inject.includes('agentPresets'));
    assert.ok(!inject.includes('systemPrompt'));
  });
});

describe('DSH plugin discovery', () => {
  it('confirms the installed integration and presents both user entrypoints', async () => {
    let definition: {
      description: string;
      handler: (invocation: Record<string, unknown>) => Promise<{ kind: string; text?: string }>;
    } | undefined;
    const dispose = apply({
      commands: {
        register(value: typeof definition) {
          definition = value;
          return () => undefined;
        },
      },
    } as never);
    assert.ok(definition);
    assert.match(definition.description, /对照评测或查看任务轨迹/u);
    const invocation = {
      agent: parentAgent,
      signal: new AbortController().signal,
    };
    for (const rawInput of ['', 'help']) {
      const result = await definition.handler({ ...invocation, rawInput });
      assert.equal(result.kind, 'success');
      assert.match(result.text ?? '', /已接入当前 DeepSeek Harness/u);
      assert.match(result.text ?? '', /\/omk eval <eval\.yaml>/u);
      assert.match(result.text ?? '', /\/omk observe <session-id>/u);
      assert.match(result.text ?? '', /oh-my-knowledge\.pages\.dev/u);
    }
    dispose();
  });
});

describe('DSH plugin config boundary', () => {
  async function invokeConfig(yaml: string): Promise<{
    kind: string;
    text?: string;
    created: number;
    models: string[];
    artifactFiles: string[];
    graphFiles: string[];
    managedEvidenceCount: number;
  }> {
    const dir = mkdtempSync(join(tmpdir(), 'omk-dsh-config-'));
    try {
      writeFileSync(join(dir, 'eval.yaml'), yaml);
      writeFileSync(join(dir, 'samples.json'), JSON.stringify(createEvalSampleSetDocument([{
        sample_id: 's1',
        prompt: 'test',
        assertions: [{ type: 'contains', value: 'host' }],
      }])));
      mkdirSync(join(dir, 'skills'));
      const skillPath = join(dir, 'skills', 'review.md');
      writeFileSync(skillPath, '# Review\nReturn a host-backed answer.\n');
      const managed = managedDir(dir);
      upsertManagedRecord(managed, buildManagedArtifactRecord({
        name: 'review',
        kind: 'skill',
        source: { sourceKind: 'file', locator: skillPath, isDirectorySkill: false },
        contentHash: hashArtifactSource(skillPath, false),
        installedAt: '2026-09-01T00:00:00.000Z',
        distribution: [],
      }));
      const host = new FakeDshHost();
      let handler: ((invocation: UnknownRecord) => unknown) | undefined;
      const ctx = Object.assign(host, {
        commands: {
          register(definition: { handler: (invocation: UnknownRecord) => unknown }) {
            handler = definition.handler;
            return () => undefined;
          },
        },
      });
      apply(ctx as never);
      assert.ok(handler);
      const result = await handler({
        agent: {
          ...parentAgent,
          session: { ...parentAgent.session, header: { ...parentAgent.session.header, cwd: dir } },
        },
        rawInput: 'eval eval.yaml',
        signal: new AbortController().signal,
      }) as { kind: string; text?: string };
      const reportsDir = join(dir, '.omk', 'eval');
      return {
        ...result,
        created: host.created.length,
        models: host.created.map(({ model }) => model),
        artifactFiles: existsSync(reportsDir)
          ? readdirSync(reportsDir, { recursive: true, encoding: 'utf8' }).sort()
          : [],
        graphFiles: existsSync(reportsDir)
          ? readdirSync(reportsDir, { recursive: true, encoding: 'utf8' })
            .filter((file) => file.endsWith('derived/graph.json'))
            .sort()
          : [],
        managedEvidenceCount: loadManagedRecord(
          managed,
          managedRecordId('skill', 'review'),
        )?.evidence.length ?? 0,
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const minimal = `samples: ./samples.json
variants:
  - name: baseline
    role: control
    artifact: baseline
  - name: review
    role: treatment
    artifact: review
`;

  it('requires omitting the top-level executor inside DSH', async () => {
    const result = await invokeConfig(`${minimal}executor: dsh\n`);
    assert.equal(result.kind, 'error');
    assert.match(result.text ?? '', /删除 eval\.yaml 中的顶层 executor/);
    assert.doesNotMatch(result.text ?? '', /dsh-host/);
  });

  it('rejects the internal dsh-host judge identifier in user config', async () => {
    const result = await invokeConfig(`${minimal}judgeModels:\n  - executor: dsh-host\n    model: measured-model\n`);
    assert.equal(result.kind, 'error');
    assert.match(result.text ?? '', /内部执行器标识/);
    assert.match(result.text ?? '', /executor: dsh/);
  });

  it('rejects generic OMK effort instead of recording an option DSH did not run', async () => {
    const result = await invokeConfig(`${minimal}effort: high\n`);
    assert.equal(result.kind, 'error');
    assert.match(result.text ?? '', /无法与 OMK 五档无损映射/);
    assert.match(result.text ?? '', /删除 eval\.yaml 中的 effort/);
  });

  it('reuses inherited host connectivity without extra model calls', async () => {
    const result = await invokeConfig(`${minimal}noJudge: true\nnoDiagnostic: true\nskipDoctor: true\nnoCache: true\nbootstrap: false\n`);
    assert.equal(result.kind, 'success', result.text);
    assert.equal(result.created, 1);
    assert.ok(result.artifactFiles.some((file) => file.endsWith('manifest.json')));
    assert.ok(result.artifactFiles.some((file) => file.endsWith('report.json')));
    assert.ok(result.artifactFiles.some((file) => file.endsWith('derived/card.md')));
    assert.equal(result.artifactFiles.some((file) => /(^|\/)reports\.json$/u.test(file)), false);
    assert.equal(result.graphFiles.filter((file) => file.endsWith('graph.json')).length, 1);
    assert.equal(result.managedEvidenceCount, 1);
  });

  it('reuses inherited connectivity for the default same-model DSH judge', async () => {
    const result = await invokeConfig(`${minimal}noDiagnostic: true\nskipDoctor: true\nnoCache: true\nbootstrap: false\n`);
    assert.equal(result.kind, 'success', result.text);
    assert.deepEqual(result.models, ['configured-model']);
  });

  it('does not invoke an explicitly configured judge when the sample has no LLM-scored layer', async () => {
    const result = await invokeConfig(`${minimal}noDiagnostic: true\nskipDoctor: true\nnoCache: true\nbootstrap: false\njudgeModels:\n  - executor: dsh\n    model: unproven-judge\n`);
    assert.equal(result.kind, 'success', result.text);
    assert.deepEqual(result.models, ['configured-model']);
  });

  it('ignores unused judge models when noJudge is enabled', async () => {
    const result = await invokeConfig(`${minimal}noJudge: true\nnoDiagnostic: true\nskipDoctor: true\nnoCache: true\nbootstrap: false\njudgeModels:\n  - executor: dsh\n    model: unused-judge\n`);
    assert.equal(result.kind, 'success', result.text);
    assert.deepEqual(result.models, ['configured-model']);
  });

  it('fails closed on gold loading failures instead of silently ignoring goldDir', async () => {
    const result = await invokeConfig(`${minimal}noJudge: true\nnoDiagnostic: true\nskipDoctor: true\nnoCache: true\nbootstrap: false\ngoldDir: ./missing-gold\n`);
    assert.equal(result.kind, 'error');
    assert.match(result.text ?? '', /无法读取可选宿主资源/);
    assert.equal(result.created, 0);
  });
});
