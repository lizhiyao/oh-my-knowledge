import { dirname, isAbsolute } from 'node:path';
import { normalizeRfc3339Timestamp } from '../shared/timestamp.js';
import { checkedSumTokenCounts } from '../shared/token-usage.js';
import {
  isValidMockStats,
  isValidToolCallInfo,
  isValidTurnInfo,
} from '../shared/executor-result.js';
import {
  evaluationRequestsEqual,
  isValidEvaluationJob,
  isValidEvaluationRequest,
  isValidEvaluationRun,
} from '../shared/evaluation-job.js';
import {
  isToolCallCancelled,
  isToolCallFailure,
  isToolCallSuccess,
  isToolCallUnknown,
} from '../shared/tool-call-status.js';
import { incrementRecordCount } from '../shared/record-count.js';
import {
  isAnalysisResult,
  isSampleSnapshotRecord,
  isVarianceData,
} from './report-extensions.js';
import type {
  BatchEvaluationItem,
  BatchEvaluationMeta,
  ExecutorRuntimeFingerprint,
  ReportDocument,
  ReportIndexCard,
  ReportMeta,
  VariantResult,
  VariantSummary,
} from '../types/index.js';
import { reportFilePath, safeArtifactFileStem } from './artifact-file-names.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= 0
    && value <= Number.MAX_SAFE_INTEGER;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

function isRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isScore(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 5;
}

function isCorrelation(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -1 && value <= 1;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((entry) => typeof entry === 'string' && entry.length > 0);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value)
    && Object.values(value).every((entry) => typeof entry === 'string');
}

function isSampleHashRecord(value: unknown): value is Record<string, string> {
  return isRecord(value)
    && Object.keys(value).every((key) => key.length > 0)
    && Object.values(value).every(
      (entry) => typeof entry === 'string' && /^[a-f0-9]{12}$/.test(entry),
    );
}

function isRuntimePackage(value: unknown): boolean {
  return isRecord(value)
    && typeof value.name === 'string'
    && value.name.length > 0
    && (value.version === undefined || typeof value.version === 'string')
    && (value.error === undefined || typeof value.error === 'string');
}

function isRuntimeFingerprint(value: unknown): value is ExecutorRuntimeFingerprint {
  if (
    !isRecord(value)
    || typeof value.executor !== 'string'
    || value.executor.length === 0
    || typeof value.model !== 'string'
    || value.model.length === 0
    || !['agent-cli', 'agent-sdk', 'api', 'script', 'unknown'].includes(
      String(value.runtimeKind),
    )
    || typeof value.fingerprint !== 'string'
    || value.fingerprint.length === 0
    || !isRecord(value.capabilities)
    || !['native', 'prepended', 'none', 'unknown'].includes(
      String(value.capabilities.systemPrompt),
    )
    || !['reported', 'not-reported', 'unknown'].includes(
      String(value.capabilities.costUSD),
    )
    || !['native', 'best-effort', 'none', 'unknown'].includes(
      String(value.capabilities.trace),
    )
    || !['full', 'full-no-partial', 'cwd-only', 'none', 'unknown'].includes(
      String(value.capabilities.skillIsolation),
    )
    || (value.sdk !== undefined && !isRuntimePackage(value.sdk))
  ) return false;
  if (value.binary === undefined) return true;
  return isRecord(value.binary)
    && typeof value.binary.name === 'string'
    && value.binary.name.length > 0
    && ['path', 'bundled', 'none', 'unknown'].includes(String(value.binary.source))
    && (value.binary.version === undefined || typeof value.binary.version === 'string')
    && (value.binary.path === undefined || typeof value.binary.path === 'string')
    && (
      value.binary.contentHash === undefined
      || (
        typeof value.binary.contentHash === 'string'
        && /^[a-f0-9]{64}$/.test(value.binary.contentHash)
      )
    )
    && (value.binary.package === undefined || isRuntimePackage(value.binary.package))
    && (value.binary.error === undefined || typeof value.binary.error === 'string');
}

function isDiagnosticConfig(value: unknown): boolean {
  if (!isRecord(value) || typeof value.enabled !== 'boolean') return false;
  if (!value.enabled) {
    return value.executor === undefined
      && value.model === undefined
      && value.runtime === undefined
      && value.promptHash === undefined;
  }
  return typeof value.executor === 'string'
    && value.executor.length > 0
    && typeof value.model === 'string'
    && value.model.length > 0
    && isRuntimeFingerprint(value.runtime)
    && value.runtime.executor === value.executor
    && value.runtime.model === value.model
    && typeof value.promptHash === 'string'
    && /^[a-f0-9]{12}$/.test(value.promptHash);
}

function isOptionalNonNegativeInteger(value: unknown): boolean {
  return value === undefined || isNonNegativeInteger(value);
}

function isOptionalStringArray(value: unknown): value is string[] | undefined {
  return value === undefined
    || (
      Array.isArray(value)
      && value.every((entry) => typeof entry === 'string' && entry.length > 0)
    );
}

function isCountRecord(value: unknown): value is Record<string, number> {
  return isRecord(value)
    && Object.keys(value).every((key) => key.length > 0)
    && Object.values(value).every(isNonNegativeInteger);
}

