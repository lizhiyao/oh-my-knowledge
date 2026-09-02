import type { SkillHardRule, SkillWorkflow } from '../../knowledge-artifacts/skills/contracts.js';
import type { ExperienceEvidenceRef } from './experience.js';
import type { SkillChainAdvisoryCode } from './skill-chain-advisories.js';

export type ObservationRuntimeCheckStatus = 'passed' | 'attention' | 'manual_review';

export interface ObservationRuntimeCheck {
  nodeKind: 'hardRule' | 'workflowNode';
  id: string;
  title: string;
  expectation: string;
  status: ObservationRuntimeCheckStatus;
  reason: string;
  evidenceCount: number;
  evidenceSnippets: string[];
}

export type SkillRuntimeEvidencePackSourceType =
  | 'tool_call'
  | 'tool_result'
  | 'assistant_message'
  | 'user_feedback'
  | 'artifact'
  | 'runtime_context'
  | 'skill_context'
  | 'unknown';

export interface SkillRuntimeEvidencePackRef extends Pick<ExperienceEvidenceRef,
  'id' | 'kind' | 'sourceTrace' | 'sessionId' | 'messageUuid' | 'messageIndex' | 'logicalMessageIndex' | 'sourceLineIndex' | 'callInstanceId' | 'toolUseId' | 'timestamp' | 'role' | 'label' | 'snippet'
> {
  sourceType: SkillRuntimeEvidencePackSourceType;
  toolName?: string;
  isError?: boolean;
}

export interface SkillRuntimeEvidencePackNode {
  nodeId: string;
  nodeKind: 'workflowNode' | 'hardRule';
  title: string;
  expectation: string;
  deterministicStatus: ObservationRuntimeCheckStatus;
  deterministicReason: string;
  candidateEvidenceRefs: SkillRuntimeEvidencePackRef[];
  candidateEvidenceSnippets: string[];
}

export interface SkillRuntimeEvidencePack {
  schemaVersion: 1;
  skillName: string;
  generatedBy: 'deterministic_rule_pack';
  definition: {
    found: boolean;
    path?: string;
    truncated?: boolean;
  };
  declaredStandards: {
    hardRules: Array<{ id: string; title: string; expectation: string; source: 'frontmatter' }>;
    workflowNodes: Array<{ id: string; title: string; expectation: string; workflowId: string; source: 'frontmatter' | 'markdown_headings' }>;
  };
  runtimeEvidence: {
    toolCalls: SkillRuntimeEvidencePackRef[];
    assistantMessages: SkillRuntimeEvidencePackRef[];
    userFeedback: SkillRuntimeEvidencePackRef[];
    artifacts: SkillRuntimeEvidencePackRef[];
  };
  nodeEvidence: SkillRuntimeEvidencePackNode[];
  evidenceQuality: {
    pollutedSourceCount: number;
    windowTooNarrow: boolean;
    missingRuntimeEvidence: boolean;
    notes: string[];
  };
}

export interface ObservationSkillChain {
  skillName: string;
  definition: {
    found: boolean;
    path?: string;
    content?: string;
    truncated?: boolean;
  };
  healthCheck: {
    source: 'doctor-static-rules';
    hardRules: {
      declared: boolean;
      valid: boolean;
      count: number;
      rules: SkillHardRule[];
      errors: string[];
      advisoryCode?: SkillChainAdvisoryCode;
    };
    workflows: {
      declared: boolean;
      valid: boolean;
      branchCount: number;
      nodeCount: number;
      workflows: SkillWorkflow[];
      errors: string[];
      source: 'frontmatter' | 'markdown_headings' | 'none';
      advisoryCode?: SkillChainAdvisoryCode;
    };
  };
  runtime: {
    supported: true;
    mode: 'deterministic-no-llm';
    message: string;
    summary: {
      invocationCount: number;
      toolCallCount: number;
      toolFailureCount: number;
      passedCount: number;
      attentionCount: number;
      manualReviewCount: number;
    };
    hardRules: ObservationRuntimeCheck[];
    workflowNodes: ObservationRuntimeCheck[];
    evidencePack?: SkillRuntimeEvidencePack;
  };
}
