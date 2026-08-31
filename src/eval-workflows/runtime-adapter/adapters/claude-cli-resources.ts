import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { z } from 'zod';
import {
  JsonValueSchema,
  canonicalizeJson,
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  type EvaluationDefinition,
  type JsonValue,
} from '../../../evaluation-core/contracts/index.js';
import {
  ExecutionPortFailure,
  type ExecutionContent,
  type ExecutorTrialContext,
} from '../../../evaluation-core/execution/index.js';
import {
  type CliMockHandle,
} from '../../../eval-core/mocks-runtime.js';
import type { Mock, MockMatch, MockReturn } from '../../../types/eval.js';
import type { RuntimeBindingOf } from '../types.js';
import type {
  OmkBindingResourceLease,
  OmkLeasedHostResource,
} from '../resource-leases/types.js';

const DescriptorSchema = z.object({
  resourceId: z.string().min(1),
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  mediaType: z.string().min(1),
  classification: z.enum(['public', 'sensitive', 'secret', 'gold']),
  size: z.number().int().nonnegative(),
}).strict();

const ClaudeMockMatchSchema = z.object({
  file_path: z.string().optional(),
  file_path_endswith: z.string().optional(),
  url: z.string().optional(),
  url_glob: z.string().optional(),
  command_glob: z.string().optional(),
  input: z.record(z.string(), z.unknown()).optional(),
  input_contains: z.string().optional(),
}).strict();

const ClaudeMockRulesSchema = z.object({
  tool: z.string().min(1),
  match: ClaudeMockMatchSchema.optional(),
}).strict();

const ClaudeTargetConfigSchema = z.object({
  behavior: z.object({
    artifact: DescriptorSchema,
    workspace: DescriptorSchema.optional(),
    mcpConfig: DescriptorSchema.optional(),
    mocks: z.array(z.object({
      sampleIds: z.array(z.string().min(1)).min(1),
      matchRules: JsonValueSchema,
      strict: z.boolean(),
      payloads: z.array(DescriptorSchema),
    }).strict()).optional(),
    allowedTools: z.array(z.string().min(1).refine((value) => (
      !/[\u0000-\u001f\u007f]/.test(value)
      && !value.startsWith('-')
      && !value.includes(',')
    ))).optional(),
    allowedSkills: z.array(z.string().min(1)).optional(),
    sandbox: z.object({
      sandboxId: z.string().min(1),
      config: z.object({
        classification: z.enum(['public', 'sensitive']),
        value: JsonValueSchema,
      }).strict().optional(),
    }).strict().optional(),
    config: z.object({
      classification: z.enum(['public', 'sensitive']),
      value: JsonValueSchema,
    }).strict().optional(),
  }).strict(),
  runtime: z.object({
    model: z.string().regex(/^[A-Za-z0-9._:-]+$/),
    effort: z.enum(['low', 'medium', 'high', 'max']).optional(),
  }).strict(),
}).strict();

export type ClaudeCliTargetConfig = z.infer<typeof ClaudeTargetConfigSchema>;

export interface CapturedClaudeCliTarget {
  readonly target: EvaluationDefinition['targets'][number];
  readonly binding: RuntimeBindingOf<'executor'>;
  readonly config: ClaudeCliTargetConfig;
}

export interface ClaudeCliRunState {
  readonly workingDirectory: string;
  readonly systemInstructions?: string;
  readonly systemPromptBytes: number;
  readonly supportingFiles?: readonly { readonly path: string; readonly content: string }[];
  readonly mcpConfigFile?: string;
  readonly mcpServers?: Readonly<Record<string, unknown>>;
  readonly mockControlsBySampleId: ReadonlyMap<string, ClaudeTrialMockControls>;
  readonly classification: ExecutionContent['classification'];
  acquireTrial(): void;
  releaseTrial(): Promise<void>;
  requestDispose(): Promise<void>;
}

export interface ClaudeCliTrialState {
  readonly prompt: string;
  readonly mocks?: readonly Mock[];
  readonly mocksStrict: boolean;
  readonly classification: ExecutionContent['classification'];
}

export interface ClaudeTrialMockControls {
  readonly mocks: readonly Mock[];
  readonly strict: boolean;
  readonly classification: ExecutionContent['classification'];
}