function traceProjectionIsConsistent(value: Record<string, unknown>): boolean {
  for (const field of [
    'fullNumTurns',
    'numSubAgents',
    'assistantTurns',
    'toolTurns',
    'numToolCalls',
    'numToolFailures',
    'numToolCancelled',
    'numToolUnknown',
  ] as const) {
    if (!isOptionalNonNegativeInteger(value[field])) return false;
  }
  if (
    (value.toolSuccessRate !== undefined && !isRate(value.toolSuccessRate))
    || (value.traceCoverage !== undefined && !isRate(value.traceCoverage))
    || !isOptionalStringArray(value.toolNames)
    || (value.toolDistribution !== undefined && !isCountRecord(value.toolDistribution))
    || (value.turns !== undefined && (
      !Array.isArray(value.turns)
      || !value.turns.every(isValidTurnInfo)
    ))
    || (value.toolCalls !== undefined && (
      !Array.isArray(value.toolCalls)
      || !value.toolCalls.every(isValidToolCallInfo)
    ))
    || (value.mockStats !== undefined && !isValidMockStats(value.mockStats))
  ) return false;

  if (Array.isArray(value.turns)) {
    const assistantTurns = value.turns.filter((turn) =>
      isRecord(turn) && turn.role === 'assistant'
    ).length;
    const toolTurns = value.turns.filter((turn) =>
      isRecord(turn) && turn.role === 'tool'
    ).length;
    if (
      (value.assistantTurns !== undefined && value.assistantTurns !== assistantTurns)
      || (value.toolTurns !== undefined && value.toolTurns !== toolTurns)
    ) return false;
  }

  if (!Array.isArray(value.toolCalls)) {
    return true;
  }
  const toolCalls = value.toolCalls;
  if (value.numToolCalls !== undefined && value.numToolCalls !== toolCalls.length) return false;
  const failures = toolCalls.filter(isToolCallFailure).length;
  const cancelled = toolCalls.filter(isToolCallCancelled).length;
  const unknown = toolCalls.filter(isToolCallUnknown).length;
  const successes = toolCalls.filter(isToolCallSuccess).length;
  if (
    (value.numToolFailures !== undefined && value.numToolFailures !== failures)
    || (value.numToolCancelled !== undefined && value.numToolCancelled !== cancelled)
    || (value.numToolUnknown !== undefined && value.numToolUnknown !== unknown)
  ) return false;
  const comparable = successes + failures;
  const expectedRate = comparable > 0
    ? Number((successes / comparable).toFixed(2))
    : undefined;
  if (value.toolSuccessRate !== undefined && value.toolSuccessRate !== expectedRate) return false;

  const expectedNames = [...new Set(toolCalls.map((call) => call.tool))];
  if (value.toolNames !== undefined) {
    const toolNames = value.toolNames as string[];
    if (
      toolNames.length !== expectedNames.length
      || !expectedNames.every((name) => toolNames.includes(name))
    ) return false;
  }
  if (value.toolDistribution === undefined) return true;
  if (!isCountRecord(value.toolDistribution)) return false;
  const toolDistribution = value.toolDistribution;
  const expectedDistribution: Record<string, number> = Object.create(null);
  for (const call of toolCalls) {
    incrementRecordCount(expectedDistribution, call.tool);
  }
  return hasExactKeys(toolDistribution, Object.keys(expectedDistribution))
    && Object.entries(expectedDistribution).every(
      ([name, count]) => toolDistribution[name] === count,
    );
}

function isJudgeModels(value: unknown): boolean {
  return Array.isArray(value)
    && value.length > 0
    && value.every((entry) =>
      isRecord(entry)
      && typeof entry.executor === 'string'
      && entry.executor.length > 0
      && typeof entry.model === 'string'
      && entry.model.length > 0
      && (
        entry.runtime === undefined
        || (
          isRuntimeFingerprint(entry.runtime)
          && entry.runtime.executor === entry.executor
          && entry.runtime.model === entry.model
        )
      )
    );
}

function isSummaryJudgeModels(value: unknown): boolean {
  return Array.isArray(value)
    && value.length > 0
    && value.every((entry) =>
      isRecord(entry)
      && typeof entry.executor === 'string'
      && typeof entry.model === 'string'
      && entry.model.length > 0
    );
}

function isBaseJudgeAgreement(value: unknown): boolean {
  return isRecord(value)
    && (value.pearson === undefined || isCorrelation(value.pearson))
    && isNonNegativeNumber(value.meanAbsDiff)
    && value.meanAbsDiff <= 4
    && isNonNegativeInteger(value.pairCount);
}

function isSummaryJudgeAgreement(value: unknown): boolean {
  return isBaseJudgeAgreement(value)
    && isRecord(value)
    && isNonNegativeInteger(value.sampleCount);
}

function isBootstrapCI(value: unknown): boolean {
  return isRecord(value)
    && isScore(value.low)
    && isScore(value.high)
    && isScore(value.estimate)
    && value.low <= value.estimate
    && value.estimate <= value.high
    && isNonNegativeInteger(value.samples)
    && value.samples > 0;
}

function isDiffBootstrapCI(value: unknown): boolean {
  if (
    !isRecord(value)
    || !isFiniteNumber(value.low)
    || !isFiniteNumber(value.high)
    || !isFiniteNumber(value.estimate)
    || value.low > value.estimate
    || value.estimate > value.high
    || !isNonNegativeInteger(value.samples)
    || value.samples <= 0
    || typeof value.significant !== 'boolean'
  ) return false;
  return value.significant === (value.low > 0 || value.high < 0);
}

function isPairComparisons(value: unknown, variants: string[]): boolean {
  if (!Array.isArray(value)) return false;
  const pairs = new Set<string>();
  return value.every((entry) => {
    if (
      !isRecord(entry)
      || typeof entry.control !== 'string'
      || typeof entry.treatment !== 'string'
      || entry.control === entry.treatment
      || !variants.includes(entry.control)
      || !variants.includes(entry.treatment)
      || (
        entry.diffBootstrapCI !== undefined
        && !isDiffBootstrapCI(entry.diffBootstrapCI)
      )
      || (
        entry.alpha !== undefined
        && (!isRate(entry.alpha) || entry.alpha <= 0)
      )
    ) return false;
    const key = `${entry.control}\u0000${entry.treatment}`;
    if (pairs.has(key)) return false;
    pairs.add(key);
    return true;
  });
}

function isBudget(value: unknown): boolean {
  return isRecord(value)
    && ['totalUSD', 'perSampleUSD', 'perSampleMs'].every(
      (field) => value[field] === undefined || isNonNegativeNumber(value[field]),
    );
}

function isHumanAgreement(value: unknown, variants: string[]): boolean {
  if (
    !isRecord(value)
    || !isFiniteNumber(value.alpha)
    || value.alpha > 1
    || !isRecord(value.alphaCI)
    || !isFiniteNumber(value.alphaCI.low)
    || !isFiniteNumber(value.alphaCI.high)
    || !isFiniteNumber(value.alphaCI.estimate)
    || value.alphaCI.low > value.alphaCI.estimate
    || value.alphaCI.estimate > value.alphaCI.high
    || !isNonNegativeInteger(value.alphaCI.samples)
    || value.alphaCI.samples <= 0
    || !isCorrelation(value.weightedKappa)
    || !isCorrelation(value.pearson)
    || !isNonNegativeInteger(value.sampleCount)
    || typeof value.variant !== 'string'
    || !variants.includes(value.variant)
    || typeof value.goldAnnotator !== 'string'
    || typeof value.goldVersion !== 'string'
    || (value.contaminationWarning !== undefined && typeof value.contaminationWarning !== 'string')
    || !isNonNegativeInteger(value.missingCount)
    || !isNonNegativeInteger(value.unscoredCount)
  ) return false;
  return Math.abs(value.alpha - value.alphaCI.estimate) <= 1e-9;
}

function isSkillIsolation(value: unknown, variants: string[]): boolean {
  return isRecord(value)
    && hasExactKeys(value, variants)
    && Object.values(value).every((entry) =>
      entry === null
      || (
        Array.isArray(entry)
        && entry.every((skill) => typeof skill === 'string' && skill.length > 0)
      )
    );
}

function isGitInfo(value: unknown): boolean {
  return isRecord(value)
    && typeof value.commit === 'string'
    && typeof value.commitShort === 'string'
    && typeof value.branch === 'string'
    && typeof value.dirty === 'boolean';
}

