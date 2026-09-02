import { z } from 'zod';
import {
  ContentClassificationSchema,
  IdentifierSchema,
  NonEmptyStringSchema,
  Sha256DigestSchema,
} from './common.js';

export const ExecutionResourceDescriptorSchema = z.object({
  resourceId: IdentifierSchema,
  digest: Sha256DigestSchema,
  mediaType: NonEmptyStringSchema,
  classification: ContentClassificationSchema.exclude(['gold']),
  size: z.number().int().nonnegative(),
}).strict();

export const WorkspaceExecutionControlSchema = z.discriminatedUnion('workspaceMode', [
  z.object({
    workspaceMode: z.literal('not-required'),
  }).strict(),
  z.object({
    workspaceMode: z.literal('copy-on-write-overlay'),
    descriptor: ExecutionResourceDescriptorSchema,
  }).strict(),
]);

export const ToolExecutionControlSchema = z.discriminatedUnion('toolPolicyKind', [
  z.object({
    toolPolicyKind: z.literal('runtime-default'),
  }).strict(),
  z.object({
    toolPolicyKind: z.literal('allow-list'),
    allowedTools: z.array(NonEmptyStringSchema),
  }).strict(),
]);

export const EffectiveExecutionControlSchema = z.object({
  workspace: WorkspaceExecutionControlSchema,
  tools: ToolExecutionControlSchema,
}).strict();

export const SampleExecutionControlOverrideSchema = z.object({
  sampleId: IdentifierSchema,
  workspace: WorkspaceExecutionControlSchema.optional(),
  tools: ToolExecutionControlSchema.optional(),
}).strict().refine(
  (value) => value.workspace !== undefined || value.tools !== undefined,
  { message: 'A sample execution-control override must replace at least one control.' },
);

export const TargetExecutionControlsSchema = z.object({
  defaults: EffectiveExecutionControlSchema,
  sampleOverrides: z.array(SampleExecutionControlOverrideSchema),
}).strict();

export type ExecutionResourceDescriptor = z.infer<typeof ExecutionResourceDescriptorSchema>;
export type WorkspaceExecutionControl = z.infer<typeof WorkspaceExecutionControlSchema>;
export type ToolExecutionControl = z.infer<typeof ToolExecutionControlSchema>;
export type EffectiveExecutionControl = z.infer<typeof EffectiveExecutionControlSchema>;
export type SampleExecutionControlOverride = z.infer<
  typeof SampleExecutionControlOverrideSchema
>;
export type TargetExecutionControls = z.infer<typeof TargetExecutionControlsSchema>;
type DeepReadonly<Value> = Value extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : Value extends object
    ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
    : Value;
export type ReadonlyTargetExecutionControls = DeepReadonly<TargetExecutionControls>;

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeTools(control: DeepReadonly<ToolExecutionControl>): ToolExecutionControl {
  return control.toolPolicyKind === 'runtime-default'
    ? control
    : { ...control, allowedTools: [...control.allowedTools].sort(compareStrings) };
}

export function normalizeTargetExecutionControls(
  controls: TargetExecutionControls,
): TargetExecutionControls {
  return {
    defaults: {
      workspace: controls.defaults.workspace,
      tools: normalizeTools(controls.defaults.tools),
    },
    sampleOverrides: controls.sampleOverrides
      .map((override) => ({
        sampleId: override.sampleId,
        ...(override.workspace === undefined ? {} : { workspace: override.workspace }),
        ...(override.tools === undefined ? {} : { tools: normalizeTools(override.tools) }),
      }))
      .sort((left, right) => compareStrings(left.sampleId, right.sampleId)),
  };
}

export function resolveEffectiveExecutionControl(
  controls: ReadonlyTargetExecutionControls,
  sampleId: string,
): EffectiveExecutionControl {
  const override = controls.sampleOverrides.find((candidate) => candidate.sampleId === sampleId);
  const workspace = override?.workspace ?? controls.defaults.workspace;
  const tools = override?.tools ?? controls.defaults.tools;
  return {
    workspace: workspace.workspaceMode === 'not-required'
      ? { workspaceMode: 'not-required' }
      : {
          workspaceMode: 'copy-on-write-overlay',
          descriptor: { ...workspace.descriptor },
        },
    tools: normalizeTools(tools),
  };
}
