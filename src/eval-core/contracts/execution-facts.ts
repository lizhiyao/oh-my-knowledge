import { z } from 'zod';
import type { ExecutionRecord } from './artifacts.js';
import {
  ContentClassificationSchema,
  IdentifierSchema,
  Sha256DigestSchema,
  type CapturedContent,
} from './common.js';
import {
  deepFreezeCanonicalJson,
  digestCanonicalJson,
} from './json.js';

export const EXECUTION_FACTS_SCHEMA_VERSION = 'omk.execution-facts/v1' as const;

const UnreportedQuantitySchema = z.object({
  reportingStatus: z.literal('unreported'),
}).strict();

const PartialQuantitySchema = z.object({
  reportingStatus: z.literal('partial'),
  value: z.number().nonnegative(),
  reportedAttemptCount: z.number().int().positive(),
}).strict();

const ReportedQuantitySchema = z.object({
  reportingStatus: z.literal('reported'),
  value: z.number().nonnegative(),
}).strict();

const SingleQuantitySchema = z.discriminatedUnion('reportingStatus', [
  UnreportedQuantitySchema,
  ReportedQuantitySchema,
]);

export const ExecutionQuantityFactSchema = z.discriminatedUnion('reportingStatus', [
  UnreportedQuantitySchema,
  PartialQuantitySchema,
  ReportedQuantitySchema,
]);