export interface ClaudeResourceProjectionProfile {
  readonly adapterLabel: 'Claude CLI' | 'Claude SDK' | 'DSH Host';
  readonly errorPrefix: 'OMK_CLAUDE_CLI' | 'OMK_CLAUDE_SDK' | 'OMK_DSH_HOST';
  readonly mcpMockMode: 'synthetic-server' | 'hook-existing-tool';
  readonly promptSchemaVersion:
    | 'omk.claude-cli-prompt/v1'
    | 'omk.claude-sdk-prompt/v1'
    | 'omk.dsh-host-prompt/v1';
}

export const CLAUDE_CLI_RESOURCE_PROFILE = Object.freeze({
  adapterLabel: 'Claude CLI',
  errorPrefix: 'OMK_CLAUDE_CLI',
  mcpMockMode: 'synthetic-server',
  promptSchemaVersion: 'omk.claude-cli-prompt/v1',
}) satisfies ClaudeResourceProjectionProfile;

export const CLAUDE_SDK_RESOURCE_PROFILE = Object.freeze({
  adapterLabel: 'Claude SDK',
  errorPrefix: 'OMK_CLAUDE_SDK',
  mcpMockMode: 'hook-existing-tool',
  promptSchemaVersion: 'omk.claude-sdk-prompt/v1',
}) satisfies ClaudeResourceProjectionProfile;

type KnowledgeArtifact =
  | { readonly artifactKind: 'file'; readonly instructions: string }
  | {
      readonly artifactKind: 'directory';
      readonly entrypoint: 'SKILL.md';
      readonly instructions: string;
      readonly files: readonly { readonly path: string; readonly content: string }[];
    };

function fail(
  profile: ClaudeResourceProjectionProfile,
  codeSuffix: string,
  message: string,
): never {
  throw new ExecutionPortFailure({
    code: `${profile.errorPrefix}_${codeSuffix}`,
    stage: 'infrastructure',
    message: `${profile.adapterLabel} ${message}`,
  });
}