function isVariantConfigs(
  value: unknown,
  variants: string[],
  skillIsolation: unknown,
  request: unknown,
): boolean {
  if (!Array.isArray(value) || value.length !== variants.length) return false;
  const configs = new Map<string, Record<string, unknown>>();
  for (const entry of value) {
    if (
      !isRecord(entry)
      || typeof entry.variant !== 'string'
      || !variants.includes(entry.variant)
      || configs.has(entry.variant)
      || !['baseline', 'skill', 'prompt', 'agent', 'workflow'].includes(
        String(entry.artifactKind),
      )
      || ![
        'baseline',
        'variant-name',
        'file-path',
        'git',
        'inline',
        'custom',
      ].includes(String(entry.artifactSource))
      || ![
        'baseline',
        'system-prompt',
        'user-prompt',
        'agent-session',
        'workflow-session',
      ].includes(String(entry.executionStrategy))
      || ![
        'baseline',
        'runtime-context-only',
        'artifact-injection',
      ].includes(String(entry.experimentType))
      || (entry.experimentRole !== 'control' && entry.experimentRole !== 'treatment')
      || typeof entry.hasArtifactContent !== 'boolean'
      || (entry.cwd !== null && typeof entry.cwd !== 'string')
      || (entry.locator !== undefined && typeof entry.locator !== 'string')
      || (entry.ref !== undefined && typeof entry.ref !== 'string')
      || (entry.resolvedCommit !== undefined && typeof entry.resolvedCommit !== 'string')
      || (
        entry.allowedSkills !== undefined
        && (
          !Array.isArray(entry.allowedSkills)
          || !entry.allowedSkills.every(
            (skill) => typeof skill === 'string' && skill.length > 0,
          )
          || new Set(entry.allowedSkills).size !== entry.allowedSkills.length
        )
      )
    ) return false;
    configs.set(entry.variant, entry);
  }
  if (!variants.every((variant) => configs.has(variant))) return false;
  if (isRecord(skillIsolation)) {
    for (const variant of variants) {
      const configured = configs.get(variant)?.allowedSkills;
      const isolated = skillIsolation[variant];
      if (
        isolated === null
          ? configured !== undefined
          : JSON.stringify(configured) !== JSON.stringify(isolated)
      ) return false;
    }
  }
  if (isValidEvaluationRequest(request)) {
    for (const artifact of request.artifacts) {
      const configured = configs.get(artifact.name);
      if (
        !configured
        || configured.artifactKind !== artifact.kind
        || configured.artifactSource !== artifact.source
      ) return false;
    }
  }
  return true;
}

function judgeConfigsMatch(
  request: { judgeModels: Array<{ executor: string; model: string }> },
  judgeModels: Array<{ executor: string; model: string }>,
): boolean {
  return request.judgeModels.length === judgeModels.length
    && request.judgeModels.every((judge, index) =>
      judge.executor === judgeModels[index]?.executor
      && judge.model === judgeModels[index]?.model
    );
}

function embeddedLifecycleIsValid(
  value: Record<string, unknown>,
  expectedReportId?: string,
  requireBatch = false,
): boolean {
  const request = value.request;
  const run = value.run;
  const job = value.job;
  if (
    (request !== undefined && !isValidEvaluationRequest(request))
    || (run !== undefined && !isValidEvaluationRun(run, expectedReportId))
    || (job !== undefined && !isValidEvaluationJob(job))
  ) return false;

  const reportTimestamp = normalizeRfc3339Timestamp(value.timestamp);
  if (!reportTimestamp) return false;
  const reportTimestampMs = Date.parse(reportTimestamp);
  const typedRequest = request === undefined ? undefined : request;
  const typedRun = run === undefined ? undefined : run;
  const typedJob = job === undefined ? undefined : job;
  const judgeModels = value.judgeModels as Array<{ executor: string; model: string }>;

  if (
    typedRequest !== undefined
    && (
      typedRequest.model !== value.model
      || typedRequest.executor !== value.executor
      || typedRequest.noJudge !== (value.noJudge === true)
      || typedRequest.effort !== value.effort
      || !judgeConfigsMatch(typedRequest, judgeModels)
      || (requireBatch && typedRequest.batch !== true)
    )
  ) return false;
  if (
    typedRun !== undefined
    && (
      typedRun.status !== 'succeeded'
      || typedRun.finishedAt === undefined
      || Date.parse(typedRun.finishedAt) > reportTimestampMs
    )
  ) return false;
  if (
    typedJob !== undefined
    && (
      typedJob.status !== 'succeeded'
      || typedJob.runId !== expectedReportId
      || typedJob.resultReportId !== expectedReportId
      || typedJob.finishedAt === undefined
      || Date.parse(typedJob.finishedAt) > reportTimestampMs
      || typedJob.request.model !== value.model
      || typedJob.request.executor !== value.executor
      || typedJob.request.noJudge !== (value.noJudge === true)
      || typedJob.request.effort !== value.effort
      || !judgeConfigsMatch(typedJob.request, judgeModels)
      || (requireBatch && typedJob.request.batch !== true)
    )
  ) return false;
  if (
    typedRequest !== undefined
    && typedJob !== undefined
    && !evaluationRequestsEqual(typedRequest, typedJob.request)
  ) return false;
  if (
    typedRun !== undefined
    && typedJob !== undefined
    && (
      typedRun.runId !== typedJob.runId
      || typedRun.startedAt !== typedJob.startedAt
      || typedRun.finishedAt !== typedJob.finishedAt
    )
  ) return false;
  return true;
}

function isEvolveMetadata(value: unknown, variants: string[]): boolean {
  if (
    !isRecord(value)
    || typeof value.skillName !== 'string'
    || value.skillName.length === 0
    || (
      value.skillPath !== undefined
      && typeof value.skillPath !== 'string'
    )
    || (
      value.processCostUSD !== undefined
      && !isNonNegativeNumber(value.processCostUSD)
    )
    || !isOptionalBoolean(value.processCostReported)
  ) return false;
  if (value.sourceReports === undefined) return true;
  if (
    !Array.isArray(value.sourceReports)
    || value.sourceReports.length !== variants.length
  ) return false;

  const reportIds = new Set<string>();
  let previousRound = -1;
  return value.sourceReports.every((source, index) => {
    if (
      !isRecord(source)
      || !isNonNegativeInteger(source.round)
      || source.round <= previousRound
      || typeof source.accepted !== 'boolean'
      || !isCanonicalReportId(source.reportId)
      || reportIds.has(source.reportId)
      || typeof source.variant !== 'string'
      || source.variant.length === 0
      || variants[index] !== `round-${source.round}`
    ) return false;
    previousRound = source.round;
    reportIds.add(source.reportId);
    return true;
  });
}

