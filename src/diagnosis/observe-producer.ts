import { buildObservationSkillChains, type ObservationRuntimeCheck, type ObservationSkillChain } from '../observability/skill-chain.js';
import { getSkillChainAdvisory, resolveAdvisoryCommand } from '../observability/skill-chain-advisories.js';
import type { ObservationInboxReport } from '../observability/inbox.js';
import type {
  ExperienceEvidenceRef,
  ExperienceRuleFinding,
  ExperienceSkillSummary,
  ObservationExperienceReport,
} from '../observability/experience.js';
import type { ExperienceProblemPattern } from '../observability/problem-patterns.js';
import { buildObserveDiagnostics, type ExperienceReviewerReportFindingSource } from './observe-mapper.js';
import type { DiagnosisBundle, DiagnosisEvidenceRef } from './types.js';

export interface BuildObserveDiagnosticsFromReportOptions {
  cwd?: string;
  skillChains?: Record<string, ObservationSkillChain>;
}

export function buildObserveDiagnosticsFromReport(
  report: ObservationInboxReport,
  options: BuildObserveDiagnosticsFromReportOptions = {},
): DiagnosisBundle {
  const experienceReports = report.experience ? [report.experience] : [];
  const skillNames = skillNamesFromReport(report);
  const chains = options.skillChains ?? buildObservationSkillChains(skillNames, options.cwd ?? process.cwd(), experienceReports);
  return buildObserveDiagnostics({
    generatedAt: report.meta.generatedAt,
    skillChainAdvisories: Object.values(chains).flatMap(chainAdvisories),
    runtimeChecks: Object.values(chains).flatMap(chainRuntimeChecks),
    problemPatterns: experienceReports.flatMap(experienceProblemPatterns),
    reviewerFindings: experienceReports.flatMap(experienceRuleFindings),
    derivedStandards: [],
  });
}

function skillNamesFromReport(report: ObservationInboxReport): string[] {
  return Array.from(new Set([
    ...Object.keys(report.meta.skillInvocationCounts ?? {}),
    ...Object.keys(report.meta.skillSessionCounts ?? {}),
    ...report.items.map((item) => item.skillName),
    ...(report.experience?.skills.map((skill) => skill.skillName) ?? []),
  ].filter(Boolean))).sort();
}

function chainAdvisories(chain: ObservationSkillChain) {
  if (!chain.definition.found) {
    const advisory = getSkillChainAdvisory('skill_md_not_found');
    return [{
      skillName: chain.skillName,
      code: advisory.code,
      message: advisory.message,
      exampleYaml: advisory.exampleYaml,
      commandTemplate: resolveAdvisoryCommand(advisory, chain.skillName),
      sourceId: `skill_chain:${chain.skillName}:${advisory.code}`,
    }];
  }

  return [
    chain.healthCheck.hardRules.advisoryCode,
    chain.healthCheck.workflows.advisoryCode,
  ].filter((code): code is NonNullable<typeof code> => Boolean(code)).map((code) => {
    const advisory = getSkillChainAdvisory(code);
    return {
      skillName: chain.skillName,
      code: advisory.code,
      message: advisory.message,
      exampleYaml: advisory.exampleYaml,
      commandTemplate: resolveAdvisoryCommand(advisory, chain.skillName),
      sourceId: `skill_chain:${chain.skillName}:${advisory.code}`,
    };
  });
}

function chainRuntimeChecks(chain: ObservationSkillChain) {
  return [...chain.runtime.hardRules, ...chain.runtime.workflowNodes]
    .filter((check) => check.status !== 'passed')
    .map((check) => ({
      skillName: chain.skillName,
      id: check.id,
      kind: check.kind,
      status: check.status,
      title: check.title,
      expectation: check.expectation,
      reason: check.reason,
      evidenceSnippets: check.evidenceSnippets,
      evidenceRefs: evidenceRefsFromRuntimeCheck(check, chain.skillName),
    }));
}

function evidenceRefsFromRuntimeCheck(check: ObservationRuntimeCheck, skillName: string): DiagnosisEvidenceRef[] {
  return (check.evidenceSnippets ?? []).map((snippet, index) => ({
    id: `runtime:${skillName}:${check.kind}:${check.id}:${index}`,
    kind: check.kind,
    label: check.title,
    snippet,
  }));
}

function experienceProblemPatterns(report: ObservationExperienceReport) {
  return report.skills.flatMap((skill) =>
    skill.problemPatterns.map((pattern) => ({
      skillName: skill.skillName,
      bucket: pattern.bucket,
      patternKey: pattern.patternKey,
      signalTypes: pattern.signalTypes,
      count: pattern.count,
      sessionCount: pattern.sessionCount,
      recentSessionIds: pattern.recentSessionIds,
      evidenceRefs: pattern.evidenceRefs.map(evidenceRef),
      lastSeen: pattern.lastSeen,
    }))
  );
}

function experienceRuleFindings(report: ObservationExperienceReport): ExperienceReviewerReportFindingSource[] {
  return report.skills.flatMap((skill) =>
    skill.ruleFindings
      .filter((finding) => finding.level !== 'normal' || finding.code === 'no_priority_signal')
      .map((finding) => ruleFindingSource(skill, finding))
  );
}

function ruleFindingSource(
  skill: ExperienceSkillSummary,
  finding: ExperienceRuleFinding,
): ExperienceReviewerReportFindingSource {
  return {
    skillName: skill.skillName,
    id: `rule_finding:${skill.skillName}:${finding.code}`,
    source: 'deterministic_rule',
    level: finding.level,
    title: titleForRuleFinding(finding.code),
    body: `Detected ${finding.count} occurrence(s) for ${finding.code}.`,
    ruleSource: finding.code,
    targetKey: `experience_rule:${finding.code}`,
    evidenceRefs: finding.evidenceRefs.map(evidenceRef),
  };
}

function titleForRuleFinding(code: ExperienceRuleFinding['code']): string {
  const titles: Record<ExperienceRuleFinding['code'], string> = {
    high_observation_seen: 'High-priority observation seen',
    medium_observation_seen: 'Medium-priority observation seen',
    user_correction_seen: 'User correction seen',
    user_interruption_seen: 'User interruption seen',
    negative_feedback_seen: 'Negative feedback seen',
    positive_feedback_seen: 'Positive feedback seen',
    user_goal_shift_seen: 'User goal shift seen',
    hard_rule_seen: 'User hard rule seen',
    tool_failure_seen: 'Tool failure seen',
    hedging_seen: 'Hedging signal seen',
    explicit_marker_seen: 'Explicit gap marker seen',
    runtime_context_excluded: 'Runtime context excluded',
    skill_context_excluded: 'Skill context excluded',
    no_priority_signal: 'No priority signal',
  };
  return titles[code];
}

function evidenceRef(ref: ExperienceEvidenceRef | ExperienceProblemPattern['evidenceRefs'][number]): DiagnosisEvidenceRef {
  return {
    id: ref.id,
    kind: ref.kind,
    sourceTrace: ref.sourceTrace,
    sessionId: ref.sessionId,
    messageIndex: ref.messageIndex,
    messageUuid: ref.messageUuid,
    toolUseId: ref.toolUseId,
    timestamp: ref.timestamp,
    label: ref.label,
    snippet: ref.snippet,
  };
}