export function captureClaudeCliTarget(
  targetInput: EvaluationDefinition['targets'][number],
  bindingInput: RuntimeBindingOf<'executor'>,
  profile: ClaudeResourceProjectionProfile = CLAUDE_CLI_RESOURCE_PROFILE,
): CapturedClaudeCliTarget {
  const target = structuredClone(targetInput);
  const binding = structuredClone(bindingInput);
  if (
    target.targetId !== binding.targetId
    || target.executorId !== binding.implementationId
    || target.protocolId !== binding.protocolId
    || canonicalizeJson(target.executionRequirements)
      !== canonicalizeJson(binding.qualification.executionRequirements)
    || digestCanonicalJson(target.config ?? null) !== binding.behaviorConfigDigest
  ) throw new TypeError(`${profile.adapterLabel} Target and Runtime binding are inconsistent.`);
  if (target.protocolId !== 'omk.invoke/v1') {
    throw new TypeError(`${profile.adapterLabel} Core adapter supports only omk.invoke/v1.`);
  }
  const config = ClaudeTargetConfigSchema.parse(target.config);
  const configuredDescriptors = [
    config.behavior.artifact,
    ...(config.behavior.workspace === undefined ? [] : [config.behavior.workspace]),
    ...(config.behavior.mcpConfig === undefined ? [] : [config.behavior.mcpConfig]),
    ...(config.behavior.mocks ?? []).flatMap((mock) => mock.payloads),
  ];
  if (configuredDescriptors.some((descriptor) => descriptor.classification === 'gold')) {
    throw new TypeError(`${profile.adapterLabel} Executor Target must not reference Gold resources.`);
  }
  const expectedRequirements = new Map<string, {
    resourceId: string;
    resourceRole: 'artifact' | 'workspace' | 'mcp-config' | 'mock-payload';
    leaseMode: 'immutable-snapshot' | 'copy-on-write-overlay';
  }>();
  const addRequirement = (
    resourceId: string,
    resourceRole: 'artifact' | 'workspace' | 'mcp-config' | 'mock-payload',
    leaseMode: 'immutable-snapshot' | 'copy-on-write-overlay',
  ): void => {
    const next = { resourceId, resourceRole, leaseMode } as const;
    const existing = expectedRequirements.get(resourceId);
    if (existing !== undefined && canonicalizeJson(existing) !== canonicalizeJson(next)) {
      throw new TypeError(`${profile.adapterLabel} Target assigns one resource to conflicting roles.`);
    }
    expectedRequirements.set(resourceId, next);
  };
  addRequirement(config.behavior.artifact.resourceId, 'artifact', 'immutable-snapshot');
  if (config.behavior.workspace !== undefined) {
    addRequirement(
      config.behavior.workspace.resourceId,
      'workspace',
      'copy-on-write-overlay',
    );
  }
  if (config.behavior.mcpConfig !== undefined) {
    addRequirement(config.behavior.mcpConfig.resourceId, 'mcp-config', 'immutable-snapshot');
  }
  for (const mock of config.behavior.mocks ?? []) {
    for (const payload of mock.payloads) {
      addRequirement(payload.resourceId, 'mock-payload', 'immutable-snapshot');
    }
  }
  const expectedRequirementList = [...expectedRequirements.values()].sort((left, right) => (
    left.resourceId < right.resourceId ? -1 : left.resourceId > right.resourceId ? 1 : 0
  ));
  const actualRequirementList = [...binding.resourceLeaseRequirements].sort((left, right) => (
    left.resourceId < right.resourceId ? -1 : left.resourceId > right.resourceId ? 1 : 0
  ));
  if (canonicalizeJson(expectedRequirementList) !== canonicalizeJson(actualRequirementList)) {
    throw new TypeError(`${profile.adapterLabel} Runtime binding has inconsistent resource requirements.`);
  }
  if (
    config.runtime.model !== binding.qualification.model
    || config.runtime.effort !== binding.qualification.effort
  ) throw new TypeError(`${profile.adapterLabel} Runtime qualification does not match Target config.`);
  if ((config.behavior.allowedSkills?.length ?? 0) > 0) {
    throw new TypeError(`${profile.adapterLabel} Core adapter cannot enforce a non-empty skill allow-list.`);
  }
  if (config.behavior.sandbox !== undefined) {
    throw new TypeError(`${profile.adapterLabel} Core adapter does not provide a verifiable sandbox.`);
  }
  if (config.behavior.config !== undefined) {
    throw new TypeError(`${profile.adapterLabel} Core adapter does not accept opaque provider config.`);
  }
  const mockBindings = config.behavior.mocks ?? [];
  if (mockBindings.some((mock) => new Set(mock.sampleIds).size !== mock.sampleIds.length)) {
    throw new TypeError(`${profile.adapterLabel} mock binding sampleIds must be unique.`);
  }
  const strictBySampleId = new Map<string, boolean>();
  for (const mock of mockBindings) {
    for (const sampleId of mock.sampleIds) {
      const existing = strictBySampleId.get(sampleId);
      if (existing !== undefined && existing !== mock.strict) {
        throw new TypeError(`${profile.adapterLabel} mock bindings for one sample must use one strictness policy.`);
      }
      strictBySampleId.set(sampleId, mock.strict);
    }
  }
  if (mockBindings.some((mock) => !ClaudeMockRulesSchema.safeParse(mock.matchRules).success)) {
    throw new TypeError(`${profile.adapterLabel} mock matchRules do not satisfy the hook contract.`);
  }
  if (mockBindings.some((mock) => {
    const rules = ClaudeMockRulesSchema.safeParse(mock.matchRules);
    return rules.success
      && rules.data.tool.startsWith('mcp__')
      && mockMcpServerName(rules.data.tool) === undefined;
  })) {
    throw new TypeError(`${profile.adapterLabel} MCP mock tool names must identify one server and tool.`);
  }
  if (
    config.behavior.mcpConfig !== undefined
    && config.behavior.allowedTools !== undefined
  ) {
    throw new TypeError(
      `${profile.adapterLabel} cannot enforce one complete tool allow-list across built-in and dynamic MCP tools.`,
    );
  }
  if (
    config.behavior.allowedTools !== undefined
    && mockBindings.some((mock) => {
      const rules = ClaudeMockRulesSchema.safeParse(mock.matchRules);
      return rules.success && rules.data.tool.startsWith('mcp__');
    })
  ) {
    throw new TypeError(
      `${profile.adapterLabel} cannot combine a built-in tool allow-list with MCP tool mocks.`,
    );
  }
  if (config.behavior.allowedTools !== undefined
      && new Set(config.behavior.allowedTools).size !== config.behavior.allowedTools.length) {
    throw new TypeError(`${profile.adapterLabel} built-in tool allow-list must not contain duplicates.`);
  }
  if (config.behavior.allowedTools?.some((tool) => tool.startsWith('mcp__'))) {
    throw new TypeError(`${profile.adapterLabel} built-in tool allow-list must not contain MCP tools.`);
  }
  if (
    config.behavior.allowedSkills !== undefined
    && config.behavior.allowedTools?.includes('Skill')
  ) {
    throw new TypeError(`${profile.adapterLabel} disabled skills conflict with the Skill tool.`);
  }
  return deepFreezeCanonicalJson({ target, binding, config });
}