function reportMetaExtensionsAreValid(
  value: Record<string, unknown>,
  expectedReportId?: string,
): boolean {
  const variants = value.variants as string[];
  const isCurrentSchema = typeof value.schemaVersion === 'number'
    && value.schemaVersion >= 4;
  if (
    (
      value.effort !== undefined
      && !['low', 'medium', 'high', 'xhigh', 'max'].includes(String(value.effort))
    )
    || !isOptionalNonNegativeInteger(value.schemaVersion)
    || (value.sampleHashes !== undefined && !isStringRecord(value.sampleHashes))
    || (value.judgePromptHash !== undefined && (
      typeof value.judgePromptHash !== 'string'
      || value.judgePromptHash.length === 0
    ))
    || (value.diagnostic !== undefined && !isDiagnosticConfig(value.diagnostic))
    || (
      value.executorRuntime !== undefined
      && (
        !isRuntimeFingerprint(value.executorRuntime)
        || value.executorRuntime.executor !== value.executor
        || value.executorRuntime.model !== value.model
      )
    )
    || (
      value.executorRuntimes !== undefined
      && (
        !isRecord(value.executorRuntimes)
        || !hasExactKeys(value.executorRuntimes, variants)
        || !Object.values(value.executorRuntimes).every(isRuntimeFingerprint)
        || Object.values(value.executorRuntimes).some(
          (runtime) =>
            isRecord(runtime)
            && (
              runtime.executor !== value.executor
              || runtime.model !== value.model
            ),
        )
      )
    )
    || !isOptionalNonNegativeInteger(value.judgeRepeat)
    || (value.judgeRepeat === 0)
    || !isOptionalBoolean(value.noJudge)
    || (
      value.noJudge === true
      && (value.judgeModels as Array<Record<string, unknown>>).some(
        (judge) => judge.runtime !== undefined,
      )
    )
    || (
      isCurrentSchema
      && value.noJudge !== true
      && (value.judgeModels as Array<Record<string, unknown>>).some(
        (judge) => judge.runtime === undefined,
      )
    )
    || (
      value.evaluationFramework !== undefined
      && !['t-test', 'bootstrap', 'both'].includes(String(value.evaluationFramework))
    )
    || (
      value.pairComparisons !== undefined
      && !isPairComparisons(value.pairComparisons, variants)
    )
    || (
      value.debiasMode !== undefined
      && (
        !Array.isArray(value.debiasMode)
        || new Set(value.debiasMode).size !== value.debiasMode.length
        || !value.debiasMode.every((mode) => mode === 'length' || mode === 'position')
      )
    )
    || !isOptionalBoolean(value.budgetExhausted)
    || (value.budget !== undefined && !isBudget(value.budget))
    || (
      value.humanAgreement !== undefined
      && !isHumanAgreement(value.humanAgreement, variants)
    )
    || (
      value.skillIsolation !== undefined
      && !isSkillIsolation(value.skillIsolation, variants)
    )
    || (
      value.variantConfigs !== undefined
      && !isVariantConfigs(
        value.variantConfigs,
        variants,
        value.skillIsolation,
        value.request,
      )
    )
    || (
      value.gitInfo !== undefined
      && value.gitInfo !== null
      && !isGitInfo(value.gitInfo)
    )
    || !isOptionalBoolean(value.layeredStats)
    || (
      value.evolve !== undefined
      && !isEvolveMetadata(value.evolve, variants)
    )
  ) return false;
  return embeddedLifecycleIsValid(value, expectedReportId);
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isVariantSummary(value: unknown): value is VariantSummary {
  if (!isRecord(value)) return false;
  const integerFields = ['totalSamples', 'successCount', 'errorCount'] as const;
  const numericFields = [
    'errorRate',
    'avgDurationMs',
    'avgInputTokens',
    'avgOutputTokens',
    'avgTotalTokens',
    'totalCostUSD',
    'totalExecCostUSD',
    'totalJudgeCostUSD',
    'avgCostPerSample',
    'avgNumTurns',
  ] as const;
  if (
    !integerFields.every((field) => isNonNegativeInteger(value[field]))
    || !numericFields.every((field) => isNonNegativeNumber(value[field]))
    || (value.successCount as number) + (value.errorCount as number) !== value.totalSamples
    || (value.errorRate as number) > 100
    || !isOptionalBoolean(value.execCostReported)
    || !isOptionalBoolean(value.judgeCostReported)
    || (
      value.totalDiagnosticCostUSD !== undefined
      && !isNonNegativeNumber(value.totalDiagnosticCostUSD)
    )
    || (
      value.tokenUsageCoverageRate !== undefined
      && !isRate(value.tokenUsageCoverageRate)
    )
  ) return false;
  const optionalMetrics = [
    'avgFullNumTurns',
    'avgNumSubAgents',
    'avgAssistantTurns',
    'avgToolTurns',
    'avgToolCalls',
    'avgToolFailures',
    'avgToolCancelled',
    'avgToolUnknown',
    'scoreStddev',
    'scoreCV',
  ] as const;
  const optionalScores = [
    'avgFactScore',
    'avgBehaviorScore',
    'avgJudgeScore',
    'avgCompositeScore',
    'minCompositeScore',
    'maxCompositeScore',
    'avgLlmScore',
    'minLlmScore',
    'maxLlmScore',
  ] as const;
  if (
    optionalMetrics.some((field) =>
      value[field] !== undefined && !isNonNegativeNumber(value[field])
    )
    || optionalScores.some((field) =>
      value[field] !== undefined && !isScore(value[field])
    )
    || (value.avgAssertionScore !== undefined && !isScore(value.avgAssertionScore))
    || (value.avgFactVerifiedRate !== undefined && !isRate(value.avgFactVerifiedRate))
    || (value.toolSuccessRate !== undefined && !isRate(value.toolSuccessRate))
    || (value.traceCoverageRate !== undefined && !isRate(value.traceCoverageRate))
    || (value.toolDistribution !== undefined && (
      !isCountRecord(value.toolDistribution)
      || finiteSum(Object.values(value.toolDistribution)) === undefined
    ))
    || (value.judgeAgreement !== undefined && !isSummaryJudgeAgreement(value.judgeAgreement))
    || (value.judgeModels !== undefined && !isSummaryJudgeModels(value.judgeModels))
    || (value.bootstrapCI !== undefined && !isBootstrapCI(value.bootstrapCI))
  ) return false;
  if (
    typeof value.minCompositeScore === 'number'
    && typeof value.avgCompositeScore === 'number'
    && typeof value.maxCompositeScore === 'number'
    && (
      value.minCompositeScore > value.avgCompositeScore
      || value.avgCompositeScore > value.maxCompositeScore
    )
  ) return false;
  if (
    typeof value.minLlmScore === 'number'
    && typeof value.avgLlmScore === 'number'
    && typeof value.maxLlmScore === 'number'
    && (
      value.minLlmScore > value.avgLlmScore
      || value.avgLlmScore > value.maxLlmScore
    )
  ) return false;
  const totalSamples = value.totalSamples as number;
  const errorCount = value.errorCount as number;
  const expectedErrorRate = totalSamples > 0
    ? Number((errorCount / totalSamples * 100).toFixed(1))
    : 0;
  return value.errorRate === expectedErrorRate;
}

function isVariantSummaryRecord(value: unknown): value is Record<string, VariantSummary> {
  return isRecord(value)
    && Object.keys(value).every((key) => key.length > 0)
    && Object.values(value).every(isVariantSummary);
}

function isScoreArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(isScore);
}

