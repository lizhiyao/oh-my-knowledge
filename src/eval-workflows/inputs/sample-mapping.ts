import type { AuthoredSample, Sample } from './contracts/sample.js';

/** Pure boundary mapping between the public envelope and the resolved workflow DTO. */
export function normalizeAuthoredSample(sample: AuthoredSample): Sample {
  const { data, ...controls } = sample.executionContext ?? {};
  return {
    sample_id: sample.sampleId,
    input: structuredClone(sample.input),
    ...structuredClone(controls),
    ...structuredClone(sample.evaluationContext ?? {}),
    ...structuredClone(sample.annotations ?? {}),
    ...(sample.expected === undefined ? {} : { expected: structuredClone(sample.expected) }),
    ...(data === undefined ? {} : { executionData: structuredClone(data) }),
  };
}

export function authorSample(sample: Sample): AuthoredSample {
  const { sample_id, input, expected, executionData, cwd, allowedTools, mocks, mocksStrict,
    environment, rubric, assertions, reference, checks, ...annotations } = structuredClone(sample);
  const defined = <T extends Record<string, unknown>>(value: T) =>
    Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
  const executionContext = defined({ data: executionData, cwd, allowedTools, mocks, mocksStrict, environment });
  const evaluationContext = defined({ rubric, assertions, reference, checks });
  return {
    sampleId: sample_id, input,
    ...(expected === undefined ? {} : { expected }),
    ...(Object.keys(executionContext).length ? { executionContext } : {}),
    ...(Object.keys(evaluationContext).length ? { evaluationContext } : {}),
    ...(Object.keys(annotations).length ? { annotations } : {}),
  };
}