function sameDescriptor(
  resource: OmkLeasedHostResource,
  expected: z.infer<typeof DescriptorSchema>,
): boolean {
  return canonicalizeJson(resource.descriptor) === canonicalizeJson(expected);
}

async function readTextFile(
  profile: ClaudeResourceProjectionProfile,
  path: string,
  codeSuffix: string,
  subject: string,
): Promise<string> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch {
    fail(profile, codeSuffix, `${subject} is unavailable.`);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail(profile, codeSuffix, `${subject} contains non-UTF-8 content.`);
  }
}

async function directoryFiles(
  profile: ClaudeResourceProjectionProfile,
  current: string,
): Promise<readonly string[]> {
  const { readdir } = await import('node:fs/promises');
  let entries: Dirent<string>[];
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    fail(profile, 'ARTIFACT_INVALID', 'artifact directory is unavailable.');
  }
  const paths: string[] = [];
  for (const entry of entries.sort((left, right) => (
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  ))) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) paths.push(...await directoryFiles(profile, path));
    else if (entry.isFile()) paths.push(path);
    else fail(profile, 'ARTIFACT_INVALID', 'artifact snapshot contains an unsupported entry.');
  }
  return paths;
}

async function projectArtifact(
  profile: ClaudeResourceProjectionProfile,
  resource: OmkLeasedHostResource,
): Promise<KnowledgeArtifact | undefined> {
  if (resource.leaseMode !== 'immutable-snapshot' || resource.resourceKind !== 'artifact') {
    fail(profile, 'ARTIFACT_INVALID', 'artifact must be an immutable artifact snapshot.');
  }
  if (resource.snapshotKind === 'file') {
    const text = await readTextFile(profile, resource.snapshotPath, 'ARTIFACT_INVALID', 'artifact');
    if (resource.descriptor.mediaType === 'application/json') {
      try {
        const parsed = JsonValueSchema.parse(JSON.parse(text) as unknown);
        if (
          typeof parsed === 'object'
          && parsed !== null
          && !Array.isArray(parsed)
          && typeof parsed.body === 'string'
        ) return parsed.body === '' ? undefined : { artifactKind: 'file', instructions: parsed.body };
        const instructions = canonicalizeJson(parsed);
        return instructions === '' ? undefined : { artifactKind: 'file', instructions };
      } catch {
        fail(profile, 'ARTIFACT_INVALID', 'JSON artifact is invalid.');
      }
    }
    return text === '' ? undefined : { artifactKind: 'file', instructions: text };
  }
  const files = await directoryFiles(profile, resource.snapshotPath);
  if (files.length === 0) return undefined;
  const sections = (await Promise.all(files.map(async (path) => ({
    path: relative(resource.snapshotPath, path).replaceAll('\\', '/'),
    content: await readTextFile(profile, path, 'ARTIFACT_INVALID', 'artifact'),
  })))).sort((left, right) => (
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  ));
  const entrypoint = sections.find((section) => section.path === 'SKILL.md');
  if (entrypoint === undefined) {
    fail(profile, 'ARTIFACT_INVALID', 'directory artifact must contain a root SKILL.md entrypoint.');
  }
  return {
    artifactKind: 'directory',
    entrypoint: 'SKILL.md',
    instructions: entrypoint.content,
    files: sections.filter((section) => section.path !== 'SKILL.md'),
  };
}

function maxClassification(
  resources: readonly OmkLeasedHostResource[],
): ExecutionContent['classification'] {
  const rank = { public: 0, sensitive: 1, secret: 2, gold: 3 } as const;
  return resources.reduce<ExecutionContent['classification']>((current, resource) => (
    rank[resource.descriptor.classification] > rank[current]
      ? resource.descriptor.classification
      : current
  ), 'public');
}

function higherClassification(
  left: ExecutionContent['classification'],
  right: ExecutionContent['classification'],
): ExecutionContent['classification'] {
  const rank = { public: 0, sensitive: 1, secret: 2, gold: 3 } as const;
  return rank[right] > rank[left] ? right : left;
}

