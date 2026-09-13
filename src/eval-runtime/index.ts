/** Canonical user-facing Evaluation Runtime API. */
export type { AbstentionEvaluator, AbstentionMetricIds } from './evaluators/abstention.js';
export {
  EvaluationConfigurationError,
  EvaluationEventConsumptionError,
  assessComparability,
  checkContentStore,
  checkExecutor,
  evaluate,
  executeEvaluation,
  prepareEvaluation,
  reanalyze,
  redecide,
  rescore,
  scoreExecutedEvaluation,
} from './evaluate.js';
export {
  evaluateSeries,
  prepareEvaluationSeries,
} from './series.js';
export {
  EVALUATION_RESULT_MEDIA_TYPE,
  EvaluationResultStoreError,
  loadEvaluationResult,
  saveEvaluationResult,
} from './result-store.js';
export {
  EXECUTED_EVALUATION_MEDIA_TYPE,
  ExecutedEvaluationStoreError,
  loadExecutedEvaluation,
  saveExecutedEvaluation,
} from './executed-store.js';
export {
  RUNTIME_CHECK_RESULT_SCHEMA_VERSION,
  checkRuntime,
} from './conformance/runtime.js';
export type {
  Artifact,
  ArtifactKind,
  ArtifactSource,
  AnalysisRequest,
  AssessComparabilityInput,
  AttemptBudgetScope,
  BudgetPolicy,
  BudgetScope,
  CachePolicy,
  Clock,
  CohortFilter,
  Comparison,
  ComparisonFamilyMember,
  CompositeAggregation,
  CompositeMetricComponent,
  ContentStoreCheckInput,
  ContentStoreCheckResult,
  Dataset,
  Decision,
  EvaluateInput,
  EvaluationExecutor,
  EvaluationComparabilityAssessment,
  EvaluationComparabilitySubject,
  EvaluationEventWriter,
  EvaluationRunOptions,
  EvaluationResult,
  EvaluationWorkEstimate,
  EvidencePolicy,
  Evaluator,
  EventObserver,
  ExecutedEvaluation,
  ExactMatchEvaluator,
  FailurePolicy,
  FamilyDecisionCriterion,
  Executor,
  ExecutorCapabilities,
  ExecutorCheckInput,
  ExecutorCheckResult,
  ExecutorInvocation,
  ExecutorResult,
  ExecutorSession,
  ExecutorSessionAttempt,
  ExecutorSessionContext,
  Experiment,
  InvokeExecutor,
  Judge,
  Policy,
  PreparedEvaluation,
  PreparedEvaluationPlan,
  ProviderCostLimit,
  RetryBackoff,
  RetryPolicy,
  RetrievalEvaluator,
  Rubric,
  RubricJudgeAggregation,
  RubricJudgeEvaluator,
  RubricJudgeMember,
  RuntimeConformanceCheck,
  RuntimeContext,
  RuntimeCapabilityResolution,
  RunBudgetScope,
  Sample,
  SamplingDesign,
  SessionExecutor,
  StagePolicy,
  ToolTrajectoryEvaluator,
  Variant,
  VariantExecution,
} from './evaluate.js';
export type {
  EvaluationSeriesInput,
  EvaluationSeriesMemberResult,
  EvaluationSeriesResult,
  EvaluationSeriesRunOptions,
  EvaluationSeriesStability,
  EvaluationSeriesStabilityResult,
  EvaluationSeriesWorkEstimate,
  PreparedEvaluationSeries,
  RunStabilityValue,
} from './series.js';
export type {
  EvaluationResultVerification,
  EvaluationResultVerificationRequest,
  EvaluationResultVerifier,
  LoadEvaluationResultInput,
  SaveEvaluationResultInput,
} from './result-store.js';
export type {
  ExecutedEvaluationVerification,
  ExecutedEvaluationVerificationRequest,
  ExecutedEvaluationVerifier,
  LoadExecutedEvaluationInput,
  SaveExecutedEvaluationInput,
} from './executed-store.js';
export type { ContentStoreConformanceCheck } from './conformance/content-store.js';
export type {
  CacheRuntimeCheckInput,
  CacheRuntimeCheckResult,
  ContentStoreRuntimeCheckInput,
  ContentStoreRuntimeCheckResult,
  ExecutorRuntimeCheckInput,
  ExecutorRuntimeCheckResult,
  EvaluatorRuntimeCheckInput,
  EvaluatorRuntimeCheckResult,
  JudgeRuntimeCheckInput,
  JudgeRuntimeCheckResult,
  RuntimeCheckInput,
  RuntimeCheckKind,
  RuntimeCheckResult,
  WorkspaceProviderRuntimeCheckInput,
  WorkspaceProviderRuntimeCheckResult,
} from './conformance/runtime.js';
export type {
  CacheConformanceCheck,
  CacheConformanceProbeInput,
  CacheConformanceResult,
} from './conformance/cache.js';
export type {
  WorkspaceProviderConformanceCheck,
  WorkspaceProviderConformanceProbeInput,
  WorkspaceProviderConformanceResult,
} from './conformance/workspace-provider.js';
export type {
  EvaluatorConformanceCheck,
  EvaluatorConformanceProbeInput,
  EvaluatorConformanceProbeSources,
  EvaluatorConformanceResult,
} from './conformance/evaluator.js';
export type {
  JudgeConformanceCheck,
  JudgeConformanceProbeCase,
  JudgeConformanceProbeInput,
  JudgeConformanceResult,
} from './conformance/judge.js';
export type {
  ContentDescriptor,
  ContentResolver,
  ContentStore,
  ContentStoreRequest,
  ContentValue,
  EvaluationCache,
  EvaluationCacheEntry,
  EvaluationInfrastructure,
  ExecutionCache,
  ExecutionCacheEntry,
  ExecutorIdentityVerification,
  ExecutorIdentityVerificationRequest,
  ExecutorIdentityVerifier,
} from './infrastructure.js';
export type { RetrievalMetricIds } from './evaluators/retrieval.js';
export type { ToolTrajectoryMatchMode } from './evaluators/tool-trajectory.js';
export type {
  MockInterceptionAccess,
  MockInterceptionDecision,
  MockInterceptionDescriptor,
  MockInterceptionInput,
  MockInterceptionLease,
  MockInterceptionOpenRequest,
  MockInterceptionPlan,
  MockInterceptionProvider,
  MockInterceptionRequest,
} from './mock-interception.js';
export { MOCK_INTERCEPTION_PLAN_MEDIA_TYPE } from './mock-interception.js';
export type {
  McpConfigAccess,
  McpConfigDescriptor,
  McpConfigInput,
  McpConfigLease,
  McpConfigOpenRequest,
  McpConfigPlan,
  McpConfigProvider,
} from './mcp-config.js';
export type {
  AllowedToolsInput,
  AllowedToolsPlan,
} from './tool-policy.js';
export type {
  WorkspaceAccess,
  WorkspaceDescriptor,
  WorkspaceInput,
  WorkspaceLease,
  WorkspaceOpenRequest,
  WorkspacePlan,
  WorkspaceProvider,
} from './workspace.js';
export type {
  CustomEvaluator,
  CustomEvaluatorBinding,
  CustomEvaluatorContent,
  CustomEvaluatorInvocation,
  CustomEvaluatorResult,
  Metric,
} from './custom-evaluator.js';