function isLayeredScores(value: unknown): boolean {
  return isRecord(value)
    && ['factScore', 'behaviorScore', 'judgeScore'].every(
      (field) => value[field] === undefined || isScore(value[field]),
    );
}

function isAssertionResults(value: unknown): boolean {
  if (
    !isRecord(value)
    || !isNonNegativeInteger(value.passed)
    || !isNonNegativeInteger(value.total)
    || value.passed > value.total
    || !isScore(value.score)
    || !Array.isArray(value.details)
    || (value.judgeCostUSD !== undefined && !isNonNegativeNumber(value.judgeCostUSD))
    || !isOptionalBoolean(value.judgeCostReportedByExecutor)
  ) return false;
  return value.details.every((detail) =>
    isRecord(detail)
    && typeof detail.type === 'string'
    && detail.type.length > 0
    && (
      typeof detail.value === 'string'
      || (
        typeof detail.value === 'number'
        && Number.isFinite(detail.value)
      )
    )
    && isNonNegativeNumber(detail.weight)
    && typeof detail.passed === 'boolean'
    && (detail.message === undefined || typeof detail.message === 'string')
    && (
      detail.layer === undefined
      || detail.layer === 'fact'
      || detail.layer === 'behavior'
    )
  );
}

function isEnsembleEntry(value: unknown): boolean {
  if (
    !isRecord(value)
    || typeof value.judge !== 'string'
    || value.judge.length === 0
    || !isScore(value.score)
    || (value.scoreStddev !== undefined && !isNonNegativeNumber(value.scoreStddev))
    || (value.scoreSamples !== undefined && !isScoreArray(value.scoreSamples))
    || !isOptionalNonNegativeInteger(value.judgeFailureCount)
    || (value.reasoning !== undefined && typeof value.reasoning !== 'string')
    || (value.costUSD !== undefined && !isNonNegativeNumber(value.costUSD))
    || !isOptionalBoolean(value.costReportedByExecutor)
  ) return false;
  return !(
    Array.isArray(value.scoreSamples)
    && typeof value.judgeFailureCount === 'number'
    && value.judgeFailureCount > value.scoreSamples.length
  );
}

function isDimensionResult(value: unknown): boolean {
  return isRecord(value)
    && isScore(value.score)
    && typeof value.reason === 'string'
    && (value.judgeCostUSD === undefined || isNonNegativeNumber(value.judgeCostUSD))
    && isOptionalBoolean(value.judgeCostReportedByExecutor)
    && (value.scoreSamples === undefined || isScoreArray(value.scoreSamples))
    && (value.scoreStddev === undefined || isNonNegativeNumber(value.scoreStddev))
    && isOptionalNonNegativeInteger(value.judgeFailureCount)
    && (
      !Array.isArray(value.scoreSamples)
      || typeof value.judgeFailureCount !== 'number'
      || value.judgeFailureCount <= value.scoreSamples.length
    )
    && (value.reasoning === undefined || typeof value.reasoning === 'string')
    && (
      value.ensemble === undefined
      || (Array.isArray(value.ensemble) && value.ensemble.every(isEnsembleEntry))
    )
    && (value.agreement === undefined || isBaseJudgeAgreement(value.agreement));
}

function isFactCheck(value: unknown): boolean {
  if (
    !isRecord(value)
    || !isNonNegativeInteger(value.verifiedCount)
    || !isNonNegativeInteger(value.totalCount)
    || value.verifiedCount > value.totalCount
    || !isRate(value.verifiedRate)
    || !Array.isArray(value.claims)
    || value.claims.length !== value.totalCount
  ) return false;
  const expectedRate = value.totalCount > 0
    ? value.verifiedCount / value.totalCount
    : 0;
  if (Math.abs(value.verifiedRate - expectedRate) > 1e-9) return false;
  return value.claims.every((claim) =>
    isRecord(claim)
    && typeof claim.type === 'string'
    && typeof claim.value === 'string'
    && typeof claim.verified === 'boolean'
    && (claim.evidence === undefined || typeof claim.evidence === 'string')
  ) && value.claims.filter((claim) =>
    isRecord(claim) && claim.verified === true
  ).length === value.verifiedCount;
}

function isDiagnostic(value: unknown): boolean {
  const rootCauses = new Set([
    'skill_doc_unclear',
    'skill_doc_missing',
    'llm_misread',
    'sample_design',
    'tripwire_intentional',
  ]);
  const failureModes = new Set([
    '工作流跳步',
    '硬编码值',
    '幻觉输出',
    '工具误用',
    '环境拦截',
    '误读约束',
    '其他',
  ]);
  return isRecord(value)
    && typeof value.summary === 'string'
    && typeof value.expected === 'string'
    && typeof value.actual === 'string'
    && Array.isArray(value.rootCause)
    && value.rootCause.every((item) => typeof item === 'string' && rootCauses.has(item))
    && (
      value.workflowChecks === undefined
      || (
        Array.isArray(value.workflowChecks)
        && value.workflowChecks.every((check) =>
          isRecord(check)
          && typeof check.step === 'string'
          && typeof check.passed === 'boolean'
          && typeof check.evidence === 'string'
        )
      )
    )
    && (
      value.failureModes === undefined
      || (
        Array.isArray(value.failureModes)
        && value.failureModes.every((item) =>
          typeof item === 'string' && failureModes.has(item)
        )
      )
    )
    && isRecord(value.suggestion)
    && typeof value.suggestion.skill === 'string'
    && typeof value.suggestion.sample === 'string'
    && typeof value.suggestion.none === 'string'
    && (value.costUSD === undefined || isNonNegativeNumber(value.costUSD))
    && isOptionalBoolean(value.costReportedByExecutor)
    && typeof value.ok === 'boolean'
    && (value.error === undefined || typeof value.error === 'string');
}