async function validateMcpConfig(
  profile: ClaudeResourceProjectionProfile,
  resource: OmkLeasedHostResource,
  expected: z.infer<typeof DescriptorSchema>,
): Promise<{
  readonly path: string;
  readonly serverNames: readonly string[];
  readonly servers: Readonly<Record<string, unknown>>;
}> {
  if (
    resource.resourceKind !== 'mcp-config'
    || resource.leaseMode !== 'immutable-snapshot'
    || resource.snapshotKind !== 'file'
    || !sameDescriptor(resource, expected)
  ) fail(profile, 'MCP_CONFIG_INVALID', 'MCP config lease does not match the sealed Target.');
  const text = await readTextFile(
    profile,
    resource.snapshotPath,
    'MCP_CONFIG_INVALID',
    'MCP config',
  );
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    if (
      profile.mcpMockMode === 'hook-existing-tool'
      && Object.keys(value).some((key) => key !== 'mcpServers')
    ) throw new Error();
    const rawServers = (value as Record<string, unknown>).mcpServers;
    if (rawServers !== undefined
        && (rawServers === null || typeof rawServers !== 'object' || Array.isArray(rawServers))) {
      throw new Error();
    }
    const servers = structuredClone((rawServers ?? {}) as Record<string, unknown>);
    return {
      path: resource.snapshotPath,
      serverNames: Object.freeze(Object.keys(servers).sort()),
      servers: Object.freeze(servers),
    };
  } catch {
    fail(profile, 'MCP_CONFIG_INVALID', 'MCP config is not a JSON object.');
  }
}

function mockMcpServerName(tool: string): string | undefined {
  if (!tool.startsWith('mcp__')) return undefined;
  const rest = tool.slice('mcp__'.length);
  const separator = rest.lastIndexOf('__');
  return separator <= 0 || separator === rest.length - 2
    ? undefined
    : rest.slice(0, separator);
}

function mockReturn(profile: ClaudeResourceProjectionProfile, value: unknown): MockReturn {
  if (typeof value === 'string') return value;
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as MockReturn;
  }
  fail(profile, 'MOCK_PAYLOAD_INVALID', 'mock payload must be a string or JSON object.');
}

function readonlyMapSnapshot<Key, Value>(source: ReadonlyMap<Key, Value>): ReadonlyMap<Key, Value> {
  const snapshot = new Map(source);
  const view: ReadonlyMap<Key, Value> = Object.freeze({
    get size() { return snapshot.size; },
    get(key: Key) { return snapshot.get(key); },
    has(key: Key) { return snapshot.has(key); },
    keys() { return snapshot.keys(); },
    values() { return snapshot.values(); },
    entries() { return snapshot.entries(); },
    [Symbol.iterator]() { return snapshot[Symbol.iterator](); },
    forEach(
      callback: (value: Value, key: Key, map: ReadonlyMap<Key, Value>) => void,
      thisArg?: unknown,
    ) {
      snapshot.forEach((value, key) => callback.call(thisArg, value, key, view));
    },
  });
  return view;
}

async function readMockPayload(
  profile: ClaudeResourceProjectionProfile,
  resource: OmkLeasedHostResource,
): Promise<MockReturn> {
  if (
    resource.resourceKind !== 'mock-payload'
    || resource.leaseMode !== 'immutable-snapshot'
    || resource.snapshotKind !== 'file'
  ) fail(profile, 'MOCK_PAYLOAD_INVALID', 'mock payload must be an immutable file snapshot.');
  const text = await readTextFile(
    profile,
    resource.snapshotPath,
    'MOCK_PAYLOAD_INVALID',
    'mock payload',
  );
  if (resource.descriptor.mediaType === 'application/json') {
    try {
      return mockReturn(profile, JSON.parse(text) as unknown);
    } catch (error) {
      if (error instanceof ExecutionPortFailure) throw error;
      fail(profile, 'MOCK_PAYLOAD_INVALID', 'mock payload contains invalid JSON.');
    }
  }
  return text;
}

