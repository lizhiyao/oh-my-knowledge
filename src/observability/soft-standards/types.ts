import type { ExecutorFn } from '../../types/index.js';
import type {
  ObservationSkillChain,
  SkillRuntimeEvidencePack,
  SkillRuntimeEvidencePackRef,
} from '../skill-chain.js';
import type { SOFT_STANDARD_PROMPT_ID, SOFT_STANDARD_PROMPT_VERSION } from './constants.js';

export type SkillDerivedStandardStatus = 'pending_review' | 'author_confirmed' | 'rejected' | 'stale';
export type SkillDerivedStandardKind = 'hard_rule_candidate' | 'workflow_candidate';

export interface SkillDerivedStandard {
  id: string;
  standardKind: SkillDerivedStandardKind;
  status: SkillDerivedStandardStatus;
  title: string;
  body: string;
  source: 'llm_soft_standard';
  confidence: 'low' | 'medium' | 'high';
  evidence: string[];
}

export interface SkillDerivedStandards {
  kind: 'observe-skill-derived-standards';
  schemaVersion: 2;
  skillName: string;
  sourceSkillPath?: string;
  sourceHash?: string;
  generatedAt: string;
  model: string;
  executor: string;
  promptId: typeof SOFT_STANDARD_PROMPT_ID;
  promptVersion: typeof SOFT_STANDARD_PROMPT_VERSION;
  promptHash?: string;
  runtimeEvidenceHash?: string;
  enhancedReview?: SkillLlmEnhancedReviewSections;
  standards: SkillDerivedStandard[];
}

export interface SkillLlmEnhancedRuntimeEvidence {
  goalSlices: Array<{
    id?: string;
    sessionId?: string;
    inferredUserGoal?: string;
    userMessages?: string[];
  }>;
  userMessages: string[];
  assistantMessages: string[];
  artifactCandidates: string[];
  toolCalls: string[];
  findings: string[];
  skillRuntimeEvidencePack?: SkillRuntimeEvidencePack;
}

export type LlmEnhancedSkillType = 'router' | 'delegation' | 'executor' | 'advisory' | 'workflow_owner' | 'unknown';
export type LlmEnhancedVerdict = 'passed' | 'failed' | 'unknown';
export type LlmEnhancedUserFeeling = 'positive' | 'neutral' | 'negative' | 'frustrated';
export type LlmEnhancedChecklistStatus = 'passed' | 'failed' | 'unknown' | 'degraded' | 'not_applicable';
export type RuntimeStandardNodeKind = 'workflow' | 'hardRule' | 'completion' | 'artifact' | 'stage';
export type RuntimeSignalType =
  | 'tool_name'
  | 'tool_input'
  | 'tool_output'
  | 'assistant_text'
  | 'user_text'
  | 'artifact_kind'
  | 'artifact_path'
  | 'event_kind';
export type RuntimeSignalOp = 'equals' | 'contains' | 'any_of' | 'fuzzy_contains' | 'suffix' | 'glob';
export type RuntimeNodeVerdict = 'passed' | 'missed' | 'violated' | 'unknown' | 'degraded';
export type RuntimeTriggerWindowScope =
  | 'same_node'
  | 'same_skill_segment'
  | 'same_session_after'
  | 'anywhere_in_session';

export interface RuntimeSignal {
  id: string;
  type: RuntimeSignalType;
  value: string | string[];
  op?: RuntimeSignalOp;
}

export interface RuntimeSignalRef {
  signalGroup: 'expectedSignals' | 'failureSignals' | 'forbiddenSignals' | 'conditionSignals';
  signalId: string;
}

export interface RuntimeTrigger {
  when?: RuntimeSignalRef;
  absence?: RuntimeSignalRef;
  forbidden?: RuntimeSignalRef;
  required?: RuntimeSignalRef;
  verdict: RuntimeNodeVerdict;
  windowScope: RuntimeTriggerWindowScope;
}

export interface RuntimeStandardNodeSourceHint {
  source: 'skill_md' | 'frontmatter' | 'llm_inferred' | 'template';
  line?: number;
  snippet: string;
}

export interface RuntimeStandardNode {
  nodeId: string;
  nodeEvidenceRef?: string;
  nodeKind: RuntimeStandardNodeKind;
  title: string;
  description?: string;
  childNodeIds?: string[];
  expectedSignals: RuntimeSignal[];
  failureSignals: RuntimeSignal[];
  forbiddenSignals: RuntimeSignal[];
  conditionSignals: RuntimeSignal[];
  triggers: RuntimeTrigger[];
  sourceHints: RuntimeStandardNodeSourceHint[];
}

