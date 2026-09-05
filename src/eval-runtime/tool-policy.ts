import {
  NonEmptyStringSchema,
  canonicalizeJson,
  deepFreezeCanonicalJson,
} from '../eval-core/contracts/index.js';

export interface AllowedToolsPlan {
  readonly default?: readonly string[];
  /** `null` explicitly restores the Executor runtime default for one sample. */
  readonly bySampleId?: Readonly<Record<string, readonly string[] | null>>;
}

/** A direct list applies to every sample; a plan may select an exact list per sample. */
export type AllowedToolsInput = readonly string[] | AllowedToolsPlan;

export interface CapturedAllowedToolsPlan {
  readonly default?: readonly string[];
  readonly bySampleId: Readonly<Record<string, readonly string[] | null>>;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function captureAllowedTools(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    throw new TypeError('Allowed tools must be an array.');
  }
  const tools = value.map((tool) => NonEmptyStringSchema.parse(tool));
  if (new Set(tools).size !== tools.length) {
    throw new TypeError('Allowed tools must be unique.');
  }
  return Object.freeze([...tools].sort(compareStrings));
}

function sameTools(left: readonly string[] | undefined, right: readonly string[]): boolean {
  return left !== undefined && canonicalizeJson(left) === canonicalizeJson(right);
}

export function captureAllowedToolsPlan(
  value: unknown,
  sampleIds: ReadonlySet<string>,
): CapturedAllowedToolsPlan | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    return Object.freeze({
      default: captureAllowedTools(value),
      bySampleId: Object.freeze({}),
    });
  }
  if (value === null || typeof value !== 'object') {
    throw new TypeError('Allowed-tools plan must be an array or object.');
  }
  const plan = value as Readonly<AllowedToolsPlan>;
  if (Object.keys(plan).some((key) => key !== 'default' && key !== 'bySampleId')) {
    throw new TypeError('Allowed-tools plan contains unsupported fields.');
  }
  const defaultTools = plan.default === undefined
    ? undefined
    : captureAllowedTools(plan.default);
  if (plan.bySampleId !== undefined
      && (plan.bySampleId === null || typeof plan.bySampleId !== 'object'
        || Array.isArray(plan.bySampleId))) {
    throw new TypeError('Allowed-tools sample overrides must be an object.');
  }
  const sampleOverrides: Array<readonly [string, readonly string[] | null]> = [];
  for (const [sampleId, tools] of Object.entries(plan.bySampleId ?? {})
    .sort(([left], [right]) => compareStrings(left, right))) {
    if (!sampleIds.has(sampleId)) {
      throw new TypeError('Allowed-tools plan references an unknown sample.');
    }
    if (tools === null) {
      if (defaultTools !== undefined) sampleOverrides.push([sampleId, null]);
      continue;
    }
    const capturedTools = captureAllowedTools(tools);
    if (!sameTools(defaultTools, capturedTools)) {
      sampleOverrides.push([sampleId, capturedTools]);
    }
  }
  const bySampleId = Object.fromEntries(sampleOverrides) as Record<
    string,
    readonly string[] | null
  >;
  const hasAllowList = [...sampleIds].some((sampleId) => (
    Object.prototype.hasOwnProperty.call(bySampleId, sampleId)
      ? bySampleId[sampleId] !== null
      : defaultTools !== undefined
  ));
  if (!hasAllowList) {
    throw new TypeError('Allowed-tools plan must select a list for at least one sample.');
  }
  return Object.freeze({
    ...(defaultTools === undefined ? {} : { default: defaultTools }),
    bySampleId: deepFreezeCanonicalJson(bySampleId),
  });
}
