import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { TraceSourceKindSchema } from '../../../src/executors/contracts/trace-source-schema.js';
import { AgentDescriptorSchema, type AgentDescriptor } from '../../../src/observability/agents/contracts.js';
import { assertSafeHomeRelativePath } from '../../../src/observability/agents/fs-ports.js';
import { KNOWN_AGENTS, findAgentDescriptor } from '../../../src/observability/agents/registry.js';

function agentIds(): string[] {
  return KNOWN_AGENTS.map((descriptor) => descriptor.agentId);
}

describe('agent registry', () => {
  it('每条登记项都独立通过契约 schema，且 agentId 唯一', () => {
    assert.ok(KNOWN_AGENTS.length > 0, '登记表不得为空');
    for (const descriptor of KNOWN_AGENTS) {
      const parsed = AgentDescriptorSchema.safeParse(descriptor);
      assert.ok(parsed.success, `${descriptor.agentId} 不符合 AgentDescriptorSchema`);
    }
    const ids = agentIds();
    assert.deepEqual(ids, [...new Set(ids)], 'agentId 不得重复');
  });

  it('每个日志根的 traceSourceKind 都是合法 TraceSourceKind，rootId 在 agent 内唯一', () => {
    const legal = new Set<string>(TraceSourceKindSchema.options);
    for (const descriptor of KNOWN_AGENTS) {
      const rootIds = descriptor.logRoots.map((root) => root.rootId);
      assert.deepEqual(rootIds, [...new Set(rootIds)], `${descriptor.agentId} 的 rootId 重复`);
      for (const root of descriptor.logRoots) {
        assert.ok(legal.has(root.traceSourceKind), `${descriptor.agentId}/${root.rootId} 的格式不在 TraceSourceKind 里`);
        assert.ok(root.matchExtensions.length > 0, `${root.rootId} 必须声明扩展名`);
      }
    }
  });

  it('所有登记路径都是主目录相对路径，不存在越界形态', () => {
    for (const descriptor of KNOWN_AGENTS) {
      assert.ok(descriptor.installDirs.length > 0, `${descriptor.agentId} 必须有安装目录`);
      for (const path of [...descriptor.installDirs, ...descriptor.logRoots.map((root) => root.relativePath)]) {
        assert.doesNotThrow(() => assertSafeHomeRelativePath(path), `${descriptor.agentId} 的 ${path} 不安全`);
      }
    }
  });

  it('有日志根时主日志格式必须与某个根的格式一致，没有日志根时按安装事实登记', () => {
    for (const descriptor of KNOWN_AGENTS) {
      if (descriptor.logRoots.length === 0) continue;
      assert.ok(
        descriptor.traceSourceKind !== null
        && descriptor.logRoots.some((root) => root.traceSourceKind === descriptor.traceSourceKind),
        `${descriptor.agentId} 的 traceSourceKind 与其日志根格式不对应`,
      );
    }
  });

  it('登记项锚定本机已核实的会话日志位置', () => {
    const rootPaths = (agentId: string): string[] => {
      const descriptor = findAgentDescriptor(agentId) as AgentDescriptor;
      return descriptor.logRoots.map((root) => root.relativePath);
    };
    assert.deepEqual(rootPaths('codex'), ['.codex/sessions', '.codex/archived_sessions']);
    assert.deepEqual(rootPaths('claude-code'), ['.claude/projects']);
    assert.deepEqual(rootPaths('codefuse'), ['.codefuse/projects']);
    assert.deepEqual(rootPaths('qoder'), ['.qoder/projects']);
    assert.deepEqual(rootPaths('qoder-cn'), ['.qoder-cn/projects']);
    // CodeFuse 落 Claude 同族日志：产品身份与格式归属必须分开。
    assert.equal(findAgentDescriptor('codefuse')?.traceSourceKind, 'claude');
    assert.equal(findAgentDescriptor('claude-code')?.traceSourceKind, 'claude');
  });

  it('findAgentDescriptor 未登记的身份返回 undefined，不猜格式', () => {
    assert.equal(findAgentDescriptor('definitely-not-an-agent'), undefined);
    assert.equal(findAgentDescriptor('codex')?.displayName, 'Codex CLI');
  });
});
