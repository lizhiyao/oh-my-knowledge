import {
  deepFreezeCanonicalJson,
  type TargetExecutionControls,
} from '../eval-core/contracts/index.js';
import type { CapturedAllowedToolsPlan } from './tool-policy.js';
import type { CapturedWorkspacePlan, WorkspaceDescriptor } from './workspace.js';

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function workspaceControl(descriptor: WorkspaceDescriptor | null | undefined) {
  return descriptor === null || descriptor === undefined
    ? { workspaceMode: 'not-required' as const }
    : { workspaceMode: 'copy-on-write-overlay' as const, descriptor };
}

function toolControl(tools: readonly string[] | null | undefined) {
  return tools === null || tools === undefined
    ? { toolPolicyKind: 'runtime-default' as const }
    : { toolPolicyKind: 'allow-list' as const, allowedTools: [...tools] };
}

export function evaluationExecutionControls(
  workspace: CapturedWorkspacePlan | undefined,
  allowedTools: CapturedAllowedToolsPlan | undefined,
): TargetExecutionControls {
  const sampleIds = [...new Set([
    ...Object.keys(workspace?.bySampleId ?? {}),
    ...Object.keys(allowedTools?.bySampleId ?? {}),
  ])].sort(compareStrings);
  return deepFreezeCanonicalJson({
    defaults: {
      workspace: workspaceControl(workspace?.default),
      tools: toolControl(allowedTools?.default),
    },
    sampleOverrides: sampleIds.map((sampleId) => ({
      sampleId,
      ...(Object.prototype.hasOwnProperty.call(workspace?.bySampleId ?? {}, sampleId)
        ? { workspace: workspaceControl(workspace?.bySampleId[sampleId]) }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(allowedTools?.bySampleId ?? {}, sampleId)
        ? { tools: toolControl(allowedTools?.bySampleId[sampleId]) }
        : {}),
    })),
  });
}
