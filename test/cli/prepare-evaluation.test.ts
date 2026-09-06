import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareCliEvaluation } from '../../src/cli/lib/prepare-evaluation.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'omk-prepare-evaluation-'));
  roots.push(root);
  const skill = join(root, 'skills', 'answer');
  mkdirSync(join(skill, '.omk'), { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), '# Answer');
  writeFileSync(join(skill, '.omk', 'eval-samples.json'), '{}');
  return {
    root, skill,
    options: { projectRoot: root, env: { PATH: '', OMK_EXECUTOR: 'claude', OMK_MODEL: 'sonnet', OMK_HOME: join(root, 'home') } },
    flags: { control: 'baseline', treatment: 'answer' },
  };
}

describe('prepareCliEvaluation', () => {
  it('discovers canonical private samples relative to the explicit project root', () => {
    const input = fixture();
    const prepared = prepareCliEvaluation(input.flags, input.options);
    expect(prepared.request.values.locators.samples).toBe(join(input.skill, '.omk', 'eval-samples.json'));
    expect(prepared.request.values.presentation.outputDirectoryLocator).toBe(join(input.root, '.omk', 'eval'));
  });

  it('loads YAML once and leaves flags above YAML above captured environment in the request', () => {
    const input = fixture();
    writeFileSync(join(input.root, 'eval.yaml'), `samples: ./yaml-samples.json
executor: claude
model: yaml-model
effort: medium
judgeModels:
  - executor: openai-api
    model: yaml-judge
variants:
  - name: base
    role: control
    artifact: baseline
  - name: answer
    role: treatment
    artifact: ./skills/answer
`);
    const prepared = prepareCliEvaluation({ config: 'eval.yaml', model: 'cli-model', samples: './explicit.json' }, {
      ...input.options, env: { ...input.options.env, OMK_JUDGE_MODELS: 'invalid-unused-preference' },
    });
    expect(prepared.request.values.locators.samples).toBe('./explicit.json');
    expect(prepared.request.values.targetRuntime).toMatchObject({ executorId: 'claude', model: 'cli-model', effort: 'medium' });
    expect(prepared.request.values.judges.members).toEqual([{ executorId: 'openai-api', model: 'yaml-judge' }]);
    expect(prepared.parseInput.evalConfig?.samples).toBe(join(input.root, 'yaml-samples.json'));
    const yaml = prepareCliEvaluation({ config: 'eval.yaml' }, input.options);
    expect(yaml.request.values.locators.samples).toBe(join(input.root, 'yaml-samples.json'));
  });

  it('freezes the captured environment and lets no-judge bypass invalid unused preferences', () => {
    const input = fixture();
    const env = { ...input.options.env, OMK_JUDGE_MODELS: 'invalid-unused-preference' };
    const prepared = prepareCliEvaluation({ ...input.flags, 'no-judge': true }, { ...input.options, env });
    env.OMK_MODEL = 'later-model';
    expect(prepared.environment.environment.OMK_MODEL).toBe('sonnet');
    expect(prepared.request.values.judges).toMatchObject({ enabled: false, members: [] });
  });
});
