import type {
  ContentDescriptor as CoreContentDescriptor,
  JsonValue,
} from '../eval-core/contracts/index.js';
import type { ExecutionContentStoreRequest } from '../eval-core/execution/index.js';
import type {
  EvaluationContent,
  EvaluationContentResolver,
} from '../eval-core/evaluation/index.js';
import type { EvaluationRuntimeSupportPorts } from './runtime.js';

export type ContentDescriptor = CoreContentDescriptor;
export type ContentValue = EvaluationContent;
export type ContentStoreRequest = ExecutionContentStoreRequest;

export interface ContentStore {
  /** Optional descriptor URIs are persisted; return only stable, opaque, credential-free locators. */
  put(request: Readonly<ContentStoreRequest>): Promise<ContentDescriptor>;
}

export interface ContentResolver {
  resolve(descriptor: Readonly<ContentDescriptor>): Promise<ContentValue>;
}

/** Host-owned ports. Implementations and credentials remain outside the sealed Definition. */
export interface EvaluationInfrastructure {
  /** One content-addressed store serves output, trace, and Evaluator evidence. */
  readonly contentStore?: ContentStore;
  /** Resolves reference-captured content for downstream Evaluators. */
  readonly contentResolver?: ContentResolver;
}

function bindMethod<Arguments extends readonly unknown[], Result>(
  owner: object,
  method: (...arguments_: Arguments) => Result,
  label: string,
): (...arguments_: Arguments) => Result {
  if (typeof method !== 'function') {
    throw new TypeError(`${label} must be a function.`);
  }
  return (...arguments_) => Reflect.apply(method, owner, arguments_) as Result;
}

export function captureEvaluationInfrastructure(
  value: unknown,
): EvaluationRuntimeSupportPorts | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Evaluation infrastructure must be an object.');
  }
  const input = value as Readonly<EvaluationInfrastructure>;
  if (Object.keys(input).some((key) => ![
    'contentStore',
    'contentResolver',
  ].includes(key))) {
    throw new TypeError('Evaluation infrastructure contains unsupported fields.');
  }
  const declaredContentStore = input.contentStore;
  const declaredContentResolver = input.contentResolver;
  const contentStore = declaredContentStore === undefined
    ? undefined
    : Object.freeze({
        put: bindMethod(declaredContentStore, declaredContentStore.put, 'ContentStore.put'),
      });
  const contentResolver = declaredContentResolver === undefined
    ? undefined
    : Object.freeze({
        resolve: bindMethod<
          readonly [Readonly<ContentDescriptor>],
          Promise<{ value: JsonValue; classification: ContentValue['classification']; mediaType?: string }>
        >(
          declaredContentResolver,
          declaredContentResolver.resolve,
          'ContentResolver.resolve',
        ),
      }) as EvaluationContentResolver;
  return Object.freeze({
    ...(contentStore === undefined ? {} : {
      executionContentStore: contentStore,
      evaluationContentStore: contentStore,
    }),
    ...(contentResolver === undefined ? {} : { contentResolver }),
  });
}
