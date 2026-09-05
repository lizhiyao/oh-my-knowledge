import { describe, expect, it } from 'vitest';
import {
  TargetExecutionControlsSchema,
  normalizeTargetExecutionControls,
  resolveEffectiveExecutionControl,
} from '../../../src/eval-core/contracts/index.js';

const workspaceA = {
  workspaceMode: 'copy-on-write-overlay' as const,
  descriptor: {
    resourceId: 'workspace-a',
    digest: `sha256:${'a'.repeat(64)}` as const,
    mediaType: 'application/vnd.omk.workspace-tree',
    classification: 'sensitive' as const,
    size: 42,
  },
};

const mcpA = {
  mcpMode: 'native-config' as const,
  descriptor: {
    resourceId: 'mcp-a',
    digest: `sha256:${'b'.repeat(64)}` as const,
    mediaType: 'application/json',
    classification: 'secret' as const,
    size: 64,
  },
};

const mockPlanA = {
  mockInterceptionMode: 'pre-tool-call' as const,
  descriptor: {
    resourceId: 'mock-plan-a',
    digest: `sha256:${'c'.repeat(64)}` as const,
    mediaType: 'application/vnd.omk.mock-interception-plan+json',
    classification: 'secret' as const,
    size: 96,
  },
};

describe('sample-scoped execution controls', () => {
  it('normalizes unordered allow-lists and overrides into one canonical form', () => {
    expect(normalizeTargetExecutionControls({
      defaults: {
        workspace: { workspaceMode: 'not-required' },
        tools: { toolPolicyKind: 'allow-list', allowedTools: ['write', 'read'] },
        mcp: { mcpMode: 'not-required' },
        mockInterception: { mockInterceptionMode: 'not-required' },
      },
      sampleOverrides: [
        {
          sampleId: 'sample-b',
          tools: { toolPolicyKind: 'allow-list', allowedTools: ['shell', 'read'] },
        },
        { sampleId: 'sample-a', workspace: workspaceA },
      ],
    })).toEqual({
      defaults: {
        workspace: { workspaceMode: 'not-required' },
        tools: { toolPolicyKind: 'allow-list', allowedTools: ['read', 'write'] },
        mcp: { mcpMode: 'not-required' },
        mockInterception: { mockInterceptionMode: 'not-required' },
      },
      sampleOverrides: [
        { sampleId: 'sample-a', workspace: workspaceA },
        {
          sampleId: 'sample-b',
          tools: { toolPolicyKind: 'allow-list', allowedTools: ['read', 'shell'] },
        },
      ],
    });
  });

  it('uses field replacement, never an implicit tool union', () => {
    const controls = {
      defaults: {
        workspace: { workspaceMode: 'not-required' as const },
        tools: { toolPolicyKind: 'allow-list' as const, allowedTools: ['read', 'write'] },
        mcp: { mcpMode: 'not-required' as const },
        mockInterception: { mockInterceptionMode: 'not-required' as const },
      },
      sampleOverrides: [{
        sampleId: 'sample-a',
        workspace: workspaceA,
        tools: { toolPolicyKind: 'allow-list' as const, allowedTools: ['shell'] },
      }],
    };

    expect(resolveEffectiveExecutionControl(controls, 'sample-a')).toEqual({
      workspace: workspaceA,
      tools: { toolPolicyKind: 'allow-list', allowedTools: ['shell'] },
      mcp: { mcpMode: 'not-required' },
      mockInterception: { mockInterceptionMode: 'not-required' },
    });
    expect(resolveEffectiveExecutionControl(controls, 'sample-b')).toEqual(controls.defaults);
  });

  it('accepts an explicit empty allow-list as deny-all', () => {
    expect(TargetExecutionControlsSchema.safeParse({
      defaults: {
        workspace: { workspaceMode: 'not-required' },
        tools: { toolPolicyKind: 'allow-list', allowedTools: [] },
        mcp: { mcpMode: 'not-required' },
        mockInterception: { mockInterceptionMode: 'not-required' },
      },
      sampleOverrides: [],
    }).success).toBe(true);
  });

  it('resolves MCP config by sample without leaking one sample into another', () => {
    const controls = {
      defaults: {
        workspace: { workspaceMode: 'not-required' as const },
        tools: { toolPolicyKind: 'runtime-default' as const },
        mcp: mcpA,
        mockInterception: { mockInterceptionMode: 'not-required' as const },
      },
      sampleOverrides: [{
        sampleId: 'sample-a',
        mcp: { mcpMode: 'not-required' as const },
      }],
    };

    expect(resolveEffectiveExecutionControl(controls, 'sample-a').mcp)
      .toEqual({ mcpMode: 'not-required' });
    expect(resolveEffectiveExecutionControl(controls, 'sample-b').mcp).toEqual(mcpA);
  });

  it('replaces a mock plan as one sample-scoped field without merging descriptors', () => {
    const controls = {
      defaults: {
        workspace: { workspaceMode: 'not-required' as const },
        tools: { toolPolicyKind: 'runtime-default' as const },
        mcp: { mcpMode: 'not-required' as const },
        mockInterception: mockPlanA,
      },
      sampleOverrides: [{
        sampleId: 'sample-a',
        mockInterception: { mockInterceptionMode: 'not-required' as const },
      }],
    };

    expect(resolveEffectiveExecutionControl(controls, 'sample-a').mockInterception)
      .toEqual({ mockInterceptionMode: 'not-required' });
    expect(resolveEffectiveExecutionControl(controls, 'sample-b').mockInterception)
      .toEqual(mockPlanA);
  });

  it('rejects empty overrides, locators, and Gold workspace descriptors', () => {
    const base = {
      defaults: {
        workspace: { workspaceMode: 'not-required' },
        tools: { toolPolicyKind: 'runtime-default' },
        mcp: { mcpMode: 'not-required' },
        mockInterception: { mockInterceptionMode: 'not-required' },
      },
      sampleOverrides: [],
    };
    expect(TargetExecutionControlsSchema.safeParse({
      ...base,
      sampleOverrides: [{ sampleId: 'sample-a' }],
    }).success).toBe(false);
    expect(TargetExecutionControlsSchema.safeParse({
      defaults: {
        ...base.defaults,
        workspace: {
          ...workspaceA,
          descriptor: { ...workspaceA.descriptor, locator: '/private/workspace-a' },
        },
      },
      sampleOverrides: [],
    }).success).toBe(false);
    expect(TargetExecutionControlsSchema.safeParse({
      defaults: {
        ...base.defaults,
        workspace: {
          ...workspaceA,
          descriptor: { ...workspaceA.descriptor, classification: 'gold' },
        },
      },
      sampleOverrides: [],
    }).success).toBe(false);
  });
});
