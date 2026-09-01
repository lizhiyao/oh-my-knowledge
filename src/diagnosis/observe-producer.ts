import { buildObservationSkillChain, buildObservationSkillChains, type ObservationRuntimeCheck, type ObservationSkillChain } from '../observability/skill-chain.js';
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
import type { DiagnosisBundle, DiagnosisEvidenceRef } from './contracts.js';
import { setOwnRecordValue } from '../shared/record-count.js';

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
  const chains = resolveSkillChains(report, skillNames, experienceReports, options);
  return buildObserveDiagnostics({
    generatedAt: report.meta.generatedAt,
    skillChainAdvisories: Object.values(chains).flatMap(chainAdvisories),
    runtimeChecks: Object.values(chains).flatMap(chainRuntimeChecks),
    problemPatterns: experienceReports.flatMap(experienceProblemPatterns),
    reviewerFindings: experienceReports.flatMap(experienceRuleFindings),
    derivedStandards: [],
  });
}

function resolveSkillChains(
  report: ObservationInboxReport,
  skillNames: string[],
  experienceReports: ObservationExperienceReport[],
  options: BuildObserveDiagnosticsFromReportOptions,
): Record<string, ObservationSkillChain> {
  // 调用方显式传 skillChains(测试 mock)或 cwd(已知项目根)时直接用。
  // 否则按 skill 推断 cwd:
  //   - 该 skill 的所有 inbox items 只出现 1 个 cwd → 用它构建 chain
  //   - 多个 cwd 或完全没有 cwd 信息 → 跳过该 skill 的 chain 构建
  //
  // 跳过比 fallback 到 process.cwd() 安全:跨项目 `omk observe ingest /path/to/B-traces`
  // 时 process.cwd() 找不到 SKILL.md 会产生 `skill_md_not_found` 假阳性,而且这条 advisory
  // 会被 build 路径持久化进 inbox JSON,后续 Studio 读取时已无从分辨是 cwd 漂移导致的误报。
  // 跳过的语义是「没把握判断,不发 advisory」,problemPatterns / reviewerFindings 仍正常工作。
  if (options.skillChains) return options.skillChains;
  if (options.cwd) return buildObservationSkillChains(skillNames, options.cwd, experienceReports);
  const cwdBySkill = inferCwdBySkill(report);
  const chains: Record<string, ObservationSkillChain> = {};
  for (const skillName of skillNames) {
    const cwd = cwdBySkill.get(skillName);
    if (cwd) {
      setOwnRecordValue(
        chains,
        skillName,
        buildObservationSkillChain(skillName, cwd, experienceReports),
      );
    }
  }
  return chains;
}

/** 按 skill 从 inbox items + experience 聚合 cwd。返回:单一 cwd 字符串 / null(多 cwd,跳过 chain)。
 *
 *  数据源优先级一致(同等聚合 set,不分先后):
 *    - report.items[].cwd:有 observation signal 的 skill 调用
 *    - report.experience.invocations[].cwd:所有 skill 调用(干净运行也有,items 可能为空)
 *    - report.experience.goalSlices[].cwd:goal slice 级 cwd
 *
 *  「items 为空但 experience 有 cwd」是真实 build 路径的常见态(skill 跑得很干净没产生 signal,
 *  但仍要看 SKILL.md 结构),只看 items 会漏整个 chain advisory + runtime check。 */
function inferCwdBySkill(report: ObservationInboxReport): Map<string, string | null> {
  const cwdsBySkill = new Map<string, Set<string>>();
  const addCwd = (skillName: string | undefined | null, cwd: string | undefined): void => {
    if (!skillName || !cwd) return;
    if (!cwdsBySkill.has(skillName)) cwdsBySkill.set(skillName, new Set());
    cwdsBySkill.get(skillName)!.add(cwd);
  };
  for (const item of report.items) {
    addCwd(item.skillName, item.cwd);
  }
  for (const invocation of report.experience?.invocations ?? []) {
    addCwd(invocation.skillName, invocation.cwd);
  }
  for (const slice of report.experience?.goalSlices ?? []) {
    addCwd(slice.skillName, slice.cwd);
  }
  const out = new Map<string, string | null>();
  for (const [skill, set] of cwdsBySkill) {
    out.set(skill, set.size === 1 ? Array.from(set)[0] : null);
  }
  return out;
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
      nodeKind: check.nodeKind,
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
    id: `runtime:${skillName}:${check.nodeKind}:${check.id}:${index}`,
    kind: check.nodeKind,
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
    session_interrupted_seen: 'Session interruption seen',
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
    traceId: ref.traceId,
    sourceTrace: ref.sourceTrace,
    sessionId: ref.sessionId,
    messageIndex: ref.messageIndex,
    logicalMessageIndex: 'logicalMessageIndex' in ref ? ref.logicalMessageIndex : undefined,
    sourceLineIndex: 'sourceLineIndex' in ref ? ref.sourceLineIndex : undefined,
    messageUuid: ref.messageUuid,
    toolUseId: ref.toolUseId,
    timestamp: ref.timestamp,
    label: ref.label,
    snippet: ref.snippet,
  };
}
