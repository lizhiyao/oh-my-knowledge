import { resolve } from 'node:path';
import { Flags } from '@oclif/core';
import { BaseCommand } from '../../oclif/base-command.js';
import { LANG_FLAG, bilingual } from '../../oclif/i18n.js';
import { integerStringParser } from '../../oclif/parsers.js';
import { type CliLang } from '../../lib/i18n.js';
import { resolveRuntimeSelection } from '../../lib/runtime-defaults.js';
import type { ObserveInboxArgs, ObserveInboxFlags } from '../../lib/cmd-flags.js';
import type { ObservationInboxViewModel } from '../../../observability/inbox-view-model.js';
import type { ExperienceTimelineEvent } from '../../../observability/experience.js';
import type { SkillLlmEnhancedRuntimeEvidence } from '../../../observability/soft-standards/index.js';
import { shellQuoteArg } from '../../../shared/shell-quote.js';

function pickSkillCount(value: Record<string, number> | undefined, skillName: string): Record<string, number> | undefined {
  if (!value || value[skillName] == null) return undefined;
  return { [skillName]: value[skillName] };
}

function pickSkillString(value: Record<string, string> | undefined, skillName: string): Record<string, string> | undefined {
  if (!value || value[skillName] == null) return undefined;
  return { [skillName]: value[skillName] };
}

function pickSkillToolCounts(value: Record<string, Record<string, number>> | undefined, skillName: string): Record<string, Record<string, number>> | undefined {
  if (!value || value[skillName] == null) return undefined;
  return { [skillName]: value[skillName] };
}

