import { UnsupportedSampleSchemaError } from '../../inputs/schemas/error.js';
import { loadSamples } from '../../inputs/load-samples.js';
import type { Sample } from '../../inputs/contracts/sample.js';
import { type CliEvaluationRequest } from '../../input-compilation/index.js';
import { createNodeSampleContentResolver } from './node-sample-content-resolver.js';
import { SampleContentResolutionError, hasResolvableSampleUrls, resolveSampleContents, type ResolvedSampleContentRecord, type SampleContentResolverSession } from '../../orchestration/sample-content-resolution.js';
import { absolute, fail, fileResource, materializeBytes, type ResourceRegistry } from './resolution-resources.js';

export async function resolvedSampleContentResources(
  resources: ResourceRegistry,
  contents: readonly ResolvedSampleContentRecord[],
  materializationRoot: string,
): Promise<readonly {
  readonly resourceId: string;
  readonly sourceUrlDigest: `sha256:${string}`;
  readonly contentDigest: `sha256:${string}`;
  readonly transportKind: 'http' | 'mcp';
  readonly sampleIds: readonly string[];
  readonly fields: readonly ('input.text')[];
}[]> {
  return Promise.all(contents.map(async (content) => {
    const path = await materializeBytes(
      materializationRoot,
      Buffer.from(content.content),
      content.mediaType === 'application/json' ? '.json' : '.txt',
    );
    const descriptor = await fileResource(resources, {
      resourceKind: 'content',
      path,
      classification: content.classification,
      mediaType: content.mediaType,
      identityScope: content.sourceUrlDigest,
      lineage: {
        lineageKind: 'sample-url-content',
        sourceUrlDigest: content.sourceUrlDigest,
        transportKind: content.transportKind,
        sampleIds: [...content.sampleIds],
        fields: [...content.fields],
      },
    });
    if (descriptor.digest !== content.contentDigest) fail({
      code: 'CLI_INPUT_RESOLUTION_FAILED',
      fieldPath: 'samples.externalContent',
      message: 'Sample URL 内容在解析与封存之间发生摘要漂移。',
    });
    return {
      resourceId: descriptor.resourceId,
      sourceUrlDigest: content.sourceUrlDigest,
      contentDigest: content.contentDigest,
      transportKind: content.transportKind,
      sampleIds: content.sampleIds,
      fields: content.fields,
    };
  }));
}

async function closeSampleContentResolver(
  session: SampleContentResolverSession,
  resolutionFailure: unknown,
): Promise<never | void> {
  try {
    await session.close();
  } catch (cleanupFailure) {
    if (resolutionFailure !== undefined) {
      throw new AggregateError(
        [resolutionFailure, cleanupFailure],
        'Sample content resolution and resolver cleanup both failed',
      );
    }
    throw cleanupFailure;
  }
  if (resolutionFailure !== undefined) throw resolutionFailure;
}

export function loadRequestedSamples(request: Readonly<CliEvaluationRequest>, projectRoot: string): ReturnType<typeof loadSamples> {
  let loaded: ReturnType<typeof loadSamples>;
  try {
    loaded = loadSamples(
      absolute(projectRoot, request.values.locators.samples),
    );
  } catch (cause) {
    return fail({
      code: 'CLI_INPUT_RESOLUTION_FAILED',
      sourcePath: request.values.locators.samples,
      fieldPath: 'samples',
      message: cause instanceof UnsupportedSampleSchemaError ? cause.message
        : '无法读取或解析 samples；请检查用例路径、文件权限和内容格式。',
      cause,
    });
  }
  return loaded;
}

export async function resolveExternalSamples(samples: readonly Sample[], request: Readonly<CliEvaluationRequest>, options: {
  readonly projectRoot: string;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly sampleContentResolver?: SampleContentResolverSession;
}) {
  let containsResolvableUrls: boolean;
  try {
    containsResolvableUrls = hasResolvableSampleUrls(samples);
  } catch (cause) {
    const contentError = cause instanceof SampleContentResolutionError ? cause : undefined;
    return fail({
      code: 'CLI_INPUT_RESOLUTION_FAILED',
      fieldPath: 'samples.externalContent',
      ...(contentError?.sourceLabel === undefined ? {} : { sourcePath: contentError.sourceLabel }),
      message: contentError?.message ?? '无法扫描 sample 外部内容引用。',
      cause,
    });
  }
  let resolvedSamples: readonly Sample[] = samples;
  let resolvedContents: readonly ResolvedSampleContentRecord[] = [];
  if (containsResolvableUrls) {
    let session: SampleContentResolverSession;
    try {
      session = options.sampleContentResolver ?? await createNodeSampleContentResolver({
        ...(request.values.locators.mcpConfig === undefined ? {} : {
          mcpConfigPath: absolute(options.projectRoot, request.values.locators.mcpConfig),
        }),
        ...(options.environment === undefined ? {} : { environment: options.environment }),
      });
    } catch (cause) {
      return fail({
        code: 'CLI_INPUT_RESOLUTION_FAILED',
        fieldPath: 'samples.externalContent',
        message: '无法创建 sample content resolver session。',
        cause,
      });
    }
    let resolutionFailure: unknown;
    try {
      const result = await resolveSampleContents(samples, session);
      resolvedSamples = result.samples;
      resolvedContents = result.contents;
    } catch (cause) {
      resolutionFailure = cause;
    }
    try {
      await closeSampleContentResolver(session, resolutionFailure);
    } catch (cause) {
      const contentError = cause instanceof SampleContentResolutionError ? cause : undefined;
      return fail({
        code: 'CLI_INPUT_RESOLUTION_FAILED',
        fieldPath: 'samples.externalContent',
        ...(contentError?.sourceLabel === undefined ? {} : { sourcePath: contentError.sourceLabel }),
        message: contentError?.sampleIds === undefined
          ? '无法解析并封存 sample 外部内容；详情已保留在受控 cause 中。'
          : `无法解析 sample 外部内容（samples：${contentError.sampleIds.join('、')}）；不会退回原始 URL 继续测量。`,
        cause,
      });
    }
  }
  return { resolvedSamples, resolvedContents };
}
