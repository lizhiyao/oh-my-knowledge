import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  compileCliEvaluationInput,
  parseCliEvaluationRequest,
} from '../../../src/eval-workflows/input-compilation/index.js';
import { resolveNodeCliEvaluationRequest } from '../../../src/eval-workflows/production-host/index.js';
import {
  createEvalSampleSetDocument,
} from '../../../src/eval-workflows/inputs/schemas/sample-set.js';
import {
  BOOTSTRAP_FAMILY_ANALYSIS_V2_IMPLEMENTATION_ID,
  RELEASE_DECISION_POLICY_V7_IMPLEMENTATION_ID,
} from '../../../src/eval-workflows/runtime-adapter/analysis/index.js';
import type { Sample } from '../../../src/eval-workflows/inputs/contracts/sample.js';

const roots: string[] = [];

const sampleSetJson = (
  samples: Sample[],
  requires?: Parameters<typeof createEvalSampleSetDocument>[1],
): string => JSON.stringify(createEvalSampleSetDocument(samples, requires));

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `omk-production-resolver-${label}-`));
  roots.push(root);
  await mkdir(join(root, 'skills'));
  await mkdir(join(root, 'fixtures'));
  await writeFile(join(root, 'skills', 'control.md'), '# Control\nAnswer directly.\n');
  await writeFile(join(root, 'skills', 'treatment.md'), '# Treatment\nUse the supplied knowledge.\n');
  await writeFile(join(root, 'skills', 'treatment-2.md'), '# Treatment 2\nUse concise knowledge.\n');
  await writeFile(join(root, 'fixtures', 'secret.json'), JSON.stringify({ token: 'secret-value' }));
  await writeFile(join(root, 'samples.json'), sampleSetJson([{
    sample_id: 'sample-a',
    prompt: 'Return a concise JSON answer.',
    rubric: {
      quality: { criterion: 'The response is correct and concise.', weight: 1 },
    },
    assertions: [
      { type: 'json_valid', weight: 2 },
      { type: 'tools_count_max', value: 1 },
      { type: 'semantic_similarity', reference: '{"ok":true}', threshold: 3 },
    ],
    mocks: [{
      tool: 'Bash',
      match: { command_glob: 'printf match-secret-value*' },
      return_file: 'fixtures/secret.json',
    }],
    mocksStrict: true,
  }]));
  return root;
}

function request(root: string, additionalFlags: Readonly<Record<string, unknown>> = {}) {
  return parseCliEvaluationRequest({
    explicitCliFlags: {
      control: 'skills/control.md',
      treatment: 'skills/treatment.md',
      samples: 'samples.json',
      'skill-dir': 'skills',
      executor: 'claude',
      model: 'claude-test',
      'judge-models': 'anthropic-api:judge-test',
      'no-serve': true,
      'output-dir': '.omk/eval',
      ...additionalFlags,
    },
    defaults: {
      samplesLocator: 'samples.json',
      skillDirectoryLocator: 'skills',
      targetRuntime: { executorId: 'claude', model: 'claude-test', effort: 'low' },
      judgeMembers: [{ executorId: 'anthropic-api', model: 'judge-test' }],
      presentation: {
        projectOutputDirectoryLocator: join(root, '.omk', 'eval'),
        globalOutputDirectoryLocator: join(root, '.omk-global', 'eval'),
        language: 'zh',
        languageDefaultSource: 'environment-selection',
      },
    },
  });
}