// runObserveInbox export:test/cli/observe.test.ts in-process import 验证 by-skill 聚合行为。
export async function runObserveInbox(
  _args: ObserveInboxArgs,
  flags: ObserveInboxFlags,
  lang: CliLang,
): Promise<void> {
  const { queryObservationInbox, selectExploreInboxItems, loadLatestObservationInboxReports, summarizeObservationInboxBySkill, DEFAULT_OBSERVATIONS_DIR, DEFAULT_GLOBAL_OBSERVATIONS_DIR } = await import('../../../observability/inbox.js');
  // 显式 --input-dir 最高;否则 --global 直读全局、默认读项目(空则 loadObservationInboxReports 兜底全局)。
  const dir = flags['input-dir']
    ? resolve(flags['input-dir'])
    : (flags.global ? DEFAULT_GLOBAL_OBSERVATIONS_DIR : DEFAULT_OBSERVATIONS_DIR);
  if (flags['llm-enhanced-review']) {
    const { buildObservationInboxViewModel } = await import('../../../observability/inbox-view-model.js');
    const { extractSkillSoftStandards } = await import('../../../observability/soft-standards/index.js');
    const view = buildObservationInboxViewModel(dir, { skill: flags.skill });
    const candidates = Object.values(view.skillChains)
      .map((chain) => ({ chain, runtimeEvidence: buildLlmEnhancedRuntimeEvidence(view, chain.skillName) }))
      .filter(({ runtimeEvidence }) => hasLlmEnhancedRuntimeEvidence(runtimeEvidence));
    if (candidates.length === 0) {
      if (flags.json) {
        console.log(JSON.stringify({ kind: 'observe-llm-enhanced-review', records: [] }, null, 2));
      } else {
        console.log(lang === 'zh' ? '没有可用于 LLM 增强复盘的运行证据' : 'No runtime evidence is available for LLM enhanced review');
      }
      return;
    }
    const runtime = resolveRuntimeSelection(
      { executor: flags.executor, model: flags.model },
      { lang },
    );
    const records = [];
    for (const { chain, runtimeEvidence } of candidates) {
      records.push(await extractSkillSoftStandards({
        observationsDir: dir,
        skillChain: chain,
        runtimeEvidence,
        model: runtime.model,
        executorName: runtime.executor,
        refresh: flags.refresh,
      }));
    }
    if (flags.json) {
      console.log(JSON.stringify({ kind: 'observe-llm-enhanced-review', records }, null, 2));
      return;
    }
    console.log(lang === 'zh' ? 'LLM 增强复盘已生成:' : 'LLM enhanced review generated:');
    for (const record of records) {
      console.log(`- ${record.skillName} standards=${record.standards.length} model=${record.model} prompt=${record.promptId}/${record.promptVersion}`);
    }
    return;
  }
  let items = queryObservationInbox(dir);
  if (flags.skill) {
    items = items.filter((item) => item.skillName === flags.skill);
  }
  const recyclableCount = items.filter((item) => item.severity !== 'noise').length;
  const sampleCommandBase = `omk sample --from-traces --observations-dir ${shellQuoteArg(dir)}`;
  const sampleCommand = flags.skill
    ? `${sampleCommandBase} --skill ${shellQuoteArg(flags.skill)}`
    : sampleCommandBase;
  if (flags['by-skill']) {
    const reports = flags.skill
      ? loadLatestObservationInboxReports(dir).map((report) => ({
        ...report,
        meta: {
          ...report.meta,
          skillInvocationCounts: pickSkillCount(report.meta.skillInvocationCounts, String(flags.skill)),
          skillSessionCounts: pickSkillCount(report.meta.skillSessionCounts, String(flags.skill)),
          skillInvocationLastSeen: pickSkillString(report.meta.skillInvocationLastSeen, String(flags.skill)),
          skillToolCallCounts: pickSkillToolCounts(report.meta.skillToolCallCounts, String(flags.skill)),
        },
      }))
      : loadLatestObservationInboxReports(dir);
    const rows = summarizeObservationInboxBySkill(items, reports);
    if (flags.json) {
      console.log(JSON.stringify({ kind: 'observe-inbox-by-skill', rows }, null, 2));
      return;
    }
    if (rows.length === 0) {
      console.log(lang === 'zh' ? 'observe inbox 为空' : 'observe inbox is empty');
      return;
    }
    console.log(lang === 'zh' ? 'observe inbox by skill:' : 'observe inbox by skill:');
    for (const row of rows) {
      console.log(`- ${row.skillName} invocations=${row.invocationCount} sessions=${row.sessionCount} processFindings=${row.observationCount} high=${row.highCount} medium=${row.mediumCount} low=${row.lowCount} noise=${row.noiseCount}${row.latestSeen ? ` latest=${row.latestSeen}` : ''}`);
    }
    if (recyclableCount > 0) {
      console.log(lang === 'zh'
        ? `提示：确认信号后生成回归用例草稿：${sampleCommand}`
        : `Tip: after confirming signals, draft regression samples: ${sampleCommand}`);
    }
    return;
  }
  if (flags.explore) {
    const n = Math.max(1, Number(flags.explore) || 10);
    items = selectExploreInboxItems(items, n, flags['include-noise']);
  } else {
    const limit = Math.max(1, Number(flags.limit ?? 20) || 20);
    items = items.slice(0, limit);
  }
  if (flags.json) {
    console.log(JSON.stringify({ kind: 'observe-inbox-query', items }, null, 2));
    return;
  }
  if (items.length === 0) {
    console.log(lang === 'zh' ? 'observe inbox 为空' : 'observe inbox is empty');
    return;
  }
  console.log(lang === 'zh' ? 'observe inbox:' : 'observe inbox:');
  for (const item of items) {
    const evidence = item.evidence.query || item.evidence.path || item.evidence.assistantSnippet || item.evidence.outputSnippet || '';
    const artifactVersion = item.artifactVersion === 'unknown' ? '⚠ unknown' : item.artifactVersion;
    console.log(`- [${item.severity}] (${item.sourceKind}) ${item.skillName} ${item.signalType}/${item.signalSubtype} x${item.occurrences} confidence=${item.confidence.toFixed(2)} attribution=${item.attributionConfidence.toFixed(2)}`);
    console.log(`  lastSeen=${item.lastSeen} version=${artifactVersion}`);
    console.log(`  reason=${item.severityReasonCode ?? 'unknown'}`);
    if (evidence) console.log(`  evidence=${evidence.slice(0, 180)}`);
  }
  console.log('');
  console.log(lang === 'zh'
    ? 'Tip: omk observe inbox --explore 10  # 抽样查看 medium/low 长尾'
    : 'Tip: omk observe inbox --explore 10  # sample medium/low long-tail items');
  console.log(lang === 'zh'
    ? 'Tip: omk observe inbox --explore 10 --include-noise  # 显式包含 noise 桶'
    : 'Tip: omk observe inbox --explore 10 --include-noise  # explicitly include the noise bucket');
  if (recyclableCount > 0) {
    console.log(lang === 'zh'
      ? `提示：确认高风险或抽样信号后生成回归用例草稿：${sampleCommand}`
      : `Tip: after confirming high-risk / sampled signals, draft regression samples: ${sampleCommand}`);
  }
}