// Imperative builders for assembling Definitions, Policies, and Evaluators directly.
export { createExactMatchDefinition } from './builders/exact-match.js';
export type {
  ExactMatchDefinitionBuilderInput,
  ExactMatchTarget,
} from './builders/exact-match.js';
export { createMeasurementPolicy } from './builders/policy.js';
export type {
  MeasurementEventDeliveryInput,
  MeasurementFailurePolicyInput,
  MeasurementAttemptBudgetScopeInput,
  MeasurementBudgetPolicyInput,
  MeasurementBudgetScopeInput,
  MeasurementCachePolicyInput,
  MeasurementEvidencePolicyInput,
  MeasurementPolicyBuilderInput,
  MeasurementProviderCostLimitInput,
  MeasurementRetryBackoffInput,
  MeasurementRetryPolicyInput,
  MeasurementRunBudgetScopeInput,
  MeasurementStagePolicyInput,
} from './builders/policy.js';
export { createPairedComparisonDefinition } from './builders/paired-comparison.js';
export type {
  EvaluationRuntimeTarget,
  PairedComparisonDefinitionBuilderInput,
} from './builders/paired-comparison.js';
export {
  EXACT_MATCH_EVALUATOR_IMPLEMENTATION_ID,
  createExactMatchEvaluator,
  createExactMatchEvaluatorIdentity,
} from './evaluators/exact-match.js';
export type { CreateExactMatchEvaluatorInput } from './evaluators/exact-match.js';
export {
  createRubricJudgeCriterion,
  createRubricJudgeEvaluator,
  createRubricJudgeEvaluatorDefinition,
  createRubricJudgeEvaluatorIdentity,
  createRubricJudgeEvaluatorRegistration,
  createRubricJudgeInstrument,
  createRubricJudgeMetricDefinition,
  createRubricJudgeRuntimeConfig,
  rubricJudgeInstrumentId,
} from './judges/rubric-judge.js';
export type {
  CreateRubricJudgeEvaluatorInput,
  RubricJudgeEvaluatorBinding,
  RubricJudgeEvaluatorDefinitionBuilderInput,
} from './judges/rubric-judge.js';
export {
  createRubricJudgeEvaluationContext,
  createRubricJudgeKit,
  createRubricJudgeRegistration,
} from './judges/rubric-kit.js';
export type {
  CreateRubricJudgeKitInput,
  RubricJudgeKit,
} from './judges/rubric-kit.js';
