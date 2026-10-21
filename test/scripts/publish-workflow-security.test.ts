import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { describe, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const WORKFLOW_PATH = join(PROJECT_ROOT, '.github', 'workflows', 'publish.yml');

interface WorkflowStep {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
}

interface PublishWorkflow {
  permissions: Record<string, string>;
  concurrency: { 'cancel-in-progress': boolean };
  jobs?: {
    [name: string]: {
      needs?: string | string[];
      if?: string;
      'runs-on'?: string;
      'timeout-minutes'?: number;
      outputs?: Record<string, string>;
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
  it('separates verification, npm OIDC and GitHub writes, pins actions and never persists checkout credentials', () => {
    const { source, workflow } = loadWorkflow();
    assert.deepEqual(workflow.permissions, { contents: 'read' });
    assert.equal(workflow.concurrency['cancel-in-progress'], false);
    assert.deepEqual(workflow.jobs?.verify?.permissions, { contents: 'read', actions: 'read' });
    assert.deepEqual(workflow.jobs?.publish?.permissions, { contents: 'read', 'id-token': 'write' });
    assert.deepEqual(workflow.jobs?.github_release?.permissions, { contents: 'write' });
    assert.equal(workflow.jobs?.publish?.needs, 'verify');
    assert.deepEqual(workflow.jobs?.github_release?.needs, ['verify', 'publish']);
    for (const name of ['publish', 'github_release']) {
      assert.equal(workflow.jobs?.[name]?.if, undefined, '下游必须保留 needs 成功条件，不在失败或跳过后发布');
    }
    const allowed = new Set(['actions/checkout', 'actions/setup-node', 'actions/upload-artifact', 'actions/download-artifact', 'softprops/action-gh-release']);
    for (const [name, job] of Object.entries(workflow.jobs ?? {})) {
      assert.ok((job['timeout-minutes'] ?? 0) > 0);
      for (const step of job.steps ?? []) {
        if (!step.uses) continue;
        const [repository, commit] = step.uses.split('@');
        assert.ok(allowed.has(repository));
        assert.match(commit, /^[a-f0-9]{40}$/);
        assert.ok(source.includes(`${step.uses} # v`), '固定官方 commit 时保留可维护的版本注释');
        if (repository === 'actions/checkout') {
          assert.equal(step.with?.['persist-credentials'], false);
          assert.equal(step.with?.ref, '${{ github.sha }}');
        }
        if (repository === 'softprops/action-gh-release') assert.equal(name, 'github_release');
      }
    }
    const downstream = ['publish', 'github_release'].map(name => (workflow.jobs?.[name]?.steps ?? []).map(step => step.run ?? '').join('\n'));
    for (const commands of downstream) assert.doesNotMatch(commands, /yarn.*(?:build|test|install)|npm run build/);
    assert.doesNotMatch(downstream[1], /npm install|npm publish/);
  });

  it('binds both downstream jobs to the exact immutable uploaded artifact and fails closed on a missing ID', () => {
    const { workflow } = loadWorkflow();
    const upload = workflow.jobs?.verify?.steps?.find(step => step.name === 'Save verified package and evidence');
    assert.equal(upload?.id, 'bundle');
    assert.equal(upload?.with?.['if-no-files-found'], 'error');
    assert.equal(workflow.jobs?.verify?.outputs?.artifact_id, '${{ steps.bundle.outputs.artifact-id }}');
    for (const name of ['publish', 'github_release']) {
      const steps: WorkflowStep[] = workflow.jobs?.[name]?.steps ?? [];
      const guard = steps.find(step => step.name === 'Require verified artifact ID');
      const download = steps.find(step => step.name === 'Download verified package');
      assert.ok(guard?.run);
      assert.equal(guard.env?.VERIFIED_ARTIFACT_ID, '${{ needs.verify.outputs.artifact_id }}');
      assert.ok(steps.indexOf(guard) < steps.indexOf(download!));
      assert.deepEqual(download?.with, {
        'artifact-ids': '${{ needs.verify.outputs.artifact_id }}',
        'merge-multiple': true, 'digest-mismatch': 'error', path: '${{ runner.temp }}/release-bundle',
      });
      for (const value of ['', '0', '01', 'bad', '1,2', '42']) {
        const status: number | null = spawnSync('bash', ['-e', '-c', guard.run], {
          env: { PATH: process.env.PATH, VERIFIED_ARTIFACT_ID: value }, encoding: 'utf8', timeout: 10_000,
        }).status;
        assert.equal(status === 0, value === '42');
      }
    }
    const steps = workflow.jobs?.github_release?.steps ?? [];
    const verification = steps.find(step => step.name === 'Verify release assets');
    const publication = steps.find(step => step.name === 'Create GitHub Release');
    assert.ok(verification);
    assert.ok(verification.run?.includes('scripts/release/package.mjs verify'));
    assert.equal(verification.id, 'package');
    assert.ok(steps.indexOf(verification) < steps.indexOf(publication!));
    assert.equal(publication?.with?.target_commitish, '${{ github.sha }}');
    assert.equal(publication?.with?.fail_on_unmatched_files, true);
    assert.deepEqual(String(publication?.with?.files).trim().split('\n'), [
      '${{ steps.package.outputs.tarball }}',
      '${{ runner.temp }}/release-bundle/package-manifest.json',
      '${{ runner.temp }}/release-bundle/package-smoke.json',
      '${{ runner.temp }}/release-bundle/ci-evidence.json',
    ]);
  });

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
    assert.match(publish?.run ?? '', /scripts\/release\/package\.mjs publish/);
    assert.doesNotMatch(publish?.run ?? '', /--provenance\b/, 'OIDC 发布会自动生成 provenance');
    assert.deepEqual(Object.keys(publish?.env ?? {}), ['NPM_DIST_TAG'], '发布步骤仅传递频道，不注入 npm token');
    assert.doesNotMatch(source, /NPM_TOKEN|NODE_AUTH_TOKEN/, '发布 workflow 不应引用长期 npm token');
  });

  it('prerelease 使用 next dist-tag 并创建 GitHub prerelease，正式版本使用 latest', () => {
    const { workflow } = loadWorkflow();
    const steps = workflow.jobs?.publish?.steps ?? [];
    const validate = workflow.jobs?.verify?.steps?.find((step) => step.name === 'Validate release tag');
    const publish = steps.find((step) => step.name === 'Publish to NPM');
    const githubRelease = workflow.jobs?.github_release?.steps?.find((step) => step.name === 'Create GitHub Release');

    assert.match(validate?.run ?? '', /npm_tag=next/);
    assert.match(validate?.run ?? '', /npm_tag=latest/);
    assert.match(validate?.run ?? '', /github_prerelease=true/);
    assert.match(validate?.run ?? '', /github_prerelease=false/);
    assert.equal(publish?.env?.NPM_DIST_TAG, '${{ needs.verify.outputs.npm_tag }}');
    assert.equal(
      githubRelease?.with?.prerelease,
      '${{ needs.verify.outputs.github_prerelease }}',
    );
  });
});