describe('resolveNodeCliEvaluationRequest', () => {
  it('classifies MCP config as secret because it may contain credentials', async () => {
    const root = await fixture('mcp-config-classification');
    await writeFile(join(root, 'mcp.json'), JSON.stringify({
      mcpServers: {
        docs: {
          command: 'node',
          env: { DOCS_TOKEN: 'credential' },
        },
      },
    }));

    const resolved = await resolveNodeCliEvaluationRequest(request(root, {
      'mcp-config': 'mcp.json',
    }), {
      projectRoot: root,
      materializationRoot: join(root, '.omk', 'resolved'),
    });
    const mcpConfig = resolved.hostResources.resources.find((resource) => (
      resource.resourceKind === 'mcp-config'
    ));

    expect(mcpConfig?.descriptor.classification).toBe('secret');
  });

  it('resolves URL content before Dataset compilation and seals provenance outside measurement identity', async () => {
    const root = await fixture('sample-content');
    await writeFile(join(root, 'samples.json'), sampleSetJson([{
      sample_id: 'sample-a',
      prompt: 'Use https://docs.acme.dev/spec twice: https://docs.acme.dev/spec.',
      context: 'Context https://docs.acme.dev/spec',
      rubric: {
        quality: { criterion: 'Correct.', weight: 1 },
      },
    }]));
    const resolveContent = vi.fn(async () => ({
      content: 'Authoritative specification bytes.',
      mediaType: 'text/plain',
      transportKind: 'mcp' as const,
      classification: 'sensitive' as const,
    }));
    const close = vi.fn(async () => undefined);
    const resolved = await resolveNodeCliEvaluationRequest(request(root), {
      projectRoot: root,
      materializationRoot: join(root, '.omk', 'resolved'),
      sampleContentResolver: { resolve: resolveContent, close },
    });
    const content = resolved.hostResources.resources.find((resource) => (
      resource.resourceKind === 'content'
    ));
    const datasetInput = resolved.dataset.samples[0]?.input;
    if (typeof datasetInput !== 'string') throw new Error('expected string Dataset input');

    expect(resolveContent).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(datasetInput.match(/Authoritative specification bytes\./g)).toHaveLength(3);
    expect(content).toBeDefined();
    expect(content?.descriptor.classification).toBe('sensitive');
    expect(await readFile(content!.locator, 'utf8')).toBe('Authoritative specification bytes.');
    expect(JSON.stringify(content?.lineage)).not.toContain('https://docs.acme.dev/spec');
    expect(content?.lineage).toMatchObject({
      lineageKind: 'sample-url-content',
      sourceUrlDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      transportKind: 'mcp',
      sampleIds: ['sample-a'],
      fields: ['context', 'prompt'],
    });
    expect(resolved.staticRunMetadata?.annotations).toMatchObject({
      sampleContentResolution: [expect.objectContaining({
        resourceId: content?.descriptor.resourceId,
        contentDigest: content?.descriptor.digest,
      })],
    });
  });

  it('binds resolved URL bytes into the Definition digest but not the transport', async () => {
    const root = await fixture('sample-content-identity');
    await writeFile(join(root, 'samples.json'), sampleSetJson([{
      sample_id: 'sample-a', prompt: 'Use https://docs.acme.dev/spec', rubric: {
        quality: { criterion: 'Correct.', weight: 1 },
      },
    }]));
    const compileWith = async (content: string, transportKind: 'http' | 'mcp') => (
      compileCliEvaluationInput(await resolveNodeCliEvaluationRequest(request(root), {
        projectRoot: root,
        materializationRoot: join(root, '.omk', `resolved-${content.length}-${transportKind}`),
        sampleContentResolver: {
          resolve: async () => ({
            content,
            mediaType: 'text/plain',
            transportKind,
            classification: transportKind === 'mcp' ? 'sensitive' : 'public',
          }),
          close: async () => undefined,
        },
      }))
    );
    const [mcp, http, changed] = await Promise.all([
      compileWith('same bytes', 'mcp'),
      compileWith('same bytes', 'http'),
      compileWith('changed bytes', 'mcp'),
    ]);

    expect(mcp.canonicalDigests.definition).toBe(http.canonicalDigests.definition);
    expect(mcp.canonicalDigests.definition).not.toBe(changed.canonicalDigests.definition);
    expect(mcp.hostResources.resources.find((item) => item.resourceKind === 'content')
      ?.descriptor.classification).toBe('sensitive');
    expect(http.hostResources.resources.find((item) => item.resourceKind === 'content')
      ?.descriptor.classification).toBe('public');
  });

  it('fails closed and still closes the one-shot resolver session', async () => {
    const root = await fixture('sample-content-failure');
    await writeFile(join(root, 'samples.json'), sampleSetJson([{
      sample_id: 'sample-a', prompt: 'Use https://docs.acme.dev/spec', rubric: {
        quality: { criterion: 'Correct.', weight: 1 },
      },
    }]));
    const close = vi.fn(async () => undefined);

    await expect(resolveNodeCliEvaluationRequest(request(root), {
      projectRoot: root,
      materializationRoot: join(root, '.omk', 'resolved'),
      sampleContentResolver: {
        resolve: async () => { throw new Error('network unavailable'); },
        close,
      },
    })).rejects.toMatchObject({
      code: 'CLI_INPUT_RESOLUTION_FAILED',
      fieldPath: 'samples.externalContent',
      message: expect.stringContaining('不会退回原始 URL'),
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('normalizes unsafe URL syntax failures into the stable CLI resolution envelope', async () => {
    const root = await fixture('sample-content-credentials');
    await writeFile(join(root, 'samples.json'), sampleSetJson([{
      sample_id: 'sample-a',
      prompt: 'Use https://user:secret@docs.acme.dev/spec',
      rubric: {
        quality: { criterion: 'Correct.', weight: 1 },
      },
    }]));

    await expect(resolveNodeCliEvaluationRequest(request(root), {
      projectRoot: root,
      materializationRoot: join(root, '.omk', 'resolved'),
    })).rejects.toMatchObject({
      code: 'CLI_INPUT_RESOLUTION_FAILED',
      fieldPath: 'samples.externalContent',
      sourcePath: 'https://docs.acme.dev',
      message: expect.stringContaining('用户名或密码'),
    });
  });

  it('reports actionable storage guidance without exposing artifact paths', async () => {
    const root = await fixture('artifact-storage-failure');
    for (const name of ['control-dir', 'treatment-dir']) {
      await mkdir(join(root, 'skills', name));
      await writeFile(join(root, 'skills', name, 'SKILL.md'), `# ${name}\nSafe content.\n`);
    }
    const unavailableRoot = join(root, 'not-a-directory');
    await writeFile(unavailableRoot, 'blocks directory materialization');
    vi.stubEnv('OMK_TREES_DIR', unavailableRoot);

    const failure = await resolveNodeCliEvaluationRequest(request(root, {
      control: 'control-dir',
      treatment: 'treatment-dir',
    }), {
      projectRoot: root,
      materializationRoot: join(root, '.omk', 'resolved'),
    }).catch((cause: unknown) => cause);

    expect(failure).toMatchObject({
      code: 'CLI_INPUT_RESOLUTION_FAILED',
      fieldPath: 'variants',
      details: {
        resolutionFailureKind: 'artifact-materialization-storage',
        systemCode: 'EEXIST',
      },
    });
    expect((failure as Error).message).toContain('OMK_HOME');
    expect((failure as Error).message).toContain('OMK_TREES_DIR');
    expect((failure as Error).message).toContain('EEXIST');
    expect((failure as Error).message).not.toContain(root);
  });

  it('resolves real files into a compilable five-layer design without leaking secret mock controls', async () => {
    const root = await fixture('compile');
    const resolved = await resolveNodeCliEvaluationRequest(request(root), {
      projectRoot: root,
      materializationRoot: join(root, '.omk', 'resolved'),
    });
    const compiled = compileCliEvaluationInput(resolved);

    expect(compiled.definition.evaluators.map((evaluator) => evaluator.implementationId)).toEqual(
      expect.arrayContaining([
        'omk.assertions.output/v1',
        'omk.assertions.execution/v1',
        'omk.llm-assertions/v2',
        'omk.rubric-judge/v1',
      ]),
    );
    expect(compiled.definition.analysisGraph.nodes.map((node) => node.implementationId)).toEqual(
      expect.arrayContaining([
        'omk.assertion-layer-table/v1',
        'omk.dimension-table/v2',
        'omk.composite-table/v2',
        'omk.bootstrap-family-table/v2',
      ]),
    );
    expect(compiled.definition.experiment.sampling.seedCoupling).toBe('uncontrolled');
    expect(JSON.stringify(compiled.definition)).not.toContain('secret-value');
    expect(JSON.stringify(compiled.definition)).not.toContain('match-secret-value');
    expect(compiled.hostResources.resources.some((resource) => (
      resource.resourceKind === 'mock-rule'
      && resource.descriptor.classification === 'secret'
      && resource.descriptor.mediaType === 'application/json'
    ))).toBe(true);
    expect(compiled.hostResources.resources.some((resource) => (
      resource.resourceKind === 'mock-payload'
      && resource.descriptor.classification === 'secret'
    ))).toBe(true);
    expect(Object.isFrozen(resolved)).toBe(true);
  });

  it('materializes inline mock rules and payloads in a private resolver-owned store', async () => {
    const root = await fixture('private-materialization');
    await writeFile(join(root, 'samples.json'), sampleSetJson([{
      sample_id: 'sample-a',
      prompt: 'A',
      rubric: {
        quality: { criterion: 'Correct.', weight: 1 },
      },
      mocks: [{ tool: 'Read', return: { token: 'inline-secret' } }],
    }]));
    const resolved = await resolveNodeCliEvaluationRequest(request(root), {
      projectRoot: root,
      materializationRoot: join(root, '.omk', 'resolved'),
    });
    const payload = resolved.hostResources.resources.find(
      (resource) => resource.resourceKind === 'mock-payload',
    );
    const rule = resolved.hostResources.resources.find(
      (resource) => resource.resourceKind === 'mock-rule',
    );

    expect(payload).toBeDefined();
    expect(rule).toBeDefined();
    expect((await stat(payload!.locator)).mode & 0o777).toBe(0o600);
    expect((await stat(rule!.locator)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(rule!.locator, 'utf8'))).toEqual({ tool: 'Read' });
    expect((await stat(join(root, '.omk', 'resolved', 'content'))).mode & 0o777).toBe(0o700);
  });

  it('binds secret mock-rule bytes into measurement identity', async () => {
    const root = await fixture('mock-rule-identity');
    const compileWith = async (commandGlob: string, suffix: string) => {
      await writeFile(join(root, 'samples.json'), sampleSetJson([{
        sample_id: 'sample-a',
        prompt: 'A',
        rubric: {
          quality: { criterion: 'Correct.', weight: 1 },
        },
        mocks: [{
          tool: 'Bash',
          match: { command_glob: commandGlob },
          return: { stdout: 'stable' },
        }],
      }]));
      return compileCliEvaluationInput(await resolveNodeCliEvaluationRequest(request(root), {
        projectRoot: root,
        materializationRoot: join(root, '.omk', `resolved-${suffix}`),
      }));
    };
    const first = await compileWith('printf first-secret*', 'first');
    const second = await compileWith('printf second-secret*', 'second');

    expect(first.canonicalDigests.definition).not.toBe(second.canonicalDigests.definition);
    expect(JSON.stringify(first.definition)).not.toContain('first-secret');
    expect(JSON.stringify(second.definition)).not.toContain('second-secret');
  });

  it('fails closed for unmatched mocked tools unless the sample explicitly opts out', async () => {
    const root = await fixture('mock-strict-default');
    await writeFile(join(root, 'samples.json'), sampleSetJson([{
      sample_id: 'sample-default',
      prompt: 'A',
      rubric: {
        quality: { criterion: 'Correct.', weight: 1 },
      },
      mocks: [{ tool: 'Read', return: 'default' }],
    }, {
      sample_id: 'sample-opt-out',
      prompt: 'B',
      rubric: {
        quality: { criterion: 'Correct.', weight: 1 },
      },
      mocks: [{ tool: 'Read', return: 'opt-out' }],
      mocksStrict: false,
    }]));

    const resolved = await resolveNodeCliEvaluationRequest(request(root), {
      projectRoot: root,
      materializationRoot: join(root, '.omk', 'resolved'),
    });
    const bindings = resolved.targets[0]?.behavior.mocks;

    expect(bindings?.map((binding) => ({
      sampleIds: binding.sampleIds,
      strict: binding.strict,
    }))).toEqual([
      { sampleIds: ['sample-default'], strict: true },
      { sampleIds: ['sample-opt-out'], strict: false },
    ]);
  });

  it('binds a custom Runtime implementation into every sealed executor lease', async () => {
    const root = await fixture('custom-runtime-lease');
    const executable = join(root, 'runtime.sh');
    await writeFile(executable, '#!/bin/sh\nexit 0\n');
    await chmod(executable, 0o700);
    const compiled = compileCliEvaluationInput(await resolveNodeCliEvaluationRequest(request(root, {
      executor: 'runtime.sh',
    }), {
      projectRoot: root,
      materializationRoot: join(root, '.omk', 'resolved'),
    }));
    const runtime = compiled.hostResources.resources.find((resource) => (
      resource.resourceKind === 'runtime-implementation'
    ));
    expect(runtime).toBeDefined();
    expect(runtime!.descriptor.classification).toBe('sensitive');
    expect(compiled.definition.targets.every((target) => (
      target.executorId === `custom-command-${runtime!.descriptor.digest.slice('sha256:'.length)}`
    ))).toBe(true);
    const executorBindings = compiled.runtimeBinding.bindings.filter((binding) => (
      binding.runtimeKind === 'executor'
    ));
    expect(executorBindings.every((binding) => binding.resourceLeaseRequirements.some((requirement) => (
      requirement.resourceRole === 'runtime-implementation'
      && requirement.resourceId === runtime!.descriptor.resourceId
      && requirement.leaseMode === 'immutable-snapshot'
    )))).toBe(true);
  });

  it('keeps behavior digests invariant when identical bytes move to another root', async () => {
    const first = await fixture('move-a');
    const second = await fixture('move-b');
    const [left, right] = await Promise.all([first, second].map(async (root) => (
      compileCliEvaluationInput(await resolveNodeCliEvaluationRequest(request(root), {
        projectRoot: root,
        materializationRoot: join(root, '.omk', 'resolved'),
      }))
    )));

    expect(left.canonicalDigests.definition).toBe(right.canonicalDigests.definition);
    expect(left.canonicalDigests.policy).toBe(right.canonicalDigests.policy);
    expect(left.hostResources.resources.map((resource) => resource.locator)).not.toEqual(
      right.hostResources.resources.map((resource) => resource.locator),
    );
  });

  it('retains distinct target lineage when artifact bytes are identical', async () => {
    const root = await fixture('duplicate-artifact-bytes');
    await writeFile(
      join(root, 'skills', 'treatment.md'),
      await readFile(join(root, 'skills', 'control.md')),
    );
    const resolved = await resolveNodeCliEvaluationRequest(request(root), {
      projectRoot: root,
      materializationRoot: join(root, '.omk', 'resolved'),
    });
    const artifacts = resolved.hostResources.resources.filter(
      (resource) => resource.resourceKind === 'artifact',
    );

    expect(artifacts).toHaveLength(2);
    expect(new Set(artifacts.map((resource) => resource.descriptor.digest)).size).toBe(1);
    expect(new Set(artifacts.map((resource) => resource.descriptor.resourceId)).size).toBe(2);
    expect(new Set(artifacts.map((resource) => resource.locator)).size).toBe(1);
    expect(new Set(artifacts.map((resource) => (
      (resource.lineage as { targetId?: string }).targetId
    )))).toEqual(new Set(['control', 'treatment']));
  });

  it('seals file artifacts before preflight so source drift cannot change measured bytes', async () => {
    const root = await fixture('sealed-file-artifact');
    const resolved = await resolveNodeCliEvaluationRequest(request(root), {
      projectRoot: root,
      materializationRoot: join(root, '.omk', 'resolved'),
    });
    const treatment = resolved.hostResources.resources.find((resource) => (
      resource.resourceKind === 'artifact'
      && (resource.lineage as { targetId?: string }).targetId === 'treatment'
    ));
    expect(treatment).toBeDefined();
    expect(treatment!.locator).not.toBe(join(root, 'skills', 'treatment.md'));
    const sealed = await readFile(treatment!.locator, 'utf8');
    await writeFile(join(root, 'skills', 'treatment.md'), '# drifted after resolve\n');
    expect(await readFile(treatment!.locator, 'utf8')).toBe(sealed);
  });

  it('compiles equivalent CLI and eval.yaml requests to the same measurement digests', async () => {
    const root = await fixture('source-equivalence');
    const fromConfig = parseCliEvaluationRequest({
      explicitCliFlags: {},
      evalConfig: {
        samples: 'samples.json',
        executor: 'claude',
        model: 'claude-test',
        judgeModels: [{ executor: 'anthropic-api', model: 'judge-test' }],
        variants: [{
          name: 'control', role: 'control', artifact: 'skills/control.md',
        }, {
          name: 'treatment', role: 'treatment', artifact: 'skills/treatment.md',
        }],
      },
      defaults: {
        samplesLocator: 'samples.json',
        skillDirectoryLocator: 'skills',
        targetRuntime: { executorId: 'claude', model: 'claude-test', effort: 'low' },
        judgeMembers: [{ executorId: 'anthropic-api', model: 'judge-test' }],
        presentation: {
          projectOutputDirectoryLocator: join(root, '.omk', 'eval'),
          globalOutputDirectoryLocator: join(root, '.omk-global', 'eval'),
          language: 'zh',
          languageDefaultSource: 'environment-selection',
        },
      },
    });
    const [cli, yaml] = await Promise.all([
      request(root),
      fromConfig,
    ].map(async (value, index) => compileCliEvaluationInput(
      await resolveNodeCliEvaluationRequest(value, {
        projectRoot: root,
        materializationRoot: join(root, '.omk', `resolved-${index}`),
      }),
    )));

    expect(cli.canonicalDigests).toEqual(yaml.canonicalDigests);
  });

  it('seals multiple treatments into one planned correction family', async () => {
    const root = await fixture('multiple-treatments');
    const fromConfig = parseCliEvaluationRequest({
      explicitCliFlags: {},
      evalConfig: {
        samples: 'samples.json',
        executor: 'claude',
        model: 'claude-test',
        judgeModels: [{ executor: 'anthropic-api', model: 'judge-test' }],
        variants: [{
          name: 'control', role: 'control', artifact: 'skills/control.md',
        }, {
          name: 'treatment', role: 'treatment', artifact: 'skills/treatment.md',
        }, {
          name: 'treatment-2', role: 'treatment', artifact: 'skills/treatment-2.md',
        }],
      },
      defaults: {
        samplesLocator: 'samples.json',
        skillDirectoryLocator: 'skills',
        targetRuntime: { executorId: 'claude', model: 'claude-test', effort: 'low' },
        judgeMembers: [{ executorId: 'anthropic-api', model: 'judge-test' }],
        presentation: {
          projectOutputDirectoryLocator: join(root, '.omk', 'eval'),
          globalOutputDirectoryLocator: join(root, '.omk-global', 'eval'),
          language: 'zh',
          languageDefaultSource: 'environment-selection',
        },
      },
    });
    const compiled = compileCliEvaluationInput(await resolveNodeCliEvaluationRequest(fromConfig, {
      projectRoot: root,
      materializationRoot: join(root, '.omk', 'resolved'),
    }));

    expect(compiled.definition.decisionPolicy?.comparisonFamily).toHaveLength(2);
    expect(compiled.definition.decisionPolicy?.multipleComparisonPolicyId).toBe(
      BOOTSTRAP_FAMILY_ANALYSIS_V2_IMPLEMENTATION_ID,
    );
    expect(compiled.definition.analysisGraph.nodes.find(
      (node) => node.implementationId === BOOTSTRAP_FAMILY_ANALYSIS_V2_IMPLEMENTATION_ID,
    )?.parameters).toMatchObject({ comparisons: [{}, {}] });
  });

  it('seals heterogeneous sample workspaces and tool policies without flattening them', async () => {
    const root = await fixture('controls');
    await mkdir(join(root, 'workspace-a'));
    await mkdir(join(root, 'workspace-b'));
    await writeFile(join(root, 'workspace-a', 'identity.txt'), 'workspace-a');
    await writeFile(join(root, 'workspace-b', 'identity.txt'), 'workspace-b');
    await writeFile(join(root, 'samples.json'), sampleSetJson([{
      sample_id: 'sample-a', prompt: 'A', rubric: {
        quality: { criterion: 'Correct.', weight: 1 },
      },
      cwd: 'workspace-a', allowedTools: ['Read'],
    }, {
      sample_id: 'sample-b', prompt: 'B', rubric: {
        quality: { criterion: 'Correct.', weight: 1 },
      },
      cwd: 'workspace-b', allowedTools: ['Bash'],
    }]));

    const resolved = await resolveNodeCliEvaluationRequest(request(root), {
      projectRoot: root,
      materializationRoot: join(root, '.omk', 'resolved'),
    });
    const compiled = compileCliEvaluationInput(resolved);
    const target = compiled.definition.targets.find((candidate) => (
      candidate.targetId === 'control'
    ));
    const binding = compiled.runtimeBinding.bindings.find((candidate) => (
      candidate.runtimeKind === 'executor' && candidate.targetId === 'control'
    ));
    if (binding?.runtimeKind !== 'executor') throw new Error('missing control binding');

    expect(target?.executionControls.defaults).toEqual({
      workspace: { workspaceMode: 'not-required' },
      tools: { toolPolicyKind: 'runtime-default' },
    });
    expect(target?.executionControls.sampleOverrides).toEqual([
      expect.objectContaining({
        sampleId: 'sample-a',
        tools: { toolPolicyKind: 'allow-list', allowedTools: ['Read'] },
      }),
      expect.objectContaining({
        sampleId: 'sample-b',
        tools: { toolPolicyKind: 'allow-list', allowedTools: ['Bash'] },
      }),
    ]);
    const workspaceIds = target?.executionControls.sampleOverrides.map((override) => (
      override.workspace?.workspaceMode === 'copy-on-write-overlay'
        ? override.workspace.descriptor.resourceId
        : undefined
    ));
    expect(new Set(workspaceIds).size).toBe(2);
    expect(binding.resourceLeaseRequirements.filter((requirement) => (
      requirement.resourceRole === 'workspace'
    )).map((requirement) => requirement.resourceId).sort()).toEqual(
      [...workspaceIds as string[]].sort(),
    );
    expect(JSON.stringify(compiled.definition)).not.toContain(root);
    expect(JSON.stringify(target?.executionControls)).not.toContain('locator');
    expect(JSON.stringify(target?.executionControls)).not.toContain('Read,Bash');
  });

  it('keeps Gold analysis-only and outside every executor resource lease', async () => {
    const root = await fixture('gold-isolation');
    await writeFile(join(root, 'gold.json'), JSON.stringify({ sampleId: 'sample-a', score: 5 }));
    const resolved = await resolveNodeCliEvaluationRequest(request(root, {
      'gold-dir': 'gold.json',
    }), {
      projectRoot: root,
      materializationRoot: join(root, '.omk', 'resolved'),
    });
    const compiled = compileCliEvaluationInput(resolved);
    const gold = compiled.hostResources.resources.find((resource) => (
      resource.resourceKind === 'gold-dataset'
    ));

    expect(gold?.descriptor.classification).toBe('gold');
    const goldId = gold!.descriptor.resourceId;
    expect(compiled.orchestration.gold?.resourceId).toBe(goldId);
    const executorBindings = compiled.runtimeBinding.bindings.filter((binding) => (
      binding.runtimeKind === 'executor'
    ));
    expect(JSON.stringify(executorBindings)).not.toContain(goldId);
    expect(JSON.stringify(compiled.definition.targets)).not.toContain(goldId);
  });

  it('groups record-scoped evaluators across multiple samples without missing bindings', async () => {
    const root = await fixture('multi-sample');
    await writeFile(join(root, 'samples.json'), sampleSetJson([
      {
        sample_id: 'sample-a', prompt: 'A', rubric: {
          quality: { criterion: 'Correct.', weight: 1 },
        },
        assertions: [
          { type: 'json_valid' },
          { type: 'tools_count_max', value: 1 },
          { type: 'semantic_similarity', reference: 'A' },
        ],
      },
      {
        sample_id: 'sample-b', prompt: 'B', rubric: {
          quality: { criterion: 'Correct.', weight: 1 },
        },
        assertions: [
          { type: 'contains', value: 'Bee' },
          { type: 'tools_count_max', value: 2 },
          { type: 'semantic_similarity', reference: 'B' },
        ],
      },
    ]));

    const compiled = compileCliEvaluationInput(await resolveNodeCliEvaluationRequest(
      request(root),
      { projectRoot: root, materializationRoot: join(root, '.omk', 'resolved') },
    ));

    expect(compiled.definition.dataset.samples).toHaveLength(2);
    const llmEvaluators = compiled.definition.evaluators.filter((evaluator) => (
      evaluator.implementationId === 'omk.llm-assertions/v2'
    ));
    expect(llmEvaluators).toHaveLength(2);
    expect(llmEvaluators.map((evaluator) => evaluator.applicableSampleIds)).toEqual([
      ['sample-a'], ['sample-b'],
    ]);
  });

  it('seals partial LLM and rubric applicability instead of scoring unintended samples', async () => {
    const root = await fixture('partial-applicability');
    await writeFile(join(root, 'samples.json'), sampleSetJson([
      {
        sample_id: 'sample-a', prompt: 'A', rubric: {
          accuracy: { criterion: 'Correct.', weight: 0.7 },
          safety: { criterion: 'Safe.', weight: 0.3 },
        },
        assertions: [{ type: 'semantic_similarity', reference: 'A' }],
      },
      { sample_id: 'sample-b', prompt: 'B', rubric: {
        style: { criterion: 'Concise.', weight: 1 },
      } },
    ]));

    const compiled = compileCliEvaluationInput(await resolveNodeCliEvaluationRequest(request(root), {
      projectRoot: root,
      materializationRoot: join(root, '.omk', 'resolved'),
    }));
    const applicability = compiled.definition.evaluators
      .filter((evaluator) => evaluator.applicableSampleIds !== undefined)
      .map((evaluator) => evaluator.applicableSampleIds);

    expect(applicability).toHaveLength(4);
    expect(applicability).toEqual(expect.arrayContaining([
      ['sample-a'], ['sample-a'], ['sample-a'], ['sample-b'],
    ]));
    const rubricEvaluators = compiled.definition.evaluators.filter((evaluator) => (
      evaluator.implementationId === 'omk.rubric-judge/v1'
    ));
    expect(rubricEvaluators).toHaveLength(3);
    expect(compiled.definition.decisionPolicy?.parameters).toMatchObject({
      sources: {
        judgeEnsembles: expect.arrayContaining([
          expect.objectContaining({ applicableSampleIds: ['sample-a'] }),
          expect.objectContaining({ applicableSampleIds: ['sample-a'] }),
          expect.objectContaining({ applicableSampleIds: ['sample-b'] }),
        ]),
      },
    });
  });

  it('gates release on every applicable rubric dimension without a reserved name', async () => {
    const root = await fixture('overall-agreement');
    const compiled = compileCliEvaluationInput(await resolveNodeCliEvaluationRequest(
      request(root),
      { projectRoot: root, materializationRoot: join(root, '.omk', 'resolved') },
    ));

    expect(compiled.definition.decisionPolicy?.parameters).toMatchObject({
      sources: {
        judgeEnsembles: [expect.objectContaining({
          replicateGroupId: expect.stringContaining('rubric-'),
        })],
      },
    });
    expect(compiled.definition.decisionPolicy?.implementationId).toBe(
      RELEASE_DECISION_POLICY_V7_IMPLEMENTATION_ID,
    );
    const rubricEvaluators = compiled.definition.evaluators.filter((evaluator) => (
      evaluator.measurement.replicateGroupId.startsWith('rubric-')
    ));
    expect(rubricEvaluators).toHaveLength(1);
    expect(rubricEvaluators[0]?.measurement.replicateIndex).toBe(0);
  });

  it('seals a priori power assumptions and the derived comparison-unit requirement', async () => {
    const root = await fixture('power-plan');
    const base = request(root);
    const powered = {
      ...base,
      values: {
        ...base.values,
        measurement: {
          ...base.values.measurement,
          decision: {
            ...base.values.measurement.decision,
            sampleSize: {
              sampleSizePlanningKind: 'a-priori-power' as const,
              minimumDetectableDifference: 0.5,
              expectedDifferenceStandardDeviation: 1,
              targetPower: 0.8,
              assumptionSource: 'pilot-2026-q3',
            },
          },
        },
      },
    };

    const compiled = compileCliEvaluationInput(await resolveNodeCliEvaluationRequest(
      powered,
      { projectRoot: root, materializationRoot: join(root, '.omk', 'resolved') },
    ));

    expect(compiled.definition.decisionPolicy?.parameters).toMatchObject({
      sampleSizeRequirement: {
        sampleSizePlanningKind: 'a-priori-power',
        methodId: 'omk.paired-mean-difference-normal-approximation/v1',
        minimumDetectableDifference: 0.5,
        expectedDifferenceStandardDeviation: 1,
        targetPower: 0.8,
        familywiseAlpha: 0.05,
        plannedComparisonCount: 1,
        minimumComparisonUnits: 32,
        assumptionSource: 'pilot-2026-q3',
      },
    });
  });

  it('keeps production sample validation strict despite the legacy ambient escape hatch', async () => {
    const root = await fixture('strict-loader');
    await writeFile(join(root, 'samples.json'), sampleSetJson([{
      sample_id: 'sample-a', prompt: 'A', rubric: {
        quality: { criterion: 'Correct.', weight: 1 },
      },
      assertions: [{ type: 'contains', value: 'X' }],
    }]));
    vi.stubEnv('OMK_LENIENT_ASSERTIONS', '1');

    await expect(resolveNodeCliEvaluationRequest(request(root), {
      projectRoot: root,
      materializationRoot: join(root, '.omk', 'resolved'),
    })).rejects.toMatchObject({ code: 'CLI_INPUT_RESOLUTION_FAILED' });
  });

  it('preserves normalized sample dependency requirements for host preflight', async () => {
    const root = await fixture('dependencies');
    await writeFile(join(root, 'samples.json'), sampleSetJson(
      [{ sample_id: 'sample-a', prompt: 'A', rubric: {
        quality: { criterion: 'Correct.', weight: 1 },
      } }],
      {
        tools: ['git', 'node'],
        files: ['./fixtures/input.json'],
        env: ['TOKEN'],
        preflight: ['node --version'],
      },
    ));

    const compiled = compileCliEvaluationInput(await resolveNodeCliEvaluationRequest(
      request(root),
      { projectRoot: root, materializationRoot: join(root, '.omk', 'resolved') },
    ));

    expect(compiled.orchestration.dependencyRequirements).toEqual({
      baseDirectoryLocator: root,
      env: ['TOKEN'],
      files: ['./fixtures/input.json'],
      preflight: ['node --version'],
      tools: ['git', 'node'],
    });
  });
});