function isVariantResult(value: unknown): value is VariantResult {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return false;
  const tokenFields = [
    value.inputTokens,
    value.outputTokens,
    value.cacheReadTokens,
    value.cacheCreationTokens,
  ];
  const expectedTotal = checkedSumTokenCounts(...tokenFields);
  const numericFields = [
    value.durationMs,
    value.durationApiMs,
    value.execCostUSD,
    value.judgeCostUSD,
    value.costUSD,
  ];
  if (
    expectedTotal === undefined
    || !isNonNegativeInteger(value.totalTokens)
    || value.totalTokens !== expectedTotal
    || !numericFields.every(isNonNegativeNumber)
    || !isNonNegativeInteger(value.numTurns)
    || (
      value.attemptCount !== undefined
      && (!isNonNegativeInteger(value.attemptCount) || value.attemptCount < 1)
    )
    || (value.outputPreview !== null && typeof value.outputPreview !== 'string')
    || !isOptionalBoolean(value.tokenUsageReportedByExecutor)
    || !isOptionalBoolean(value.costReportedByExecutor)
    || !isOptionalBoolean(value.judgeCostReportedByExecutor)
    || !traceProjectionIsConsistent(value)
  ) return false;
  if (
    (value.compositeScore !== undefined && !isScore(value.compositeScore))
    || (value.layeredScores !== undefined && !isLayeredScores(value.layeredScores))
    || (value.assertions !== undefined && !isAssertionResults(value.assertions))
    || (value.llmScore !== undefined && !isScore(value.llmScore))
    || (value.llmReason !== undefined && typeof value.llmReason !== 'string')
    || (value.llmReasoning !== undefined && typeof value.llmReasoning !== 'string')
    || (value.llmScoreStddev !== undefined && !isNonNegativeNumber(value.llmScoreStddev))
    || (value.llmScoreSamples !== undefined && !isScoreArray(value.llmScoreSamples))
    || !isOptionalNonNegativeInteger(value.llmScoreFailures)
    || (
      Array.isArray(value.llmScoreSamples)
      && typeof value.llmScoreFailures === 'number'
      && value.llmScoreFailures > value.llmScoreSamples.length
    )
    || (
      value.llmEnsemble !== undefined
      && (!Array.isArray(value.llmEnsemble) || !value.llmEnsemble.every(isEnsembleEntry))
    )
    || (value.llmAgreement !== undefined && !isBaseJudgeAgreement(value.llmAgreement))
    || (
      value.dimensions !== undefined
      && (
        !isRecord(value.dimensions)
        || !Object.keys(value.dimensions).every((key) => key.length > 0)
        || !Object.values(value.dimensions).every(isDimensionResult)
      )
    )
    || (value.factCheck !== undefined && !isFactCheck(value.factCheck))
    || (value.fullOutput !== undefined && typeof value.fullOutput !== 'string')
    || (value.diagnostic !== undefined && !isDiagnostic(value.diagnostic))
  ) return false;
  if (value.timing !== undefined) {
    if (
      !isRecord(value.timing)
      || !isNonNegativeNumber(value.timing.execMs)
      || !isNonNegativeNumber(value.timing.gradeMs)
      || (
        value.timing.diagnosticMs !== undefined
        && !isNonNegativeNumber(value.timing.diagnosticMs)
      )
      || !isNonNegativeNumber(value.timing.totalMs)
      || !numbersEqual(
        value.timing.totalMs,
        value.timing.execMs
          + value.timing.gradeMs
          + (typeof value.timing.diagnosticMs === 'number' ? value.timing.diagnosticMs : 0),
      )
    ) return false;
  }
  if (
    value.diagnosticCostUSD !== undefined
    && !isNonNegativeNumber(value.diagnosticCostUSD)
  ) return false;
  const expectedCost = (value.execCostUSD as number)
    + (value.judgeCostUSD as number)
    + (typeof value.diagnosticCostUSD === 'number' ? value.diagnosticCostUSD : 0);
  if (
    !Number.isFinite(expectedCost)
    || Math.abs((value.costUSD as number) - expectedCost) > 1e-9
  ) return false;
  return value.error === undefined || typeof value.error === 'string';
}

function isResultEntries(value: unknown, variants: string[]): value is Array<{
  sample_id: string;
  variants: Record<string, VariantResult>;
}> {
  if (!Array.isArray(value)) return false;
  const sampleIds = new Set<string>();
  return value.every((entry) => {
    if (
      !isRecord(entry)
      || typeof entry.sample_id !== 'string'
      || entry.sample_id.length === 0
      || sampleIds.has(entry.sample_id)
      || !isRecord(entry.variants)
      || !hasExactKeys(entry.variants, variants)
    ) return false;
    sampleIds.add(entry.sample_id);
    const variantResults = entry.variants;
    return variants.every((variant) => isVariantResult(variantResults[variant]));
  });
}

function isEvaluationMeta(value: unknown, expectedReportId?: string): value is ReportMeta {
  if (!isRecord(value)) return false;
  return isStringArray(value.variants)
    && new Set(value.variants).size === value.variants.length
    && typeof value.model === 'string'
    && value.model.length > 0
    && typeof value.executor === 'string'
    && value.executor.length > 0
    && isNonNegativeInteger(value.sampleCount)
    && isNonNegativeInteger(value.taskCount)
    && isNonNegativeNumber(value.totalCostUSD)
    && normalizeRfc3339Timestamp(value.timestamp) !== undefined
    && typeof value.cliVersion === 'string'
    && typeof value.nodeVersion === 'string'
    && isStringRecord(value.artifactHashes)
    && isJudgeModels(value.judgeModels)
    && isOptionalBoolean(value.totalCostReported)
    && reportMetaExtensionsAreValid(value, expectedReportId);
}

function isBatchMeta(value: unknown, expectedReportId?: string): value is BatchEvaluationMeta {
  if (!isRecord(value)) return false;
  const isCurrentSchema = Number.isSafeInteger(value.schemaVersion)
    && (value.schemaVersion as number) >= 4;
  return value.mode === 'skill'
    && isNonNegativeInteger(value.schemaVersion)
    && typeof value.model === 'string'
    && value.model.length > 0
    && typeof value.executor === 'string'
    && value.executor.length > 0
    && typeof value.skillDir === 'string'
    && isNonNegativeInteger(value.sampleCount)
    && isNonNegativeInteger(value.taskCount)
    && isNonNegativeInteger(value.totalArtifacts)
    && isNonNegativeNumber(value.totalCostUSD)
    && normalizeRfc3339Timestamp(value.timestamp) !== undefined
    && typeof value.cliVersion === 'string'
    && typeof value.nodeVersion === 'string'
    && isJudgeModels(value.judgeModels)
    && isOptionalBoolean(value.totalCostReported)
    && (
      value.executorRuntime === undefined
      || (
        isRuntimeFingerprint(value.executorRuntime)
        && value.executorRuntime.executor === value.executor
        && value.executorRuntime.model === value.model
      )
    )
    && (
      value.executorRuntimes === undefined
      || (
        isRecord(value.executorRuntimes)
        && Object.values(value.executorRuntimes).every(isRuntimeFingerprint)
        && Object.values(value.executorRuntimes).every(
          (runtime) =>
            isRecord(runtime)
            && runtime.executor === value.executor
            && runtime.model === value.model,
        )
      )
    )
    && isOptionalBoolean(value.noJudge)
    && (
      value.noJudge !== true
      || (value.judgeModels as Array<Record<string, unknown>>).every(
        (judge) => judge.runtime === undefined,
      )
    )
    && (
      !isCurrentSchema
      || value.noJudge === true
      || (value.judgeModels as Array<Record<string, unknown>>).every(
        (judge) => judge.runtime !== undefined,
      )
    )
    && (
      value.gitInfo === undefined
      || value.gitInfo === null
      || isGitInfo(value.gitInfo)
    )
    && embeddedLifecycleIsValid(value, expectedReportId, true);
}