async function projectMocks(
  profile: ClaudeResourceProjectionProfile,
  lease: OmkBindingResourceLease,
  config: ClaudeCliTargetConfig,
): Promise<{
  bySampleId: ReadonlyMap<string, ClaudeTrialMockControls>;
  mcpServerNames: readonly string[];
}> {
  const bindings = config.behavior.mocks ?? [];
  if (bindings.length === 0) return {
    bySampleId: readonlyMapSnapshot(new Map()),
    mcpServerNames: [],
  };
  const mutableBySampleId = new Map<string, {
    mocks: Mock[];
    strict: boolean;
    classification: ExecutionContent['classification'];
  }>();
  const mcpServerNames = new Set<string>();
  for (const binding of bindings) {
    const rules = ClaudeMockRulesSchema.safeParse(binding.matchRules);
    if (!rules.success) {
      fail(profile, 'MOCK_CONFIG_INVALID', 'mock matchRules do not satisfy the Claude hook contract.');
    }
    const returns: MockReturn[] = [];
    const mcpServerName = mockMcpServerName(rules.data.tool);
    if (mcpServerName !== undefined) mcpServerNames.add(mcpServerName);
    for (const descriptor of binding.payloads) {
      const resource = lease.resourcesByResourceId.get(descriptor.resourceId);
      if (resource === undefined || !sameDescriptor(resource, descriptor)) {
        fail(profile, 'MOCK_PAYLOAD_INVALID', 'mock payload lease does not match the sealed Target.');
      }
      returns.push(await readMockPayload(profile, resource));
    }
    const mock: Mock = {
      tool: rules.data.tool,
      ...(rules.data.match === undefined ? {} : { match: rules.data.match as MockMatch }),
      ...(returns.length === 0
        ? { return: '' }
        : returns.length === 1
          ? { return: returns[0] }
          : { return_seq: returns }),
    };
    for (const sampleId of binding.sampleIds) {
      const existing = mutableBySampleId.get(sampleId);
      if (existing !== undefined && existing.strict !== binding.strict) {
        fail(profile, 'MOCK_CONFIG_INVALID', 'mock bindings for one sample must agree on strictness.');
      }
      if (existing === undefined) {
        mutableBySampleId.set(sampleId, {
          mocks: [mock],
          strict: binding.strict,
          classification: binding.payloads.reduce<ExecutionContent['classification']>(
            (current, descriptor) => higherClassification(current, descriptor.classification),
            'public',
          ),
        });
      } else {
        existing.mocks.push(mock);
        existing.classification = binding.payloads.reduce<ExecutionContent['classification']>(
          (current, descriptor) => higherClassification(current, descriptor.classification),
          existing.classification,
        );
      }
    }
  }
  const bySampleId = new Map([...mutableBySampleId.entries()].map(([sampleId, controls]) => [
    sampleId,
    Object.freeze({
      mocks: Object.freeze(controls.mocks),
      strict: controls.strict,
      classification: controls.classification,
    }),
  ]));
  return {
    bySampleId: readonlyMapSnapshot(bySampleId),
    mcpServerNames: Object.freeze([...mcpServerNames].sort()),
  };
}

async function pathAbsent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