export interface RuntimeMatchedSignal {
  signalId: string;
  signalType: RuntimeSignalType;
  signalGroup: RuntimeSignalRef['signalGroup'];
  evidenceRefs: SkillRuntimeEvidencePackRef[];
}

export interface RuntimeNodeResult {
  nodeId: string;
  nodeKind: RuntimeStandardNodeKind;
  title: string;
  status: RuntimeNodeVerdict;
  matchedSignals: RuntimeMatchedSignal[];
  evidenceRefs: SkillRuntimeEvidencePackRef[];
  reason: string;
}

export interface SkillLlmTypeSpecificChecklistItem {
  key: string;
  label: string;
  status: LlmEnhancedChecklistStatus;
  reason?: string;
  evidence?: string[];
  suggestionKey?: string;
}

export interface SkillLlmRuntimeNodeAssessment {
  nodeId: string;
  nodeKind: 'workflowNode' | 'hardRule';
  status: LlmEnhancedChecklistStatus;
  reason?: string;
  evidence?: string[];
  suggestionKey?: string;
}

export interface SkillLlmEnhancedReviewSections {
  skillType?: LlmEnhancedSkillType;
  extractedStandards?: {
    hardrules: Array<Omit<SkillDerivedStandard, 'id' | 'standardKind' | 'status' | 'source'>>;
    workflows: Array<Omit<SkillDerivedStandard, 'id' | 'standardKind' | 'status' | 'source'>>;
    completionCriteria: Array<Omit<SkillDerivedStandard, 'id' | 'standardKind' | 'status' | 'source'>>;
    artifactCriteria: Array<Omit<SkillDerivedStandard, 'id' | 'standardKind' | 'status' | 'source'>>;
    standardNodes?: RuntimeStandardNode[];
  };
  userGoal?: {
    summary?: string;
    slots: string[];
    expectedOutcome?: string;
  };
  skillDeclaredGoal?: {
    summary?: string;
    keywords: string[];
    expectedOutcomes: string[];
  };
  runtimeAssessment?: {
    goalSatisfaction?: LlmEnhancedVerdict;
    declaredBehaviorFit?: LlmEnhancedVerdict;
    artifactGoalMatch?: LlmEnhancedVerdict;
    userFeeling?: LlmEnhancedUserFeeling;
  };
  typeSpecificAssessment?: {
    checklist: SkillLlmTypeSpecificChecklistItem[];
    summary?: string;
  };
  /** Kept only so older persisted reports with LLM node verdicts can still be read. */
  runtimeNodeAssessment?: {
    summary?: string;
    nodes: SkillLlmRuntimeNodeAssessment[];
  };
  runtimeNodeResults?: {
    summary?: string;
    nodes: RuntimeNodeResult[];
  };
  userExperienceSignals?: {
    useful?: LlmEnhancedVerdict;
    followUp?: LlmEnhancedVerdict;
    correction?: LlmEnhancedVerdict;
    negativeFeedback?: LlmEnhancedVerdict;
    interruption?: LlmEnhancedVerdict;
    frustration?: LlmEnhancedVerdict;
  };
  reviewerSummary?: string;
  ownerSuggestions?: Array<{
    title?: string;
    body?: string;
    evidence?: string[];
    acceptanceCriteria?: string;
    checklistItemKey?: string;
  }>;
}

export type ResolvedSkillStandardSource = 'frontmatter' | 'confirmed_soft' | 'pending_soft';
export type ResolvedSkillStandardKind = 'hard_rule' | 'workflow';

export interface ResolvedSkillStandard {
  id: string;
  standardKind: ResolvedSkillStandardKind;
  title: string;
  body: string;
  source: ResolvedSkillStandardSource;
  status?: SkillDerivedStandardStatus;
  confidence?: SkillDerivedStandard['confidence'];
  evidence?: string[];
}

export interface ResolvedSkillStandards {
  skillName: string;
  active: ResolvedSkillStandard[];
  candidates: ResolvedSkillStandard[];
  sourcePriority: ['frontmatter', 'confirmed_soft', 'pending_soft'];
}

export interface ExtractSkillSoftStandardsOptions {
  observationsDir: string;
  skillChain: ObservationSkillChain;
  runtimeEvidence?: SkillLlmEnhancedRuntimeEvidence;
  model: string;
  executorName: string;
  refresh?: boolean;
  now?: string;
  executor?: ExecutorFn;
}

export interface ResolveSkillStandardsOptions {
  observationsDir: string;
  cwd?: string;
  skillChain?: ObservationSkillChain;
  derivedStandards?: SkillDerivedStandards | Record<string, SkillDerivedStandards>;
}