function isBatchItems(value: unknown): value is BatchEvaluationItem[] {
  if (!Array.isArray(value)) return false;
  const names = new Set<string>();
  const reportIds = new Set<string>();
  return value.every((item) => {
    if (
      !isRecord(item)
      || typeof item.name !== 'string'
      || item.name.length === 0
      || names.has(item.name)
      || typeof item.skillPath !== 'string'
      || typeof item.samplesPath !== 'string'
      || !isCanonicalReportId(item.reportId)
      || reportIds.has(item.reportId)
      || (item.reportPath !== null && typeof item.reportPath !== 'string')
      || (item.status !== 'completed' && item.status !== 'failed')
      || !isNonNegativeInteger(item.sampleCount)
      || !isNonNegativeNumber(item.totalCostUSD)
      || (item.artifactHash !== null && typeof item.artifactHash !== 'string')
      || !isVariantSummaryRecord(item.summary)
      || !hasExactKeys(item.summary, ['baseline', item.name])
      || !Object.values(item.summary).every(
        (variant) => variant.totalSamples === item.sampleCount,
      )
      || (
        item.variance !== undefined
        && !isVarianceData(item.variance, ['baseline', item.name])
      )
    ) return false;
    names.add(item.name);
    reportIds.add(item.reportId);
    return true;
  });
}

export function isCanonicalReportId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && safeArtifactFileStem(value) === value;
}

function evaluationEnvelopeIsConsistent(
  meta: ReportMeta,
  summary: Record<string, VariantSummary>,
  results?: Array<{
    sample_id: string;
    variants?: Record<string, VariantResult>;
  }>,
): boolean {
  const request = meta.request;
  const requestBudget = request?.budget;
  const metaBudget = meta.budget;
  const budgetMatchesRequest = request === undefined
    || (
      requestBudget?.totalUSD === metaBudget?.totalUSD
      && requestBudget?.perSampleUSD === metaBudget?.perSampleUSD
      && requestBudget?.perSampleMs === metaBudget?.perSampleMs
    );
  const maxAttempts = (request?.retry ?? 0) + 1;
  const attemptsMatchRequest = request === undefined
    || results === undefined
    || results.every((entry) =>
      entry.variants === undefined
      || Object.values(entry.variants).every(
        (result) => (result.attemptCount ?? 1) <= maxAttempts,
      )
    );
  if (
    !hasExactKeys(summary, meta.variants)
    || !hasExactKeys(meta.artifactHashes, meta.variants)
    || meta.taskCount !== meta.sampleCount * meta.variants.length
    || !Number.isSafeInteger(meta.taskCount)
    || !budgetMatchesRequest
    || !attemptsMatchRequest
    || (
      meta.budgetExhausted === true
      && requestBudget?.totalUSD === undefined
    )
    || (
      request !== undefined
      && !hasExactKeys(
        Object.fromEntries(request.artifacts.map((artifact) => [artifact.name, true])),
        meta.variants,
      )
      )
    || (
      (meta.schemaVersion ?? 0) >= 5
      && (
        !isSampleHashRecord(meta.sampleHashes)
        || (
          results
            ? !hasExactKeys(meta.sampleHashes, results.map((entry) => entry.sample_id))
            : Object.keys(meta.sampleHashes).length !== meta.sampleCount
        )
      )
    )
  ) return false;
  return meta.variants.every((variant) => summary[variant].totalSamples === meta.sampleCount);
}

function numbersEqual(left: number, right: number, tolerance = 1e-9): boolean {
  return Number.isFinite(left)
    && Number.isFinite(right)
    && Math.abs(left - right) <= tolerance;
}

function finiteSum(values: number[]): number | undefined {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!isNonNegativeNumber(total)) return undefined;
  }
  return total;
}

function averageRounded(values: number[], digits?: number): number | undefined {
  const total = finiteSum(values);
  if (total === undefined) return undefined;
  if (values.length === 0) return 0;
  const average = total / values.length;
  return digits === undefined
    ? Math.round(average)
    : Number(average.toFixed(digits));
}

function coreVariantSummaryMatches(
  summary: VariantSummary,
  entries: VariantResult[],
): boolean {
  const successful = entries.filter((entry) => entry.ok);
  const observedTokens = successful.filter(
    (entry) => entry.tokenUsageReportedByExecutor !== false,
  );
  const tokenCoverage = entries.length > 0
    ? Number((
        entries.filter((entry) => entry.tokenUsageReportedByExecutor !== false).length
        / entries.length
      ).toFixed(4))
    : 1;
  const durations = successful.map((entry) => entry.timing?.totalMs || entry.durationMs);
  const inputTokens = averageRounded(observedTokens.map((entry) => entry.inputTokens));
  const outputTokens = averageRounded(observedTokens.map((entry) => entry.outputTokens));
  const totalTokens = averageRounded(observedTokens.map((entry) => entry.totalTokens));
  const duration = averageRounded(durations);
  const turns = averageRounded(successful.map((entry) => entry.numTurns), 1);
  const totalCost = finiteSum(successful.map((entry) => entry.costUSD));
  const execCost = finiteSum(successful.map((entry) => entry.execCostUSD));
  const judgeCost = finiteSum(successful.map((entry) => entry.judgeCostUSD));
  const diagnosticCostRaw = finiteSum(
    successful.map((entry) => entry.diagnosticCostUSD ?? 0),
  );
  if (
    inputTokens === undefined
    || outputTokens === undefined
    || totalTokens === undefined
    || duration === undefined
    || turns === undefined
    || totalCost === undefined
    || execCost === undefined
    || judgeCost === undefined
    || diagnosticCostRaw === undefined
  ) return false;
  const avgCost = successful.length > 0
    ? Number((totalCost / successful.length).toFixed(6))
    : 0;
  const expectedDiagnosticCost = diagnosticCostRaw > 0
    ? Number(diagnosticCostRaw.toFixed(6))
    : 0;
  const execCostReported = !entries.some(
    (entry) => entry.costReportedByExecutor === false,
  );
  const judgeCostReported = !entries.some(
    (entry) => entry.judgeCostReportedByExecutor === false,
  );

  return summary.avgDurationMs === duration
    && summary.avgInputTokens === inputTokens
    && summary.avgOutputTokens === outputTokens
    && summary.avgTotalTokens === totalTokens
    && summary.avgNumTurns === turns
    && numbersEqual(summary.totalCostUSD, totalCost)
    && numbersEqual(summary.totalExecCostUSD, execCost)
    && numbersEqual(summary.totalJudgeCostUSD, judgeCost)
    && numbersEqual(summary.avgCostPerSample, avgCost)
    && (
      tokenCoverage < 1
        ? summary.tokenUsageCoverageRate === tokenCoverage
        : summary.tokenUsageCoverageRate === undefined
          || summary.tokenUsageCoverageRate === 1
    )
    && (
      expectedDiagnosticCost > 0
        ? numbersEqual(summary.totalDiagnosticCostUSD ?? -1, expectedDiagnosticCost)
        : summary.totalDiagnosticCostUSD === undefined
          || summary.totalDiagnosticCostUSD === 0
    )
    && (summary.execCostReported !== false) === execCostReported
    && (summary.judgeCostReported !== false) === judgeCostReported;
}