function hasLlmEnhancedRuntimeEvidence(evidence: SkillLlmEnhancedRuntimeEvidence): boolean {
  return evidence.userMessages.length > 0
    || evidence.goalSlices.some((goal) => Boolean(goal.inferredUserGoal || goal.userMessages?.length))
    || evidence.assistantMessages.length > 0
    || evidence.artifactCandidates.length > 0
    || evidence.toolCalls.length > 0
    || evidence.findings.length > 0
    || Boolean(evidence.skillRuntimeEvidencePack?.nodeEvidence.length);
}

function cleanEvidenceText(value?: string): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, 800);
}

function eventText(event?: ExperienceTimelineEvent): string {
  return cleanEvidenceText(event?.snippet ?? event?.fullText);
}

function buildLlmEnhancedRuntimeEvidence(
  view: ObservationInboxViewModel,
  skillName: string,
): SkillLlmEnhancedRuntimeEvidence {
  const reports = view.experienceReports;
  const sessions = reports.flatMap((report) => report.sessions.filter((session) => session.skillName === skillName));
  const invocations = reports.flatMap((report) => report.invocations.filter((invocation) => invocation.skillName === skillName));
  const goalSlices = reports.flatMap((report) => report.goalSlices.filter((goal) => goal.skillName === skillName));
  const timeline = invocations.flatMap((invocation) => invocation.timeline ?? []);
  const userMessages = Array.from(new Set([
    ...goalSlices.flatMap((goal) => goal.userMessageRefs.map((ref) => cleanEvidenceText(ref.snippet))),
    ...sessions.map((session) => cleanEvidenceText(session.evidenceChain.firstUserMessage?.snippet)),
    ...timeline.filter((event) => event.kind === 'user_message').map(eventText),
  ].filter(Boolean))).slice(0, 12);
  const assistantMessages = Array.from(new Set([
    ...sessions.map((session) => cleanEvidenceText(session.evidenceChain.lastAssistantMessage?.snippet)),
    ...timeline.filter((event) => event.kind === 'assistant_message').map(eventText),
  ].filter(Boolean))).slice(0, 12);
  const artifactCandidates = Array.from(new Set(timeline
    .filter((event) => event.kind === 'assistant_message' && /(?:outputs\/runs|\.md\b|\.html\b|https?:\/\/|产物|文档|报告|方案路径|结果文件)/i.test(eventText(event)))
    .map(eventText)
    .filter(Boolean))).slice(0, 8);
  const toolCalls = Array.from(new Set(timeline
    .filter((event) => event.kind === 'tool_use')
    .map((event) => cleanEvidenceText(`${event.toolName ?? 'tool'} ${event.snippet ?? event.fullText ?? ''}`))
    .filter(Boolean))).slice(0, 12);
  const findings = Array.from(new Set(sessions.flatMap((session) => [
    ...(session.reviewerReport?.findings ?? []).map((finding) => cleanEvidenceText(`${finding.title}: ${finding.body}`)),
    ...(session.ruleFindings ?? []).map((finding) => finding.code),
  ]).filter(Boolean))).slice(0, 12);
  return {
    goalSlices: goalSlices.slice(0, 8).map((goal) => ({
      id: goal.id,
      sessionId: goal.sessionId,
      inferredUserGoal: cleanEvidenceText(goal.inferredUserGoal),
      userMessages: goal.userMessageRefs.map((ref) => cleanEvidenceText(ref.snippet)).filter(Boolean).slice(0, 5),
    })),
    userMessages,
    assistantMessages,
    artifactCandidates,
    toolCalls,
    findings,
    skillRuntimeEvidencePack: view.skillChains[skillName]?.runtime.evidencePack,
  };
}

