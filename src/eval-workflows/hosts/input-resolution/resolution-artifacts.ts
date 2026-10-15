import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { type JsonValue } from '../../../eval-core/contracts/index.js';
import { resolveArtifacts, variantIdentity, parseVariantCwd } from '../../../knowledge-artifacts/sources/artifact-resolution.js';
import type { Artifact } from '../../../knowledge-artifacts/contracts.js';
import { CliEvaluationInputError, type CliEvaluationRequest, type ResolvedResourceDescriptor } from '../../input-compilation/index.js';
import { absolute, fail, fileResource, materializeBytes, mediaType, treeResource, type ResourceRegistry } from './resolution-resources.js';

const ARTIFACT_STORAGE_ERROR_CODES = new Set([
  'EACCES',
  'EDQUOT',
  'EEXIST',
  'ENOSPC',
  'ENOTDIR',
  'EPERM',
  'EROFS',
]);

function systemErrorCode(cause: unknown): string | undefined {
  if (cause === null || typeof cause !== 'object') return undefined;
  const code = (cause as NodeJS.ErrnoException).code;
  return typeof code === 'string' ? code : undefined;
}

export async function artifactResource(
  resources: ResourceRegistry,
  artifact: Readonly<Artifact>,
  targetId: string,
  materializationRoot: string,
): Promise<ResolvedResourceDescriptor> {
  const lineage: JsonValue = {
    targetId,
    sourceKind: artifact.source,
    artifactKind: artifact.kind,
    ...(artifact.locator === undefined ? {} : { sourceLocator: artifact.locator }),
    ...(artifact.skillRoot === undefined ? {} : { skillRootLocator: artifact.skillRoot }),
    ...(artifact.cwd === undefined ? {} : { workingDirectoryLocator: artifact.cwd }),
    ...(artifact.ref === undefined ? {} : { ref: artifact.ref }),
    ...(artifact.resolvedCommit === undefined ? {} : { commitId: artifact.resolvedCommit }),
    ...(artifact.contentHash === undefined ? {} : { sourceContentHash: artifact.contentHash }),
  };
  const candidate = artifact.execRoot ?? artifact.skillRoot ?? artifact.locator;
  if (candidate !== undefined && isAbsolute(candidate)) {
    let stat: Awaited<ReturnType<typeof lstat>> | undefined;
    try {
      stat = await lstat(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') fail({
        code: 'CLI_INPUT_RESOLUTION_FAILED',
        sourcePath: candidate,
        message: '无法检查 knowledge artifact locator。',
        cause: error,
      });
    }
    if (stat?.isDirectory()) return treeResource(resources, {
      resourceKind: 'artifact',
      path: candidate,
      classification: 'sensitive',
      mediaType: 'application/vnd.omk.knowledge-artifact-tree',
      lineage,
      identityScope: targetId,
    });
    if (stat?.isFile()) {
      let path: string;
      try {
        path = await materializeBytes(materializationRoot, await readFile(candidate), '.md');
      } catch (cause) {
        if (cause instanceof CliEvaluationInputError) throw cause;
        return fail({
          code: 'CLI_INPUT_RESOLUTION_FAILED',
          sourcePath: candidate,
          message: '无法封存 knowledge artifact 文件。',
          cause,
        });
      }
      return fileResource(resources, {
        resourceKind: 'artifact',
        path,
        classification: 'sensitive',
        mediaType: mediaType(candidate),
        lineage,
        identityScope: targetId,
      });
    }
    if (stat !== undefined) {
      fail({
        code: 'CLI_INPUT_RESOLUTION_FAILED',
        sourcePath: candidate,
        message: 'Knowledge artifact 必须是普通文件或不含特殊条目的目录树。',
      });
    }
  }
  const content = artifact.content ?? '';
  const path = await materializeBytes(materializationRoot, Buffer.from(content), '.md');
  return fileResource(resources, {
    resourceKind: 'artifact',
    path,
    classification: 'sensitive',
    mediaType: 'text/markdown',
    lineage,
    identityScope: targetId,
  });
}

