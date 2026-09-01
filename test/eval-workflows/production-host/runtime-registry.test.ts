import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createNodeEvaluationClock,
  createNodeEvaluationRuntimeSupportPorts,
  createProductionRuntimeFactoryRegistry,
  type ProductionExecutorAdapterConfiguration,
} from '../../../src/eval-workflows/production-host/index.js';

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function configurations(): ReadonlyMap<string, ProductionExecutorAdapterConfiguration> {
  return new Map([
    ['codex', {
      adapterKind: 'codex-cli', command: { executablePath: '/not-probed/codex' },
      preflightDeclarations: [],
    }],
    ['codex-sdk', { adapterKind: 'codex-sdk', sdk: {}, preflightDeclarations: [] }],
    ['claude', {
      adapterKind: 'claude-cli', command: { executablePath: '/not-probed/claude' },
      preflightDeclarations: [],
    }],
    ['claude-sdk', { adapterKind: 'claude-sdk', sdk: {}, preflightDeclarations: [] }],
    ['openai-api', {
      adapterKind: 'openai-api', api: { apiKey: 'not-read-before-use' },
      preflightDeclarations: [],
    }],
    ['anthropic-api', {
      adapterKind: 'anthropic-api', api: { apiKey: 'not-read-before-use' },
      preflightDeclarations: [],
    }],
    ['custom-tool', {
      adapterKind: 'custom-command',
      preflightDeclarations: [],
      runtime: {
        implementationId: 'custom-tool',
        capabilities: {
          schemaVersion: 'omk.executor-capabilities/v1',
          protocols: [],
        },
      },
      command: {
        executablePath: '/not-probed/custom-tool',
      },
    }],
  ] as readonly [string, ProductionExecutorAdapterConfiguration][]);
}

describe('production Runtime registry', () => {
  it('registers every official adapter family lazily and composes single-owner builtins', () => {
    const resolveJudgeInvocation = vi.fn();
    const factories = createProductionRuntimeFactoryRegistry({
      executorsByImplementationId: configurations(),
      resolveJudgeInvocation,
    });

    expect([...factories.executorsByImplementationId.keys()]).toEqual([
      'codex', 'codex-sdk', 'claude', 'claude-sdk',
      'openai-api', 'anthropic-api', 'custom-tool',
    ]);
    expect(factories.evaluatorsByImplementationId.has('omk.assertions.output/v1')).toBe(true);
    expect(factories.evaluatorsByImplementationId.has('omk.assertions.execution/v1')).toBe(true);
    expect(factories.evaluatorsByImplementationId.has('omk.llm-assertions/v2')).toBe(true);
    expect(factories.evaluatorsByImplementationId.has('omk.rubric-judge/v1')).toBe(true);
    expect(factories.analysisNodesByImplementationId.has('omk.bootstrap-family-table/v1')).toBe(true);
    expect(factories.decisionPoliciesByImplementationId.has('omk.release-decision/v1')).toBe(true);
    expect(resolveJudgeInvocation).not.toHaveBeenCalled();
  });

  it('does not register or resolve unused provider-backed judges', () => {
    const factories = createProductionRuntimeFactoryRegistry({
      executorsByImplementationId: new Map([
        ['codex', {
          adapterKind: 'codex-cli', command: { executablePath: '/not-probed/codex' },
          preflightDeclarations: [],
        }],
      ]),
    });
    expect(factories.evaluatorsByImplementationId.has('omk.llm-assertions/v2')).toBe(false);
    expect(factories.evaluatorsByImplementationId.has('omk.rubric-judge/v1')).toBe(false);
  });

  it('captures immutable registry membership before any lazy factory is used', () => {
    const source = new Map(configurations());
    const factories = createProductionRuntimeFactoryRegistry({
      executorsByImplementationId: source,
    });
    source.set('late-executor', {
      adapterKind: 'codex-cli',
      command: { executablePath: '/not-probed/late' },
      preflightDeclarations: [],
    });

    expect(factories.executorsByImplementationId.has('late-executor')).toBe(false);
    expect((factories.executorsByImplementationId as Map<string, unknown>).set).toBeUndefined();
  });

  it('rejects invalid registry configuration with a stable host error', () => {
    expect(() => createProductionRuntimeFactoryRegistry({
      executorsByImplementationId: new Map([[42, undefined]]) as unknown as ReadonlyMap<
        string,
        ProductionExecutorAdapterConfiguration
      >,
    })).toThrow(expect.objectContaining({ code: 'PRODUCTION_RUNTIME_REGISTRY_INVALID' }));
  });

  it('provides abort-aware Node clock and one shared content port', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omk-production-support-'));
    roots.push(root);
    const clock = createNodeEvaluationClock();
    const abort = new AbortController();
    abort.abort(new Error('cancelled'));
    await expect(clock.sleep(1, abort.signal)).rejects.toThrow('cancelled');

    const support = createNodeEvaluationRuntimeSupportPorts({
      contentStoreRoot: join(root, 'content'),
      clock,
    });
    expect(support.clock).toBe(clock);
    expect(support.executionContentStore).toBe(support.evaluationContentStore);
    expect(support.evaluationContentStore).toBe(support.contentResolver);
  });

  it('rejects a content store path that depends on ambient cwd', () => {
    expect(() => createNodeEvaluationRuntimeSupportPorts({
      contentStoreRoot: 'relative/content',
    })).toThrow(expect.objectContaining({ code: 'PRODUCTION_RUNTIME_REGISTRY_INVALID' }));
  });
});