export default class ObserveInbox extends BaseCommand {
  static description = bilingual({
    zh: '查询 observation inbox(skill 调用洞察）。',
    en: 'Query observation inbox (skill invocation insights).',
  });

  static flags = {
    lang: LANG_FLAG,
    'input-dir': Flags.string({
      description: bilingual({
        zh: 'inbox 数据目录，默认 .omk/observe-inbox（项目级，相对于 cwd）；目录不存在时兜底读 ~/.oh-my-knowledge/observe-inbox。',
        en: 'Inbox data dir, default .omk/observe-inbox (project-local); falls back to ~/.oh-my-knowledge/observe-inbox when missing.',
      }),
    }),
    global: Flags.boolean({
      description: bilingual({
        zh: '直接读取全局 ~/.oh-my-knowledge/observe-inbox（跳过项目级与兜底）。',
        en: 'Read directly from global ~/.oh-my-knowledge/observe-inbox (skip project-local and fallback).',
      }),
      default: false,
    }),
    skill: Flags.string({
      description: bilingual({ zh: '只看指定 skill', en: 'Filter to specific skill' }),
    }),
    limit: Flags.string({
      description: bilingual({ zh: '限制条数，默认 20', en: 'Result limit, default 20' }),
      parse: integerStringParser('--limit', { min: 1 }),
    }),
    explore: Flags.string({
      description: bilingual({
        zh: '抽样 N 条 medium/low 长尾（replaces limit）',
        en: 'Sample N medium/low long-tail items (replaces limit)',
      }),
      parse: integerStringParser('--explore', { min: 1 }),
    }),
    'include-noise': Flags.boolean({
      description: bilingual({
        zh: 'explore 时也包含 noise 桶',
        en: 'Include noise bucket in explore',
      }),
      default: false,
    }),
    'by-skill': Flags.boolean({
      description: bilingual({
        zh: '按 skill 聚合输出',
        en: 'Aggregate output by skill',
      }),
      default: false,
    }),
    'llm-enhanced-review': Flags.boolean({
      description: bilingual({
        zh: '显式调用模型进行链路增强复盘，包含标准抽取、目标判断、类型判断、产物匹配和 owner 建议',
        en: 'Explicitly run model-based enhanced chain review including standards, goals, skill type, artifact fit, and owner suggestions',
      }),
      default: false,
    }),
    refresh: Flags.boolean({
      description: bilingual({
        zh: '重新生成 LLM 增强复盘，不复用已有结果',
        en: 'Refresh LLM enhanced review instead of reusing existing records',
      }),
      default: false,
    }),
    model: Flags.string({
      description: bilingual({
        zh: 'LLM 增强复盘使用的模型。Codex 自动读取本机配置；也可用 OMK_MODEL 设置环境偏好。',
        en: 'Model for LLM enhanced review. Codex reads the local configured model; OMK_MODEL sets an environment preference.',
      }),
    }),
    executor: Flags.string({
      description: bilingual({
        zh: 'LLM 增强复盘使用的执行器。Codex 任务内自动用 codex；也可用 OMK_EXECUTOR 设置环境偏好。',
        en: 'Executor for LLM enhanced review. Defaults to codex inside Codex tasks; OMK_EXECUTOR sets an environment preference.',
      }),
    }),
    json: Flags.boolean({
      description: bilingual({ zh: 'JSON 格式输出', en: 'JSON output' }),
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ObserveInbox);
    const lang = this.lang;
    await this.runWithCliExit(async () => {
      await runObserveInbox(args as Record<string, never>, { ...flags, lang }, lang);
    });
  }
}