export async function captureClaudeCliRunState(
  lease: OmkBindingResourceLease,
  target: CapturedClaudeCliTarget,
  maxInputBytes: number,
  profile: ClaudeResourceProjectionProfile = CLAUDE_CLI_RESOURCE_PROFILE,
): Promise<ClaudeCliRunState> {
  if (lease.consumerKind !== 'executor' || lease.bindingId !== target.binding.bindingId) {
    fail(profile, 'RESOURCE_FORBIDDEN', 'received a resource lease for another consumer.');
  }
  const entries = [...lease.resourcesByResourceId.entries()];
  if (entries.some(([resourceId, resource]) => (
    resourceId !== resource.resourceId || resource.resourceId !== resource.descriptor.resourceId
  ))) fail(profile, 'RESOURCE_INVALID', 'resource lease identity is inconsistent.');
  const resources = entries.map(([, resource]) => resource);
  let projectedInputBytes = 0;
  for (const resource of resources) {
    if (resource.resourceKind === 'workspace') continue;
    if (resource.descriptor.size > maxInputBytes - projectedInputBytes) {
      fail(profile, 'INPUT_LIMIT_EXCEEDED', 'leased control resources exceed the adapter input limit.');
    }
    projectedInputBytes += resource.descriptor.size;
  }
  const expectedIds = target.binding.resourceLeaseRequirements
    .map((requirement) => requirement.resourceId)
    .sort();
  const actualIds = [...lease.resourcesByResourceId.keys()].sort();
  if (canonicalizeJson(actualIds) !== canonicalizeJson(expectedIds)) {
    fail(profile, 'RESOURCE_INVALID', 'resource lease coverage does not match the sealed binding.');
  }
  if (resources.some((resource) => (
    resource.resourceKind === 'gold-dataset' || resource.descriptor.classification === 'gold'
  ))) fail(profile, 'RESOURCE_FORBIDDEN', 'Executor received an analysis-only resource.');
  const artifact = lease.resourcesByResourceId.get(target.config.behavior.artifact.resourceId);
  if (artifact === undefined || !sameDescriptor(artifact, target.config.behavior.artifact)) {
    fail(profile, 'ARTIFACT_INVALID', 'artifact lease does not match the sealed Target.');
  }
  const projectedArtifact = await projectArtifact(profile, artifact);
  const requiresInstructions = target.target.executionRequirements.systemInstructions === 'required';
  if (requiresInstructions && projectedArtifact?.instructions.trim() === '') {
    fail(profile, 'ARTIFACT_INVALID', 'Target requires non-empty artifact instructions.');
  }
  if (requiresInstructions && projectedArtifact === undefined) {
    fail(profile, 'ARTIFACT_INVALID', 'Target requires non-empty artifact instructions.');
  }
  if (!requiresInstructions && projectedArtifact !== undefined) {
    fail(profile, 'ARTIFACT_INVALID', 'Target forbids system instructions but has a non-empty artifact.');
  }
  const mcpDescriptor = target.config.behavior.mcpConfig;
  const mcpConfig = mcpDescriptor === undefined
    ? undefined
    : await validateMcpConfig(
        profile,
        lease.resourcesByResourceId.get(mcpDescriptor.resourceId)
          ?? fail(profile, 'MCP_CONFIG_INVALID', 'MCP config resource is missing.'),
        mcpDescriptor,
      );
  const mockProjection = await projectMocks(profile, lease, target.config);
  if (profile.mcpMockMode === 'synthetic-server') {
    if (mcpConfig !== undefined && mockProjection.mcpServerNames.some((serverName) => (
      mcpConfig.serverNames.includes(serverName)
    ))) fail(profile, 'MCP_CONFIG_INVALID', 'MCP config and mock controls define the same server name.');
  } else if (mockProjection.mcpServerNames.some((serverName) => (
    mcpConfig === undefined || !mcpConfig.serverNames.includes(serverName)
  ))) {
    fail(profile, 'MCP_CONFIG_INVALID', 'SDK MCP mocks require the matching sealed MCP server config.');
  }
  let workingDirectory: string | undefined;
  let privateWorkingDirectory = false;
  try {
    const workspaceDescriptor = target.config.behavior.workspace;
    if (workspaceDescriptor === undefined) {
      workingDirectory = await mkdtemp(join(tmpdir(), 'omk-claude-run-'));
      privateWorkingDirectory = true;
    } else {
      const workspace = lease.resourcesByResourceId.get(workspaceDescriptor.resourceId);
      if (
        workspace?.resourceKind !== 'workspace'
        || workspace.leaseMode !== 'copy-on-write-overlay'
        || !sameDescriptor(workspace, workspaceDescriptor)
      ) fail(profile, 'WORKSPACE_INVALID', 'workspace lease does not match the sealed Target.');
      workingDirectory = workspace.overlayPath;
    }
    let systemPromptBytes = 0;
    if (requiresInstructions && projectedArtifact !== undefined) {
      systemPromptBytes = Buffer.byteLength(projectedArtifact.instructions);
      if (systemPromptBytes > maxInputBytes) {
        fail(profile, 'INPUT_LIMIT_EXCEEDED', 'system instructions exceed the adapter input limit.');
      }
    }
    let activeTrials = 0;
    let disposeRequested = false;
    let disposeResult: Promise<void> | undefined;
    const runPaths = privateWorkingDirectory ? [workingDirectory] : [];
    const startDispose = (): Promise<void> => {
      disposeResult ??= (async () => {
        const results = await Promise.allSettled(runPaths.map((path) => (
          rm(path, { recursive: true, force: true })
        )));
        if (results.some((result) => result.status === 'rejected')) {
          fail(profile, 'RUN_DISPOSE_FAILED', 'run-owned directories could not be disposed.');
        }
      })();
      return disposeResult;
    };
    return Object.freeze({
      workingDirectory,
      ...(projectedArtifact?.instructions === undefined
        ? {}
        : { systemInstructions: projectedArtifact.instructions }),
      systemPromptBytes,
      ...(
        projectedArtifact?.artifactKind !== 'directory' || projectedArtifact.files.length === 0
          ? {}
          : { supportingFiles: projectedArtifact.files }
      ),
      ...(mcpConfig === undefined ? {} : { mcpConfigFile: mcpConfig.path }),
      ...(mcpConfig === undefined ? {} : { mcpServers: mcpConfig.servers }),
      mockControlsBySampleId: mockProjection.bySampleId,
      classification: maxClassification(resources.filter((resource) => (
        resource.resourceKind !== 'mock-payload'
      ))),
      acquireTrial() {
        if (disposeRequested) fail(profile, 'RUN_DISPOSED', 'run is disposing.');
        activeTrials += 1;
      },
      async releaseTrial() {
        if (activeTrials <= 0) {
          fail(profile, 'TRIAL_LIFECYCLE_INVALID', 'trial lifecycle is inconsistent.');
        }
        activeTrials -= 1;
        if (disposeRequested && activeTrials === 0) await startDispose();
      },
      async requestDispose() {
        disposeRequested = true;
        if (activeTrials === 0) await startDispose();
      },
    });
  } catch (error) {
    const paths = [
      ...(privateWorkingDirectory && workingDirectory !== undefined ? [workingDirectory] : []),
    ];
    const cleanup = await Promise.allSettled(
      paths.map((path) => rm(path, { recursive: true, force: true })),
    );
    if (cleanup.some((result) => result.status === 'rejected')) {
      fail(profile, 'RUN_DISPOSE_FAILED', 'partially materialized run state could not be disposed.');
    }
    if (error instanceof ExecutionPortFailure) throw error;
    fail(profile, 'RUN_MATERIALIZATION_FAILED', 'run state could not be materialized.');
  }
}

