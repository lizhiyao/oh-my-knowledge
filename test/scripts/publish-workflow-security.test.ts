import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { describe, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const WORKFLOW_PATH = join(PROJECT_ROOT, '.github', 'workflows', 'publish.yml');

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
}

interface PublishWorkflow {
  jobs?: {
    publish?: {
      'runs-on'?: string;
      permissions?: Record<string, unknown>;
      steps?: WorkflowStep[];
    };
  };
}

function loadWorkflow(): { source: string; workflow: PublishWorkflow } {
  const source = readFileSync(WORKFLOW_PATH, 'utf8');
  return { source, workflow: yaml.load(source) as PublishWorkflow };
}

describe('npm 发布供应链', () => {
  it('通过 GitHub OIDC Trusted Publishing 发布，不依赖长期 npm token', () => {
    const { source, workflow } = loadWorkflow();
    const job = workflow.jobs?.publish;
    const steps = job?.steps ?? [];
    const setupNode = steps.find((step) => step.uses?.startsWith('actions/setup-node@'));
    const setupPackageManagers = steps.find((step) => step.name === 'Setup package managers');
    const publish = steps.find((step) => step.name === 'Publish to NPM');

    assert.equal(job?.['runs-on'], 'ubuntu-latest', 'Trusted Publishing 只支持 GitHub-hosted runner');
    assert.equal(job?.permissions?.['id-token'], 'write', '发布 job 必须允许签发 OIDC ID token');
    assert.equal(setupNode?.with?.['node-version'], '24.x');
    assert.equal(setupNode?.with?.['package-manager-cache'], false, '发布构建不应复用包管理器缓存');
    assert.match(setupPackageManagers?.run ?? '', /npm@\^11\.5\.1/, 'Trusted Publishing 要求 npm >= 11.5.1');
    assert.match(publish?.run ?? '', /^npm publish\b/);
    assert.doesNotMatch(publish?.run ?? '', /--provenance\b/, 'OIDC 发布会自动生成 provenance');
    assert.equal(publish?.env, undefined, 'npm publish 不应注入 token 环境变量');
    assert.doesNotMatch(source, /NPM_TOKEN|NODE_AUTH_TOKEN/, '发布 workflow 不应引用长期 npm token');
  });

  it('prerelease 使用 next dist-tag，正式版本使用 latest', () => {
    const { workflow } = loadWorkflow();
    const steps = workflow.jobs?.publish?.steps ?? [];
    const validate = steps.find((step) => step.name === 'Validate release tag');
    const publish = steps.find((step) => step.name === 'Publish to NPM');

    assert.match(validate?.run ?? '', /npm_tag=next/);
    assert.match(validate?.run ?? '', /npm_tag=latest/);
    assert.match(publish?.run ?? '', /steps\.release\.outputs\.npm_tag/);
  });
});