const ProviderCostFactSchema = z.discriminatedUnion('reportingStatus', [
  UnreportedQuantitySchema,
  z.object({
    reportingStatus: z.literal('partial'),
    reportedAttemptCount: z.number().int().positive(),
  }).strict(),
  z.object({
    reportingStatus: z.literal('mixed-currency'),
    currencies: z.array(z.string().regex(/^[A-Z]{3}$/)).min(2),
  }).strict(),
  z.object({
    reportingStatus: z.literal('reported'),
    amount: z.number().nonnegative(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    reportedByProvider: z.literal(true),
  }).strict(),
]);

const ContentCaptureFactSchema = z.discriminatedUnion('captureStatus', [
  z.object({ captureStatus: z.literal('absent') }).strict(),
  z.object({
    captureStatus: z.enum(['inline', 'descriptor', 'digest-only']),
    classification: ContentClassificationSchema,
  }).strict(),
]);

const ExecutionAttemptFactSchema = z.object({
  attemptNumber: z.number().int().positive(),
  attemptStatus: z.enum(['completed', 'failed', 'cancelled']),
  activeDurationMs: SingleQuantitySchema,
  usageReportingStatus: z.enum(['unreported', 'reported']),
  providerCostReportingStatus: z.enum(['unreported', 'reported']),
}).strict();

export const ExecutionFactsSchema = z.object({
  schemaVersion: z.literal(EXECUTION_FACTS_SCHEMA_VERSION),
  sourceRecordDigest: Sha256DigestSchema,
  coordinate: z.object({
    trialIndex: z.number().int().nonnegative(),
  }).strict(),
  terminal: z.object({
    executionStatus: z.enum(['completed', 'failed', 'cancelled', 'budget-censored']),
    censorReasonCode: IdentifierSchema.optional(),
  }).strict(),
  attemptCount: z.number().int().nonnegative(),
  retryCount: z.number().int().nonnegative(),
  attempts: z.array(ExecutionAttemptFactSchema),
  timing: z.object({
    activeDurationMs: ExecutionQuantityFactSchema,
    wallClockDurationMs: SingleQuantitySchema,
  }).strict(),
  usage: z.object({
    usageRecordStatus: z.enum(['absent', 'partial', 'complete']),
    inputTokens: ExecutionQuantityFactSchema,
    outputTokens: ExecutionQuantityFactSchema,
    totalTokens: ExecutionQuantityFactSchema,
    providerCost: ProviderCostFactSchema,
  }).strict(),
  cacheStatus: z.enum(['not-applicable', 'not-used', 'miss', 'replay', 'transparent-hit']),
  content: z.object({
    output: ContentCaptureFactSchema,
    trace: ContentCaptureFactSchema,
  }).strict(),
  sourceProvenance: z.object({
    provenanceKind: z.enum(['native', 'imported', 'replay', 'derived']),
    effectiveTrust: z.enum(['verified', 'declared', 'untrusted', 'unknown']),
  }).strict(),
}).strict().superRefine((facts, context) => {
  if ((facts.terminal.executionStatus === 'budget-censored')
      !== (facts.terminal.censorReasonCode !== undefined)) {
    context.addIssue({
      code: 'custom',
      path: ['terminal', 'censorReasonCode'],
      message: 'Only budget-censored execution facts carry a censor reason code.',
    });
  }
  if (facts.retryCount !== Math.max(0, facts.attemptCount - 1)
      || facts.attempts.length !== facts.attemptCount) {
    context.addIssue({
      code: 'custom',
      path: ['retryCount'],
      message: 'Execution fact attempt and retry counts must match the attempt list.',
    });
  }
  if (facts.terminal.executionStatus !== 'budget-censored' && facts.attemptCount === 0) {
    context.addIssue({
      code: 'custom',
      path: ['attemptCount'],
      message: 'An active execution must contain at least one attempt fact.',
    });
  }
  for (const [index, attempt] of facts.attempts.entries()) {
    if (attempt.attemptNumber === index + 1) continue;
    context.addIssue({
      code: 'custom',
      path: ['attempts', index, 'attemptNumber'],
      message: 'Execution attempt facts must use contiguous one-based numbering.',
    });
  }
  for (const [index, attempt] of facts.attempts.slice(0, -1).entries()) {
    if (attempt.attemptStatus === 'failed') continue;
    context.addIssue({
      code: 'custom',
      path: ['attempts', index, 'attemptStatus'],
      message: 'Only a failed execution attempt may precede another attempt.',
    });
  }
  for (const [index, attempt] of facts.attempts.entries()) {
    if (attempt.providerCostReportingStatus !== 'reported'
        || attempt.usageReportingStatus === 'reported') continue;
    context.addIssue({
      code: 'custom',
      path: ['attempts', index, 'providerCostReportingStatus'],
      message: 'Provider cost cannot be reported when the attempt usage record is unreported.',
    });
  }
  const lastAttempt = facts.attempts.at(-1);
  if (lastAttempt !== undefined
      && lastAttempt.attemptStatus !== facts.terminal.executionStatus) {
    context.addIssue({
      code: 'custom',
      path: ['terminal', 'executionStatus'],
      message: 'The terminal execution status must match the final attempt status.',
    });
  }
  const usageAttemptCount = facts.attempts.filter(
    (attempt) => attempt.usageReportingStatus === 'reported',
  ).length;
  const expectedUsageStatus = usageAttemptCount === 0
    ? 'absent'
    : usageAttemptCount === facts.attemptCount ? 'complete' : 'partial';
  if (facts.usage.usageRecordStatus !== expectedUsageStatus) {
    context.addIssue({
      code: 'custom',
      path: ['usage', 'usageRecordStatus'],
      message: 'Usage record status must match the per-attempt reporting facts.',
    });
  }
  const providerCostAttemptCount = facts.attempts.filter(
    (attempt) => attempt.providerCostReportingStatus === 'reported',
  ).length;
  const providerCostStatus = facts.usage.providerCost.reportingStatus;
  const providerCostCountValid = providerCostStatus === 'unreported'
    ? providerCostAttemptCount === 0
    : providerCostStatus === 'partial'
      ? providerCostAttemptCount > 0
        && providerCostAttemptCount < facts.attemptCount
        && facts.usage.providerCost.reportedAttemptCount === providerCostAttemptCount
      : providerCostAttemptCount === facts.attemptCount;
  if (!providerCostCountValid) {
    context.addIssue({
      code: 'custom',
      path: ['usage', 'providerCost'],
      message: 'Provider-cost aggregation must match the per-attempt reporting facts.',
    });
  }
  if (providerCostStatus === 'mixed-currency') {
    const { currencies } = facts.usage.providerCost;
    const canonicalCurrencies = [...new Set(currencies)].sort();
    if (canonicalCurrencies.length !== currencies.length
        || canonicalCurrencies.some((currency, index) => (
          currency !== currencies[index]
        ))) {
      context.addIssue({
        code: 'custom',
        path: ['usage', 'providerCost', 'currencies'],
        message: 'Mixed provider-cost currencies must be unique and canonically sorted.',
      });
    }
  }
  const validateAggregateCount = (
    quantityFact: Quantity,
    path: (string | number)[],
  ) => {
    if (quantityFact.reportingStatus !== 'partial') return;
    if (quantityFact.reportedAttemptCount < facts.attemptCount) return;
    context.addIssue({
      code: 'custom',
      path,
      message: 'A partial quantity must cover fewer than all execution attempts.',
    });
  };
  validateAggregateCount(facts.timing.activeDurationMs, ['timing', 'activeDurationMs']);
  validateAggregateCount(facts.usage.inputTokens, ['usage', 'inputTokens']);
  validateAggregateCount(facts.usage.outputTokens, ['usage', 'outputTokens']);
  validateAggregateCount(facts.usage.totalTokens, ['usage', 'totalTokens']);
}).meta({
  title: 'OMK Execution Facts v1',
});

export type ExecutionFacts = z.infer<typeof ExecutionFactsSchema>;

type Quantity = z.infer<typeof ExecutionQuantityFactSchema>;

function quantity(
  values: readonly (number | undefined)[],
): Quantity {
  const reported = values.filter((value): value is number => value !== undefined);
  if (reported.length === 0) return { reportingStatus: 'unreported' };
  const value = reported.reduce((sum, candidate) => sum + candidate, 0);
  return reported.length === values.length
    ? { reportingStatus: 'reported', value }
    : { reportingStatus: 'partial', value, reportedAttemptCount: reported.length };
}

function singleQuantity(value: number | undefined): z.infer<typeof SingleQuantitySchema> {
  return value === undefined
    ? { reportingStatus: 'unreported' }
    : { reportingStatus: 'reported', value };
}

function providerCost(
  attempts: readonly Exclude<ExecutionRecord, { executionStatus: 'budget-censored' }>['attempts'][number][],
): z.infer<typeof ProviderCostFactSchema> {
  const values = attempts.map((attempt) => attempt.usage?.providerCost);
  const reported = values.filter(
    (value): value is NonNullable<(typeof values)[number]> => value !== undefined,
  );
  if (reported.length === 0) return { reportingStatus: 'unreported' };
  if (reported.length !== values.length) {
    return { reportingStatus: 'partial', reportedAttemptCount: reported.length };
  }
  const currencies = [...new Set(reported.map((value) => value.currency))].sort();
  if (currencies.length !== 1) return { reportingStatus: 'mixed-currency', currencies };
  return {
    reportingStatus: 'reported',
    amount: reported.reduce((sum, value) => sum + value.amount, 0),
    currency: currencies[0],
    reportedByProvider: true,
  };
}

function contentFact(
  content: CapturedContent | undefined,
): z.infer<typeof ContentCaptureFactSchema> {
  return content === undefined
    ? { captureStatus: 'absent' }
    : { captureStatus: content.contentKind, classification: content.classification };
}

const CLASSIFICATION_LEVEL = { public: 0, sensitive: 1, secret: 2, gold: 3 } as const;
const TRUST_LEVEL = { untrusted: 0, unknown: 1, declared: 2, verified: 3 } as const;

type SourceTrust = keyof typeof TRUST_LEVEL;

function factsClassification(
  record: ExecutionRecord,
): 'public' | 'sensitive' | 'secret' | 'gold' {
  const captured = record.executionStatus === 'budget-censored'
    ? []
    : [record.executionStatus === 'completed' ? record.output : undefined, record.trace]
      .filter((value): value is CapturedContent => value !== undefined);
  return captured.reduce<'public' | 'sensitive' | 'secret' | 'gold'>((highest, value) => (
    CLASSIFICATION_LEVEL[value.classification] > CLASSIFICATION_LEVEL[highest]
      ? value.classification
      : highest
  ), 'public');
}

export interface ProjectedExecutionFacts {
  readonly value: ExecutionFacts;
  readonly classification: 'public' | 'sensitive' | 'secret' | 'gold';
  readonly mediaType: 'application/vnd.omk.execution-facts+json';
}

/** Projects safe execution facts using trust established by the authenticated source boundary. */
export function projectExecutionFacts(
  record: ExecutionRecord,
  effectiveTrust: SourceTrust,
): ProjectedExecutionFacts {
  if (TRUST_LEVEL[effectiveTrust] > TRUST_LEVEL[record.provenance.trust]) {
    throw new TypeError('Effective execution-facts trust exceeds its source record trust.');
  }
  const sourceRecordDigest = digestCanonicalJson(record);
  if (record.executionStatus === 'budget-censored') {
    const value = ExecutionFactsSchema.parse({
      schemaVersion: EXECUTION_FACTS_SCHEMA_VERSION,
      sourceRecordDigest,
      coordinate: { trialIndex: record.trialIndex },
      terminal: {
        executionStatus: record.executionStatus,
        censorReasonCode: record.censorReasonCode,
      },
      attemptCount: 0,
      retryCount: 0,
      attempts: [],
      timing: {
        activeDurationMs: { reportingStatus: 'unreported' },
        wallClockDurationMs: { reportingStatus: 'unreported' },
      },
      usage: {
        usageRecordStatus: 'absent',
        inputTokens: { reportingStatus: 'unreported' },
        outputTokens: { reportingStatus: 'unreported' },
        totalTokens: { reportingStatus: 'unreported' },
        providerCost: { reportingStatus: 'unreported' },
      },
      cacheStatus: 'not-applicable',
      content: {
        output: { captureStatus: 'absent' },
        trace: { captureStatus: 'absent' },
      },
      sourceProvenance: {
        provenanceKind: record.provenance.provenanceKind,
        effectiveTrust,
      },
    });
    return deepFreezeCanonicalJson({
      value,
      classification: 'public',
      mediaType: 'application/vnd.omk.execution-facts+json',
    });
  }

  const usageValues = record.attempts.map((attempt) => attempt.usage);
  const reportedUsageCount = usageValues.filter((value) => value !== undefined).length;
  const value = ExecutionFactsSchema.parse({
    schemaVersion: EXECUTION_FACTS_SCHEMA_VERSION,
    sourceRecordDigest,
    coordinate: { trialIndex: record.trialIndex },
    terminal: { executionStatus: record.executionStatus },
    attemptCount: record.attempts.length,
    retryCount: Math.max(0, record.attempts.length - 1),
    attempts: record.attempts.map((attempt) => ({
      attemptNumber: attempt.attemptNumber,
      attemptStatus: attempt.attemptStatus,
      activeDurationMs: singleQuantity(attempt.timing.durationMs),
      usageReportingStatus: attempt.usage === undefined ? 'unreported' : 'reported',
      providerCostReportingStatus: attempt.usage?.providerCost === undefined
        ? 'unreported'
        : 'reported',
    })),
    timing: {
      activeDurationMs: quantity(record.attempts.map((attempt) => attempt.timing.durationMs)),
      wallClockDurationMs: singleQuantity(record.timing.durationMs),
    },
    usage: {
      usageRecordStatus: reportedUsageCount === 0
        ? 'absent'
        : reportedUsageCount === record.attempts.length
          ? 'complete'
          : 'partial',
      inputTokens: quantity(record.attempts.map((attempt) => attempt.usage?.inputTokens)),
      outputTokens: quantity(record.attempts.map((attempt) => attempt.usage?.outputTokens)),
      totalTokens: quantity(record.attempts.map((attempt) => attempt.usage?.totalTokens)),
      providerCost: providerCost(record.attempts),
    },
    cacheStatus: record.cache.cacheStatus,
    content: {
      output: contentFact(record.executionStatus === 'completed' ? record.output : undefined),
      trace: contentFact(record.trace),
    },
    sourceProvenance: {
      provenanceKind: record.provenance.provenanceKind,
      effectiveTrust,
    },
  });
  return deepFreezeCanonicalJson({
    value,
    classification: factsClassification(record),
    mediaType: 'application/vnd.omk.execution-facts+json',
  });
}
