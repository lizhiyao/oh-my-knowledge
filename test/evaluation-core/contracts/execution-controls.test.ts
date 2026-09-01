import { describe, expect, it } from 'vitest';
import {
  TargetExecutionControlsSchema,
  normalizeTargetExecutionControls,
  resolveEffectiveExecutionControl,
} from '../../../src/evaluation-core/contracts/index.js';

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

describe('sample-scoped execution controls', () => {
  it('normalizes unordered allow-lists and overrides into one canonical form', () => {
    expect(normalizeTargetExecutionControls({
      defaults: {
        workspace: { workspaceMode: 'not-required' },
        tools: { toolPolicyKind: 'allow-list', allowedTools: ['write', 'read'] },
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
    });
    expect(resolveEffectiveExecutionControl(controls, 'sample-b')).toEqual(controls.defaults);
  });

  it('accepts an explicit empty allow-list as deny-all', () => {
    expect(TargetExecutionControlsSchema.safeParse({
      defaults: {
        workspace: { workspaceMode: 'not-required' },
        tools: { toolPolicyKind: 'allow-list', allowedTools: [] },
      },
      sampleOverrides: [],
    }).success).toBe(true);
  });

  it('rejects empty overrides, locators, and Gold workspace descriptors', () => {
    const base = {
      defaults: {
        workspace: { workspaceMode: 'not-required' },
        tools: { toolPolicyKind: 'runtime-default' },
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
