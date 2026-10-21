import { compareStrings } from '../../primitives/ordering.js';
import { z } from 'zod';
import { parseWireDocument, type ExtensionEntry, type Extensions } from '../../contracts/index.js';
import { EvaluationDefinitionError } from '../errors.js';
import { deepFreeze, snapshotJson } from '../immutability.js';
import { ExtensionResolutionSchema, type ExtensionImpactStage, type PreparationRuntime } from '../types.js';

interface StageExtensions {
  execution?: Extensions;
  evaluation?: Extensions;
  analysis?: Extensions;
  decision?: Extensions;
  run?: Extensions;
}

function appendExtension(
  stageExtensions: StageExtensions,
  stage: Exclude<ExtensionImpactStage, 'audit'>,
  namespace: string,
  entry: ExtensionEntry,
): void {
  const current = stageExtensions[stage] ?? {};
  stageExtensions[stage] = { ...current, [namespace]: entry };
}

export async function resolveExtensions(
  definitionExtensions: Extensions | undefined,
  policyExtensions: Extensions | undefined,
  runtime: PreparationRuntime,
): Promise<StageExtensions> {
  const requests = [
    ...Object.entries(definitionExtensions ?? {}).map(([namespace, entry]) => ({
      namespace,
      source: 'definition' as const,
      entry,
    })),
    ...Object.entries(policyExtensions ?? {}).map(([namespace, entry]) => ({
      namespace,
      source: 'measurement-policy' as const,
      entry,
    })),
  ].sort((left, right) => compareStrings(left.namespace, right.namespace)
    || compareStrings(left.source, right.source));
  const namespaces = requests.map((request) => request.namespace);
  if (new Set(namespaces).size !== namespaces.length) {
    throw new EvaluationDefinitionError({
      code: 'EVAL_DEFINITION_EXTENSION_INVALID',
      stage: 'configuration',
      preparationStage: 'extension-resolution',
      message: 'Definition 与 MeasurementPolicy 不能重复声明同一 extension namespace。',
    });
  }
  if (requests.length > 0 && runtime.validateExtension === undefined) {
    throw new EvaluationDefinitionError({
      code: 'EVAL_DEFINITION_EXTENSION_INVALID',
      stage: 'configuration',
      preparationStage: 'extension-resolution',
      message: '存在 extension，但 PreparationRuntime 未提供 extension validator。',
    });
  }

  const stageExtensions: StageExtensions = {};
  for (const request of requests) {
    let raw: unknown;
    try {
      raw = await runtime.validateExtension?.(deepFreeze(snapshotJson(request)));
    } catch {
      throw new EvaluationDefinitionError({
        code: 'EVAL_DEFINITION_EXTENSION_INVALID',
        stage: 'configuration',
        preparationStage: 'extension-resolution',
        message: 'Extension schema 校验失败。',
        details: { namespace: request.namespace, source: request.source },
      });
    }
    let resolution: z.infer<typeof ExtensionResolutionSchema>;
    try {
      resolution = parseWireDocument(ExtensionResolutionSchema, raw);
    } catch {
      throw new EvaluationDefinitionError({
        code: 'EVAL_DEFINITION_EXTENSION_INVALID',
        stage: 'configuration',
        preparationStage: 'extension-resolution',
        message: 'Extension validator 未返回明确的阶段影响。',
        details: { namespace: request.namespace, source: request.source },
      });
    }
    if (resolution.impactStage !== 'audit') {
      appendExtension(
        stageExtensions,
        resolution.impactStage,
        request.namespace,
        request.entry,
      );
    }
  }
  return stageExtensions;
}
