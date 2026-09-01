import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __resetSkillIndexCacheForTests, buildObservationSkillChain, findSkillMdPath } from '../../../src/observability/skill-health/skill-chain.js';
import type { ObservationExperienceReport } from '../../../src/observability/experience.js';

describe('observation skill chain runtime checks', () => {
  it('checks observable hardRules and workflow nodes without LLM', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-chain-'));
    try {
      const skillDir = join(dir, 'skills', 'audit');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), `---
hardRules:
  - id: read-domain
    rule: 必须读取领域知识文件
    expectedBehavior: 使用 Read 读取 domain 文件
  - id: no-ask-tool
    rule: 不要使用 AskUserQuestion 工具
    expectedBehavior: 不能调用 AskUserQuestion
workflows:
  - id: main
    nodes:
      - id: sync
        action: git pull 同步知识库
      - id: upload
        action: 上传产物
---

# audit
`);

      const report = {
        invocations: [{
          skillName: 'audit',
          toolCounts: { Read: 1, Bash: 1 },
          indicators: { toolCallCount: 2, toolFailureCount: 0 },
          timeline: [
            { id: 'e1', kind: 'tool_use', sourceTrace: '/tmp/s.jsonl', sessionId: 's1', order: 1, toolName: 'Read', label: 'tool_use Read', snippet: '{"file_path":"domain/业务概述.md"}' },
            { id: 'e2', kind: 'tool_use', sourceTrace: '/tmp/s.jsonl', sessionId: 's1', order: 2, toolName: 'Bash', label: 'tool_use Bash', snippet: '{"command":"git pull"}' },
          ],
        }],
      } as unknown as ObservationExperienceReport;

      const chain = buildObservationSkillChain('audit', dir, [report]);
      assert.equal(chain.runtime.supported, true);
      assert.equal(chain.runtime.mode, 'deterministic-no-llm');
      assert.equal(chain.runtime.summary.passedCount, 3);
      assert.equal(chain.runtime.summary.attentionCount, 1);
      assert.equal(chain.runtime.hardRules.find((rule) => rule.id === 'read-domain')?.status, 'passed');
      assert.equal(chain.runtime.hardRules.find((rule) => rule.id === 'no-ask-tool')?.status, 'passed');
      assert.equal(chain.runtime.workflowNodes.find((node) => node.id === 'main.sync')?.status, 'passed');
      assert.equal(chain.runtime.workflowNodes.find((node) => node.id === 'main.upload')?.status, 'attention');
      assert.equal(chain.runtime.evidencePack?.schemaVersion, 1);
      assert.equal(chain.runtime.evidencePack?.nodeEvidence.find((node) => node.nodeId === 'main.sync')?.deterministicStatus, 'passed');
      assert.ok((chain.runtime.evidencePack?.runtimeEvidence.toolCalls.length ?? 0) > 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('annotates advisoryCode when hardRules / workflows are not declared', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-chain-advisory-'));
    try {
      const skillDir = join(dir, 'skills', 'noop');
      mkdirSync(skillDir, { recursive: true });
      // 纯描述型 frontmatter，不含 hardRules / workflows
      writeFileSync(join(skillDir, 'SKILL.md'), `---
name: noop
description: a skill without structured hardRules or workflows
---

# noop
`);

      const chain = buildObservationSkillChain('noop', dir, []);
      assert.equal(chain.healthCheck.hardRules.declared, false);
      assert.equal(chain.healthCheck.hardRules.advisoryCode, 'hardrules_not_declared');
      assert.equal(chain.healthCheck.workflows.declared, false);
      assert.equal(chain.healthCheck.workflows.advisoryCode, 'workflows_not_declared');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects markdown Step headings as workflow candidates for observation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-chain-md-steps-'));
    try {
      const skillDir = join(dir, 'skills', 'prd-create');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), `---
name: prd-create
description: create PRD
---

# PRD Creation Skill

## 工作流程

### Step 1: 读取领域知识（生成前必须完成）

必须读取领域知识。

### Step 2: 需求收集

必须补充关键信息。

### Step 3: 上传

上传到系统。
`);

      const chain = buildObservationSkillChain('prd-create', dir, []);
      assert.equal(chain.healthCheck.workflows.declared, false);
      assert.equal(chain.healthCheck.workflows.source, 'markdown_headings');
      assert.equal(chain.healthCheck.workflows.advisoryCode, 'workflows_not_declared');
      assert.equal(chain.healthCheck.workflows.branchCount, 1);
      assert.equal(chain.healthCheck.workflows.nodeCount, 3);
      assert.deepEqual(chain.healthCheck.workflows.workflows[0].nodes.map((node) => node.id), ['step1', 'step2', 'step3']);
      assert.equal(chain.healthCheck.workflows.workflows[0].nodes[0].action, '读取领域知识（生成前必须完成）');
      assert.equal(chain.runtime.workflowNodes.length, 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('matches workflow runtime checks by step semantics', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-chain-runtime-semantics-'));
    try {
      const skillDir = join(dir, 'skills', 'demo-create');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), `---
name: demo-create
description: create demo
---

# Demo Creation Skill

## 工作流程

### Step 1: 读取领域需求（生成前必须完成）

### Step 2: 生成可交互 Demo

### Step 3: 截图验证页面

### Step 4: 上传产物
`);

      const report = {
        invocations: [{
          skillName: 'demo-create',
          toolCounts: { Read: 2, Write: 1, Bash: 2 },
          indicators: { toolCallCount: 5, toolFailureCount: 0 },
          timeline: [
            { id: 'e1', kind: 'tool_use', sourceTrace: '/tmp/s.jsonl', sessionId: 's1', order: 1, toolName: 'Read', label: 'tool_use Read', snippet: '{"file_path":"/tmp/skills/demo-create/SKILL.md"}' },
            { id: 'e2', kind: 'tool_use', sourceTrace: '/tmp/s.jsonl', sessionId: 's1', order: 2, toolName: 'Read', label: 'tool_use Read', snippet: '{"file_path":"requirements/page.md"}' },
            { id: 'e3', kind: 'tool_use', sourceTrace: '/tmp/s.jsonl', sessionId: 's1', order: 3, toolName: 'Write', label: 'tool_use Write', snippet: '{"file_path":"dist/demo.html"}' },
            { id: 'e4', kind: 'tool_use', sourceTrace: '/tmp/s.jsonl', sessionId: 's1', order: 4, toolName: 'Bash', label: 'tool_use Bash', snippet: '{"command":"npm run build"}' },
            { id: 'e5', kind: 'tool_use', sourceTrace: '/tmp/s.jsonl', sessionId: 's1', order: 5, toolName: 'Bash', label: 'tool_use Bash', snippet: '{"command":"npx playwright test --project chromium"}' },
            { id: 'e6', kind: 'tool_use', sourceTrace: '/tmp/s.jsonl', sessionId: 's1', order: 6, role: 'assistant', toolUseId: 'upload-1', toolName: 'Bash', label: 'tool_use Bash', snippet: '{"command":"curl -X POST https://example.test/artifacts/upload"}' },
            { id: 'e7', kind: 'tool_result', sourceTrace: '/tmp/s.jsonl', sessionId: 's1', order: 7, role: 'tool', toolUseId: 'upload-1', label: 'tool_result upload', snippet: '{"preview_url":"https://example.test/preview/demo"}' },
          ],
        }],
      } as unknown as ObservationExperienceReport;

      const chain = buildObservationSkillChain('demo-create', dir, [report]);
      assert.deepEqual(chain.runtime.workflowNodes.map((node) => node.title), [
        '读取领域需求（生成前必须完成）',
        '生成可交互 Demo',
        '截图验证页面',
        '上传产物',
      ]);
      assert.equal(chain.runtime.workflowNodes.find((node) => node.id === 'markdown_steps.step1')?.status, 'passed');
      assert.equal(chain.runtime.workflowNodes.find((node) => node.id === 'markdown_steps.step2')?.status, 'passed');
      assert.equal(chain.runtime.workflowNodes.find((node) => node.id === 'markdown_steps.step3')?.status, 'passed');
      assert.equal(chain.runtime.workflowNodes.find((node) => node.id === 'markdown_steps.step4')?.status, 'passed');
      assert.ok(chain.runtime.workflowNodes.find((node) => node.id === 'markdown_steps.step1')?.evidenceSnippets.every((snippet) => !snippet.includes('SKILL.md')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not treat generic Bash or SKILL.md loading as workflow evidence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-chain-runtime-narrow-'));
    try {
      const skillDir = join(dir, 'skills', 'demo-create');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), `---
name: demo-create
description: create demo
---

# Demo Creation Skill

## 工作流程

### Step 1: 读取领域需求（生成前必须完成）

### Step 2: 截图验证页面
`);

      const report = {
        invocations: [{
          skillName: 'demo-create',
          toolCounts: { Read: 1, Bash: 1 },
          indicators: { toolCallCount: 2, toolFailureCount: 0 },
          timeline: [
            { id: 'e1', kind: 'tool_use', sourceTrace: '/tmp/s.jsonl', sessionId: 's1', order: 1, toolName: 'Read', label: 'tool_use Read', snippet: '{"file_path":"/tmp/skills/demo-create/SKILL.md"}' },
            { id: 'e2', kind: 'tool_use', sourceTrace: '/tmp/s.jsonl', sessionId: 's1', order: 2, toolName: 'Bash', label: 'tool_use Bash', snippet: '{"command":"npm run build"}' },
          ],
        }],
      } as unknown as ObservationExperienceReport;

      const chain = buildObservationSkillChain('demo-create', dir, [report]);
      assert.equal(chain.runtime.workflowNodes.find((node) => node.id === 'markdown_steps.step1')?.status, 'attention');
      assert.equal(chain.runtime.workflowNodes.find((node) => node.id === 'markdown_steps.step2')?.status, 'attention');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not count user-authored uploads as skill workflow completion', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-chain-upload-actor-'));
    try {
      const skillDir = join(dir, 'skills', 'demo-create');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), `---
name: demo-create
description: create demo
---

# Demo Creation Skill

## 工作流程

### Step 1: 上传产物
`);

      const userUploadReport = {
        invocations: [{
          skillName: 'demo-create',
          toolCounts: {},
          indicators: { toolCallCount: 0, toolFailureCount: 0 },
          timeline: [
            { id: 'e1', kind: 'user_message', sourceTrace: '/tmp/s.jsonl', sessionId: 's1', order: 1, role: 'user', label: 'user message', snippet: '【用户上传产物】 用户手动上传了 demo 文件，artifact_id=sample version=1。' },
            { id: 'e2', kind: 'tool_result', sourceTrace: '/tmp/s.jsonl', sessionId: 's1', order: 2, role: 'tool', label: 'tool_result upload', snippet: '{"preview_url":"https://example.test/preview/manual"}' },
          ],
        }],
      } as unknown as ObservationExperienceReport;
      const userUploadChain = buildObservationSkillChain('demo-create', dir, [userUploadReport]);
      assert.equal(userUploadChain.runtime.workflowNodes.find((node) => node.id === 'markdown_steps.step1')?.status, 'attention');

      const skillUploadReport = {
        invocations: [{
          skillName: 'demo-create',
          toolCounts: { Bash: 1 },
          indicators: { toolCallCount: 1, toolFailureCount: 0 },
          timeline: [
            { id: 'e3', kind: 'tool_use', sourceTrace: '/tmp/s.jsonl', sessionId: 's1', order: 1, role: 'assistant', toolUseId: 'upload-1', toolName: 'Bash', label: 'tool_use Bash', snippet: '{"command":"curl -X POST https://example.test/artifacts/upload"}' },
            { id: 'e4', kind: 'tool_result', sourceTrace: '/tmp/s.jsonl', sessionId: 's1', order: 2, role: 'tool', toolUseId: 'upload-1', label: 'tool_result upload', snippet: '{"preview_url":"https://example.test/preview/skill"}' },
          ],
        }],
      } as unknown as ObservationExperienceReport;
      const skillUploadChain = buildObservationSkillChain('demo-create', dir, [skillUploadReport]);
      assert.equal(skillUploadChain.runtime.workflowNodes.find((node) => node.id === 'markdown_steps.step1')?.status, 'passed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('omits advisoryCode when hardRules / workflows are declared', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-chain-declared-'));
    try {
      const skillDir = join(dir, 'skills', 'declared');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), `---
hardRules:
  - id: only-rule
    rule: 必须 X
    expectedBehavior: 不要 Y
workflows:
  - id: main
    nodes:
      - id: step1
        action: 做 X
---

# declared
`);

      const chain = buildObservationSkillChain('declared', dir, []);
      assert.equal(chain.healthCheck.hardRules.declared, true);
      assert.equal(chain.healthCheck.hardRules.advisoryCode, undefined);
      assert.equal(chain.healthCheck.workflows.declared, true);
      assert.equal(chain.healthCheck.workflows.advisoryCode, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('findSkillMdPath reverse walk', () => {
  it('matches SKILL.md under any workspace-* sibling (1 level intermediate)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-skill-walk-workspace-main-'));
    try {
      mkdirSync(join(dir, '.openclaw', 'workspace-main', 'skills', 'foo'), { recursive: true });
      writeFileSync(join(dir, '.openclaw', 'workspace-main', 'skills', 'foo', 'SKILL.md'), '# foo');
      __resetSkillIndexCacheForTests();
      const found = findSkillMdPath('foo', dir);
      assert.equal(found, join(dir, '.openclaw', 'workspace-main', 'skills', 'foo', 'SKILL.md'));
    } finally {
      __resetSkillIndexCacheForTests();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('matches SKILL.md directly under tool root (0 level intermediate)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-skill-walk-claude-'));
    try {
      mkdirSync(join(dir, '.claude', 'skills', 'bar'), { recursive: true });
      writeFileSync(join(dir, '.claude', 'skills', 'bar', 'SKILL.md'), '# bar');
      __resetSkillIndexCacheForTests();
      const found = findSkillMdPath('bar', dir);
      assert.equal(found, join(dir, '.claude', 'skills', 'bar', 'SKILL.md'));
    } finally {
      __resetSkillIndexCacheForTests();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('matches SKILL.md nested 3 levels deep under tool root (subagent style)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-skill-walk-deep-'));
    try {
      const deepPath = join(dir, '.openclaw', 'projects', 'team', 'subagent', 'skills', 'baz');
      mkdirSync(deepPath, { recursive: true });
      writeFileSync(join(deepPath, 'SKILL.md'), '# baz');
      __resetSkillIndexCacheForTests();
      const found = findSkillMdPath('baz', dir);
      assert.equal(found, join(deepPath, 'SKILL.md'));
    } finally {
      __resetSkillIndexCacheForTests();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects skill names with unsafe characters', () => {
    __resetSkillIndexCacheForTests();
    assert.equal(findSkillMdPath('../etc/passwd', process.cwd()), undefined);
    assert.equal(findSkillMdPath('a/b', process.cwd()), undefined);
  });
});
