import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  compileCliEvaluationInput,
  parseCliEvaluationRequest,
} from '../../../src/eval-workflows/input-compilation/index.js';
import { resolveNodeCliEvaluationRequest } from '../../../src/eval-workflows/production-host/index.js';

const roots: string[] = [];

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
  await writeFile(join(root, 'fixtures', 'secret.json'), JSON.stringify({ token: 'secret-value' }));
  await writeFile(join(root, 'samples.json'), JSON.stringify([{
    sample_id: 'sample-a',
    prompt: 'Return a concise JSON answer.',
    rubric: 'The response is correct and concise.',
    assertions: [
      { type: 'json_valid', weight: 2 },
      { type: 'tools_count_max', value: 1 },
      { type: 'semantic_similarity', reference: '{"ok":true}', threshold: 3 },
    ],
    mocks: [{
      tool: 'Bash',
      match: { command_glob: '*' },
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
      'output-dir': '.omk/reports',
      ...additionalFlags,
    },
    defaults: {
      samplesLocator: 'samples.json',
      skillDirectoryLocator: 'skills',
      targetRuntime: { executorId: 'claude', model: 'claude-test', effort: 'low' },
      judgeMembers: [{ executorId: 'anthropic-api', model: 'judge-test' }],
      presentation: {
        projectOutputDirectoryLocator: join(root, '.omk', 'reports'),
        globalOutputDirectoryLocator: join(root, '.omk-global', 'reports'),
        language: 'zh',
        languageDefaultSource: 'environment-selection',
      },
    },
  });
}

describe('resolveNodeCliEvaluationRequest', () => {
  it('resolves real files into a compilable five-layer design without leaking secret payloads', async () => {
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
        'omk.dimension-table/v1',
        'omk.composite-table/v1',
        'omk.bootstrap-family-table/v1',
      ]),
    );
    expect(compiled.definition.experiment.sampling.seedCoupling).toBe('uncontrolled');
    expect(JSON.stringify(compiled.definition)).not.toContain('secret-value');
    expect(compiled.hostResources.resources.some((resource) => (
      resource.resourceKind === 'mock-payload'
      && resource.descriptor.classification === 'secret'
    ))).toBe(true);
    expect(Object.isFrozen(resolved)).toBe(true);
  });

  it('materializes inline mock payloads in a private resolver-owned store', async () => {
    const root = await fixture('private-materialization');
    await writeFile(join(root, 'samples.json'), JSON.stringify([{
      sample_id: 'sample-a',
      prompt: 'A',
      rubric: 'Correct.',
      mocks: [{ tool: 'Read', return: { token: 'inline-secret' } }],
    }]));
    const resolved = await resolveNodeCliEvaluationRequest(request(root), {
      projectRoot: root,
      materializationRoot: join(root, '.omk', 'resolved'),
    });
    const payload = resolved.hostResources.resources.find(
      (resource) => resource.resourceKind === 'mock-payload',
    );

    expect(payload).toBeDefined();
    expect((await stat(payload!.locator)).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, '.omk', 'resolved', 'content'))).mode & 0o777).toBe(0o700);
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
    expect(new Set(artifacts.map((resource) => resource.locator)).size).toBe(2);
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
          projectOutputDirectoryLocator: join(root, '.omk', 'reports'),
          globalOutputDirectoryLocator: join(root, '.omk-global', 'reports'),
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

  it('seals heterogeneous sample workspaces and tool policies without flattening them', async () => {
    const root = await fixture('controls');
    await mkdir(join(root, 'workspace-a'));
    await mkdir(join(root, 'workspace-b'));
    await writeFile(join(root, 'workspace-a', 'identity.txt'), 'workspace-a');
    await writeFile(join(root, 'workspace-b', 'identity.txt'), 'workspace-b');
    await writeFile(join(root, 'samples.json'), JSON.stringify([{
      sample_id: 'sample-a', prompt: 'A', rubric: 'Correct.',
      cwd: 'workspace-a', allowedTools: ['Read'],
    }, {
      sample_id: 'sample-b', prompt: 'B', rubric: 'Correct.',
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
    await writeFile(join(root, 'samples.json'), JSON.stringify([
      {
        sample_id: 'sample-a', prompt: 'A', rubric: 'Correct.',
        assertions: [
          { type: 'json_valid' },
          { type: 'tools_count_max', value: 1 },
          { type: 'semantic_similarity', reference: 'A' },
        ],
      },
      {
        sample_id: 'sample-b', prompt: 'B', rubric: 'Correct.',
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
    await writeFile(join(root, 'samples.json'), JSON.stringify([
      {
        sample_id: 'sample-a', prompt: 'A', dimensions: { accuracy: 'Correct.' },
        assertions: [{ type: 'semantic_similarity', reference: 'A' }],
      },
      { sample_id: 'sample-b', prompt: 'B', dimensions: { style: 'Concise.' } },
    ]));

    const compiled = compileCliEvaluationInput(await resolveNodeCliEvaluationRequest(request(root), {
      projectRoot: root,
      materializationRoot: join(root, '.omk', 'resolved'),
    }));
    const applicability = compiled.definition.evaluators
      .filter((evaluator) => evaluator.applicableSampleIds !== undefined)
      .map((evaluator) => evaluator.applicableSampleIds);

    expect(applicability).toHaveLength(3);
    expect(applicability).toEqual(expect.arrayContaining([
      ['sample-a'], ['sample-a'], ['sample-b'],
    ]));
    expect(compiled.definition.decisionPolicy?.parameters).not.toMatchObject({
      sources: { judgeEnsemble: expect.anything() },
    });
  });

  it('uses only an explicit overall rubric for the release judge-agreement gate', async () => {
    const root = await fixture('overall-agreement');
    const compiled = compileCliEvaluationInput(await resolveNodeCliEvaluationRequest(
      request(root),
      { projectRoot: root, materializationRoot: join(root, '.omk', 'resolved') },
    ));

    expect(compiled.definition.decisionPolicy?.parameters).toMatchObject({
      sources: { judgeEnsemble: { replicateGroupId: expect.stringContaining('rubric-') } },
    });
  });

  it('keeps production sample validation strict despite the legacy ambient escape hatch', async () => {
    const root = await fixture('strict-loader');
    await writeFile(join(root, 'samples.json'), JSON.stringify([{
      sample_id: 'sample-a', prompt: 'A', rubric: 'Correct.',
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
    await writeFile(join(root, 'samples.json'), JSON.stringify({
      requires: {
        tools: ['git', 'node'],
        files: ['./fixtures/input.json'],
        env: ['TOKEN'],
        preflight: ['node --version'],
      },
      samples: [{ sample_id: 'sample-a', prompt: 'A', rubric: 'Correct.' }],
    }));

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