export function resolveVariantInputs(request: Readonly<CliEvaluationRequest>, projectRoot: string) {
  const skillDirectory = absolute(projectRoot, request.values.locators.skillDirectory);
  const cliVariants = request.fieldSources.some((source) => source.normalizedField === 'values.variants' && source.sourceKind === 'cli-flag');
  if (cliVariants) {
    for (const variant of request.values.variants) {
      if (variant.artifactSource.artifactSourceKind !== 'expression') continue;
      const expression = variant.artifactSource.expression;
      if (/^(https?|ssh|git):\/\//i.test(expression) || /^[\w.-]+@[\w.-]+:/.test(expression)) {
        fail({ code: 'CLI_INPUT_INVALID', fieldPath: 'variants', message: '远端 git 源请在 eval.yaml 中使用结构化 git 字段。' });
      }
      if (parseVariantCwd(expression).cwd !== undefined) {
        fail({ code: 'CLI_INPUT_INVALID', fieldPath: 'variants', message: '「name@cwd」语法已移除，请使用 --control-cwd／--treatment-cwd 或 eval.yaml 的 cwd 字段。' });
      }
    }
  }
  const inputs = request.values.variants.map((variant) => (
    variant.artifactSource.artifactSourceKind === 'remote-git'
      ? {
          git: {
            url: variant.artifactSource.url,
            ...(variant.artifactSource.ref === undefined
              ? {}
              : { ref: variant.artifactSource.ref }),
            spec: variant.artifactSource.spec,
          },
          ...(variant.workspaceLocator === undefined
            ? {}
            : { cwd: absolute(projectRoot, variant.workspaceLocator) }),
          name: variant.targetId,
        }
      : {
          expr: (variant.artifactSource.expression.includes('/') || /\.md$/i.test(variant.artifactSource.expression))
            && !variant.artifactSource.expression.startsWith('git:')
            ? absolute(projectRoot, variant.artifactSource.expression)
            : variant.artifactSource.expression,
          ...(variant.workspaceLocator === undefined
            ? {}
            : { cwd: absolute(projectRoot, variant.workspaceLocator) }),
        }
  ));
  const identities = new Set<string>();
  for (const input of inputs) {
    const expression = 'expr' in input ? input.expr : `git+${JSON.stringify(input.git)}`;
    const identity = variantIdentity(expression, skillDirectory, input.cwd);
    if (identities.has(identity)) fail({
      code: 'CLI_INPUT_DUPLICATE_ID', fieldPath: 'variants',
      message: `variant "${expression}" 重复出现，同一物理 variant 不能同时属于 control 与 treatment，也不能在 treatment 中重复。`,
    });
    identities.add(identity);
  }
  return { skillDirectory, inputs };
}

export function resolveRequestedArtifacts(request: Readonly<CliEvaluationRequest>, skillDirectory: string, inputs: Parameters<typeof resolveArtifacts>[1]): Artifact[] {
  let artifacts: Artifact[];
  try {
    artifacts = resolveArtifacts(skillDirectory, inputs, {
      strictBaseline: request.values.measurement.baselineIsolation,
      materialize: true,
    });
  } catch (cause) {
    const code = systemErrorCode(cause);
    const storageFailure = code !== undefined && ARTIFACT_STORAGE_ERROR_CODES.has(code);
    return fail({
      code: 'CLI_INPUT_RESOLUTION_FAILED',
      fieldPath: 'variants',
      message: storageFailure
        ? `无法创建 knowledge artifact 的评测隔离副本（${code}）。请检查源 skill 的读取权限，以及 \`OMK_HOME\` 或 \`OMK_TREES_DIR\` 指向目录的写入权限和剩余空间。`
        : '无法解析或物化 knowledge artifact；请检查 variant 表达式、skill 路径和文件内容。',
      ...(storageFailure
        ? {
            details: {
              resolutionFailureKind: 'artifact-materialization-storage',
              systemCode: code,
            },
          }
        : {}),
      cause,
    });
  }
  if (artifacts.length !== request.values.variants.length) fail({
    code: 'CLI_INPUT_RESOLUTION_FAILED',
    fieldPath: 'variants',
    message: 'Artifact resolver 返回数量与 variant request 不一致。',
  });
  return artifacts;
}