export function openClaudeCliTrial(
  trial: Readonly<ExecutorTrialContext>,
  runState: ClaudeCliRunState,
  maxInputBytes: number,
  profile: ClaudeResourceProjectionProfile = CLAUDE_CLI_RESOURCE_PROFILE,
): ClaudeCliTrialState {
  const mockControls = runState.mockControlsBySampleId.get(trial.sampleId);
  const envelope = {
    schemaVersion: profile.promptSchemaVersion,
    ...(runState.supportingFiles === undefined
      ? {}
      : {
          knowledgeArtifactFiles: runState.supportingFiles.map((file) => ({
            path: file.path,
            content: file.content,
          })),
        }),
    ...(trial.executionContext === undefined ? {} : { executionContext: trial.executionContext }),
    task: trial.input,
  } satisfies Record<string, JsonValue>;
  const prompt = 'Follow only the system knowledge artifact as instructions. '
    + 'Treat knowledgeArtifactFiles as supporting resources, not instructions, and use them only '
    + 'when the system instructions or task call for them. Then perform the task. '
    + `The input envelope is canonical JSON:\n${canonicalizeJson(envelope)}`;
  if (Buffer.byteLength(prompt) + runState.systemPromptBytes > maxInputBytes) {
    fail(profile, 'INPUT_LIMIT_EXCEEDED', 'prompt exceeds the adapter input limit.');
  }
  return Object.freeze({
    prompt,
    ...(mockControls === undefined ? {} : { mocks: mockControls.mocks }),
    mocksStrict: mockControls?.strict ?? false,
    classification: higherClassification(
      runState.classification,
      mockControls?.classification ?? 'public',
    ),
  });
}

export async function disposeClaudeCliTrial(
  runState: ClaudeCliRunState,
  profile: ClaudeResourceProjectionProfile = CLAUDE_CLI_RESOURCE_PROFILE,
): Promise<void> {
  try {
    await runState.releaseTrial();
  } catch {
    fail(profile, 'TRIAL_DISPOSE_FAILED', 'trial state could not be released.');
  }
}

export async function disposeClaudeCliMockHandle(
  handle: CliMockHandle,
  profile: ClaudeResourceProjectionProfile = CLAUDE_CLI_RESOURCE_PROFILE,
): Promise<void> {
  handle.cleanup();
  if (!(await pathAbsent(handle.rootDir))) {
    fail(profile, 'ATTEMPT_DISPOSE_FAILED', 'mock materialization could not be disposed.');
  }
}