function evaluationCostsAreConsistent(
  meta: ReportMeta,
  summary: Record<string, VariantSummary>,
  results: Array<{ variants: Record<string, VariantResult> }>,
): boolean {
  const allResults = results.flatMap((entry) =>
    meta.variants.map((variant) => entry.variants[variant])
  );
  const totalCost = finiteSum(allResults.map((entry) => entry.costUSD));
  if (totalCost === undefined || !numbersEqual(meta.totalCostUSD, Number(totalCost.toFixed(6)))) {
    return false;
  }
  const allCostReported = Object.values(summary).every(
    (variant) => variant.execCostReported !== false && variant.judgeCostReported !== false,
  );
  return allCostReported
    ? meta.totalCostReported === undefined || meta.totalCostReported === true
    : meta.totalCostReported === false;
}

function batchEnvelopeIsConsistent(
  meta: BatchEvaluationMeta,
  items: BatchEvaluationItem[],
): boolean {
  const itemNames = items.map((item) => item.name);
  const sampleCount = finiteSum(items.map((item) => item.sampleCount));
  const taskCount = finiteSum(items.map(
    (item) => item.sampleCount * Object.keys(item.summary).length,
  ));
  const totalCost = finiteSum(items.map((item) => item.totalCostUSD));
  if (
    sampleCount === undefined
    || taskCount === undefined
    || totalCost === undefined
    || meta.totalArtifacts !== items.length
    || meta.sampleCount !== sampleCount
    || meta.taskCount !== taskCount
    || !numbersEqual(meta.totalCostUSD, Number(totalCost.toFixed(6)))
    || (
      meta.executorRuntimes !== undefined
      && !hasExactKeys(meta.executorRuntimes, itemNames)
    )
    || (
      meta.request !== undefined
      && !hasExactKeys(
        Object.fromEntries(meta.request.artifacts.map((artifact) => [artifact.name, true])),
        itemNames,
      )
    )
  ) return false;
  const allCostReported = items.every((item) =>
    Object.values(item.summary).every(
      (variant) => variant.execCostReported !== false && variant.judgeCostReported !== false,
    )
  );
  return allCostReported
    ? meta.totalCostReported === undefined || meta.totalCostReported === true
    : meta.totalCostReported === false;
}

/**
 * Parse a persisted report at every storage boundary. Canonical report files
 * are the source of truth; index cards must never relax this contract.
 */
export function parseReportDocument(
  value: unknown,
  fallbackId: string,
  expectedId?: string,
): ReportDocument | null {
  if (!isRecord(value)) return null;
  const kind = value.kind === 'evaluation' || value.kind === 'batch-evaluation'
    ? value.kind
    : undefined;
  const id = isCanonicalReportId(value.id) ? value.id : fallbackId;
  if (!isCanonicalReportId(value.id) || !isCanonicalReportId(id)) return null;
  if (expectedId !== undefined && id !== expectedId) return null;

  if (kind === 'evaluation') {
    const meta = value.meta;
    const summary = value.summary;
    if (
      !isEvaluationMeta(meta, id)
      || !isVariantSummaryRecord(summary)
      || !isResultEntries(value.results, meta.variants)
      || !evaluationEnvelopeIsConsistent(meta, summary, value.results)
      || value.results.length !== meta.sampleCount
      || (
        value.sampleSnapshots !== undefined
        && !isSampleSnapshotRecord(
          value.sampleSnapshots,
          value.results.map((entry) => entry.sample_id),
        )
      )
      || (
        value.analysis !== undefined
        && !isAnalysisResult(value.analysis, meta.variants, value.results)
      )
      || (
        value.variance !== undefined
        && !isVarianceData(value.variance, meta.variants)
      )
    ) return null;
    for (const variant of meta.variants) {
      const variantResults = value.results.map((entry) => entry.variants[variant]);
      const successCount = variantResults.filter((entry) => entry.ok).length;
      if (
        summary[variant].successCount !== successCount
        || summary[variant].errorCount !== value.results.length - successCount
        || !coreVariantSummaryMatches(summary[variant], variantResults)
      ) return null;
    }
    if (!evaluationCostsAreConsistent(meta, summary, value.results)) return null;
    return value as unknown as ReportDocument;
  }

  if (
    kind === 'batch-evaluation'
    && value.mode === 'skill'
    && isBatchMeta(value.meta, id)
    && isBatchItems(value.items)
    && batchEnvelopeIsConsistent(value.meta, value.items)
  ) {
    return value as unknown as ReportDocument;
  }
  return null;
}

/**
 * Validate a lightweight report discovery card. The card is still only a
 * pointer: consumers must parse `path` through `parseReportDocument` before use.
 */
export function parseReportIndexCard(value: unknown): ReportIndexCard | null {
  if (
    !isRecord(value)
    || value.domain !== 'report'
    || !isCanonicalReportId(value.id)
    || typeof value.path !== 'string'
    || !isAbsolute(value.path)
    || reportFilePath(dirname(value.path), value.id) !== value.path
  ) return null;

  if (
    value.kind === 'evaluation'
    && isEvaluationMeta(value.meta, value.id)
    && isVariantSummaryRecord(value.summary)
    && evaluationEnvelopeIsConsistent(value.meta, value.summary)
  ) {
    return value as unknown as ReportIndexCard;
  }
  if (
    value.kind === 'batch-evaluation'
    && isBatchMeta(value.meta, value.id)
    && isBatchItems(value.items)
    && batchEnvelopeIsConsistent(value.meta, value.items)
  ) {
    return value as unknown as ReportIndexCard;
  }
  return null;
}
