import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { extname, isAbsolute, resolve } from 'node:path';
import { canonicalizeJson, JsonValueSchema, type JsonValue } from '../../../eval-core/contracts/index.js';
import { CliEvaluationInputError, type ResolvedHostResource, type ResolvedResourceDescriptor } from '../../input-compilation/index.js';
import { digestNodeFileResource, digestNodeTreeResource } from '../resource-leases/node.js';
import { materializeContentAddressedBytes, type MaterializedContentExtension, type MaterializationRejectionReason } from './content-materialization.js';

export interface ResourceRegistry {
  readonly resourcesById: Map<string, ResolvedHostResource>;
  add(resource: ResolvedHostResource): ResolvedResourceDescriptor;
}

export function fail(input: ConstructorParameters<typeof CliEvaluationInputError>[0]): never {
  throw new CliEvaluationInputError(input);
}

export function absolute(root: string, locator: string): string {
  return isAbsolute(locator) ? resolve(locator) : resolve(root, locator);
}

export function mediaType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.json': return 'application/json';
    case '.yaml':
    case '.yml': return 'application/yaml';
    case '.md': return 'text/markdown';
    default: return 'text/plain';
  }
}

function resourceId(
  resourceKind: ResolvedHostResource['resourceKind'],
  digest: ResolvedResourceDescriptor['digest'],
  identityScope?: string,
): string {
  const contentId = digest.slice('sha256:'.length);
  return identityScope === undefined
    ? `${resourceKind}-${contentId}`
    : `${resourceKind}-${createHash('sha256').update(identityScope).digest('hex').slice(0, 16)}-${contentId}`;
}

export function registry(): ResourceRegistry {
  const resourcesById = new Map<string, ResolvedHostResource>();
  return {
    resourcesById,
    add(resource) {
      const existing = resourcesById.get(resource.descriptor.resourceId);
      if (existing !== undefined) {
        if (canonicalizeJson(existing.descriptor) !== canonicalizeJson(resource.descriptor)
            || existing.resourceKind !== resource.resourceKind) fail({
          code: 'CLI_INPUT_RESOLUTION_FAILED',
          fieldPath: `hostResources.${resource.descriptor.resourceId}`,
          message: '内容寻址资源发生 descriptor 冲突。',
        });
        return existing.descriptor;
      }
      resourcesById.set(resource.descriptor.resourceId, resource);
      return resource.descriptor;
    },
  };
}

export async function fileResource(
  resources: ResourceRegistry,
  input: {
    readonly resourceKind: ResolvedHostResource['resourceKind'];
    readonly path: string;
    readonly classification: ResolvedResourceDescriptor['classification'];
    readonly mediaType?: string;
    readonly lineage?: JsonValue;
    readonly identityScope?: string;
  },
): Promise<ResolvedResourceDescriptor> {
  let measured: Awaited<ReturnType<typeof digestNodeFileResource>>;
  try {
    measured = await digestNodeFileResource(input.path);
  } catch (cause) {
    return fail({
      code: 'CLI_INPUT_RESOLUTION_FAILED',
      sourcePath: input.path,
      message: '无法读取并验证文件资源。',
      cause,
    });
  }
  const descriptor: ResolvedResourceDescriptor = {
    resourceId: resourceId(input.resourceKind, measured.digest, input.identityScope),
    digest: measured.digest,
    mediaType: input.mediaType ?? mediaType(input.path),
    classification: input.classification,
    size: measured.size,
  };
  return resources.add({
    resourceKind: input.resourceKind,
    descriptor,
    locator: input.path,
    ...(input.lineage === undefined ? {} : { lineage: input.lineage }),
    verification: {
      verificationKind: 'content-digest',
      verifiedDigest: descriptor.digest,
    },
  });
}

