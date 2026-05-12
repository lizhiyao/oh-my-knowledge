import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildObservationSkillChain } from '../../src/observability/skill-chain.js';
import type { ObservationExperienceReport } from '../../src/observability/experience.js';

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
