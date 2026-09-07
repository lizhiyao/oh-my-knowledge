import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ExperienceEvidenceChain, ExperienceRuleFinding, ExperienceAssistiveInference, ExperienceChecklistItem } from '../../src/observability/contracts/experience.js';
import { isExperienceEvidenceChain, isExperienceRuleFinding, isExperienceAssistiveInference, isExperienceChecklistItem } from '../../src/observability/experience/report-value-guards.js';
import type { ExperienceEvidenceRef } from '../../src/observability/contracts/experience.js';
import type { ExperienceRuleFindingCode } from '../../src/observability/contracts/experience.js';
import type { ExperienceRuleFindingLevel } from '../../src/observability/contracts/experience.js';
import type { ExperienceAssistiveInferenceCode } from '../../src/observability/contracts/experience.js';
import type { ExperienceAssistiveInferenceConfidence } from '../../src/observability/contracts/experience.js';
import type { ExperienceAssistiveInferenceCautionCode } from '../../src/observability/contracts/experience.js';
import type { ExperienceChecklistItemStatus } from '../../src/observability/contracts/experience.js';
import type { ExperienceChecklistContribution } from '../../src/observability/contracts/experience.js';
import type { ExperienceReviewerReportFindingSource } from '../../src/observability/contracts/experience.js';

// Frozen pre-schema structural contracts.
interface LegacyExperienceEvidenceChain {
  userMessageCount: number;
  runtimeContextCount: number;
  skillContextCount: number;
  assistantMessageCount: number;
  toolUseCount: number;
  toolResultCount: number;
  toolFailureResultCount: number;
  observationCount: number;
  firstUserMessage?: ExperienceEvidenceRef;
  firstRuntimeContext?: ExperienceEvidenceRef;
  firstSkillContext?: ExperienceEvidenceRef;
  firstToolUse?: ExperienceEvidenceRef;
  firstToolFailure?: ExperienceEvidenceRef;
  lastAssistantMessage?: ExperienceEvidenceRef;
}

interface LegacyExperienceRuleFinding {
  code: ExperienceRuleFindingCode;
  level: ExperienceRuleFindingLevel;
  count: number;
  evidenceRefs: ExperienceEvidenceRef[];
}

interface LegacyExperienceAssistiveInference {
  mode: 'deterministic_rules_only';
  code: ExperienceAssistiveInferenceCode;
  confidence: ExperienceAssistiveInferenceConfidence;
  basisRuleCodes: ExperienceRuleFindingCode[];
  cautionCodes: ExperienceAssistiveInferenceCautionCode[];
  evidenceRefs: ExperienceEvidenceRef[];
}

interface LegacyExperienceChecklistItem {
  key: string;
  label: string;
  status: ExperienceChecklistItemStatus;
  contribution: ExperienceChecklistContribution;
  reason: string;
  evidenceRefs: ExperienceEvidenceRef[];
  source: ExperienceReviewerReportFindingSource;
  suggestionKey?: string;
}

const cases = [
  ['chain', isExperienceEvidenceChain, { userMessageCount: 0, runtimeContextCount: 0, skillContextCount: 0, assistantMessageCount: 0, toolUseCount: 0, toolResultCount: 0, toolFailureResultCount: 0, observationCount: 0 }],
  ['finding', isExperienceRuleFinding, { code: 'no_priority_signal', level: 'normal', count: 0, evidenceRefs: [] }],
  ['inference', isExperienceAssistiveInference, { mode: 'deterministic_rules_only', code: 'no_obvious_issue_from_rules', confidence: 'low', basisRuleCodes: [], cautionCodes: [], evidenceRefs: [] }],
  ['checklist', isExperienceChecklistItem, { key: 'item', label: '', status: 'unknown', contribution: 'neutral', reason: '', source: 'deterministic_rule', evidenceRefs: [] }],
] as const;

describe('Experience review structures', () => {
  it('preserves the frozen structural types', () => {
    expectTypeOf<ExperienceEvidenceChain>().toEqualTypeOf<LegacyExperienceEvidenceChain>();
    expectTypeOf<ExperienceRuleFinding>().toEqualTypeOf<LegacyExperienceRuleFinding>();
    expectTypeOf<ExperienceAssistiveInference>().toEqualTypeOf<LegacyExperienceAssistiveInference>();
    expectTypeOf<ExperienceChecklistItem>().toEqualTypeOf<LegacyExperienceChecklistItem>();
  });
  it.each(cases)('%s accepts its required shape and extra fields', (_name, guard, base) => {
    expect(guard(base)).toBe(true);
    expect(guard({ ...base, extension: { untouched: true } })).toBe(true);
    for (const key of Object.keys(base)) {
      const value: Record<string, unknown> = { ...base };
      delete value[key];
      expect(guard(value)).toBe(false);
    }
  });
  it.each(cases)('%s preserves nested evidence timestamp checks', (name, guard, base) => {
    const ref = { id: 'ref', kind: 'tool_use', sourceTrace: 'trace', sessionId: 'session', timestamp: '2026-09-07T00:00:00Z' };
    const field = name === 'chain' ? 'firstUserMessage' : 'evidenceRefs';
    expect(guard({ ...base, [field]: name === 'chain' ? ref : [ref] })).toBe(true);
    const invalid = { ...ref, timestamp: 'invalid' };
    expect(guard({ ...base, [field]: name === 'chain' ? invalid : [invalid] })).toBe(false);
  });
});