export async function treeResource(
  resources: ResourceRegistry,
  input: {
    readonly resourceKind: 'artifact' | 'workspace' | 'gold-dataset';
    readonly path: string;
    readonly classification: ResolvedResourceDescriptor['classification'];
    readonly mediaType: string;
    readonly lineage?: JsonValue;
    readonly identityScope?: string;
  },
): Promise<ResolvedResourceDescriptor> {
  let measured: Awaited<ReturnType<typeof digestNodeTreeResource>>;
  try {
    measured = await digestNodeTreeResource(input.path);
  } catch (cause) {
    return fail({
      code: 'CLI_INPUT_RESOLUTION_FAILED',
      sourcePath: input.path,
      message: '无法读取并验证目录树资源。',
      cause,
    });
  }
  const descriptor: ResolvedResourceDescriptor = {
    resourceId: resourceId(input.resourceKind, measured.digest, input.identityScope),
    digest: measured.digest,
    mediaType: input.mediaType,
    classification: input.classification,
    size: measured.size,
  };
  return resources.add({
    resourceKind: input.resourceKind,
    descriptor,
    locator: input.path,
    ...(input.lineage === undefined ? {} : { lineage: input.lineage }),
    verification: { verificationKind: 'tree-digest', verifiedDigest: descriptor.digest },
  });
}

/** 物化失败的措辞与错误码属本层词汇；存储原语只报告原因。 */
const MATERIALIZATION_REJECTION_MESSAGES: Record<MaterializationRejectionReason, string> = {
  'content-directory-not-plain': 'Resolver materialization content path 必须是普通目录，不能是符号链接。',
  'path-not-plain': 'Resolver materialization path 必须是普通文件，不能是符号链接。',
  'digest-mismatch': 'Resolver materialization path 已存在但内容摘要不一致。',
  'concurrent-path-not-plain': '并发物化命中的 path 必须是普通文件，不能是符号链接。',
  'concurrent-digest-mismatch': '并发物化命中了摘要不一致的既有资源。',
  'unsafe': '无法安全物化 resolver-owned 资源。',
};

export async function materializeBytes(
  root: string,
  bytes: Uint8Array,
  extension: MaterializedContentExtension,
): Promise<string> {
  return materializeContentAddressedBytes({
    root,
    bytes,
    extension,
    reject: ({ reason, path, cause }) => fail({
      code: 'CLI_INPUT_RESOLUTION_FAILED',
      sourcePath: path,
      message: MATERIALIZATION_REJECTION_MESSAGES[reason],
      ...(cause === undefined ? {} : { cause }),
    }),
  });
}

export async function optionalFileResource(
  resources: ResourceRegistry,
  projectRoot: string,
  materializationRoot: string,
  locator: string | undefined,
  resourceKind: 'mcp-config' | 'gold-dataset',
): Promise<ResolvedResourceDescriptor | undefined> {
  if (locator === undefined) return undefined;
  const path = absolute(projectRoot, locator);
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(path);
  } catch (cause) {
    return fail({
      code: 'CLI_INPUT_RESOLUTION_FAILED',
      sourcePath: path,
      message: '无法读取可选宿主资源。',
      cause,
    });
  }
  if (stat.isDirectory()) {
    if (resourceKind !== 'gold-dataset') fail({
      code: 'CLI_INPUT_RESOLUTION_FAILED',
      sourcePath: path,
      message: 'MCP config 必须是普通文件。',
    });
    return treeResource(resources, {
      resourceKind,
      path,
      classification: 'gold',
      mediaType: 'application/vnd.omk.gold-dataset-tree',
    });
  }
  if (!stat.isFile()) fail({
    code: 'CLI_INPUT_RESOLUTION_FAILED',
    sourcePath: path,
    message: '资源 locator 必须指向普通文件或受支持目录。',
  });
  if (resourceKind === 'mcp-config') {
    let value: JsonValue;
    try {
      value = JsonValueSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    } catch (cause) {
      return fail({
        code: 'CLI_INPUT_RESOLUTION_FAILED',
        sourcePath: path,
        message: 'MCP config 必须是合法 JSON。',
        cause,
      });
    }
    const canonicalPath = await materializeBytes(
      materializationRoot,
      Buffer.from(canonicalizeJson(value)),
      '.json',
    );
    return fileResource(resources, {
      resourceKind,
      path: canonicalPath,
      classification: 'secret',
      mediaType: 'application/json',
    });
  }
  return fileResource(resources, {
    resourceKind,
    path,
    classification: resourceKind === 'gold-dataset' ? 'gold' : 'secret',
  });
}
