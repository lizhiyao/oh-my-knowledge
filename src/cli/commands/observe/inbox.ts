import { resolve } from 'node:path';
import { Flags } from '@oclif/core';
import { BaseCommand } from '../../oclif/base-command.js';
import { bilingual } from '../../oclif/i18n.js';
import { type CliLang } from '../../lib/i18n.js';
import type { ObserveInboxArgs, ObserveInboxFlags } from '../../lib/cmd-flags.js';

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
  const { queryObservationInbox, selectExploreInboxItems, loadLatestObservationInboxReports, summarizeObservationInboxBySkill, DEFAULT_OBSERVATIONS_DIR } = await import('../../../observability/inbox.js');
  const dir = resolve(flags['input-dir'] || DEFAULT_OBSERVATIONS_DIR);
  let items = queryObservationInbox(dir);
  if (flags.skill) {
    items = items.filter((item) => item.skillName === flags.skill);
  }
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
}

export default class ObserveInbox extends BaseCommand {
  static description = bilingual({
    zh: '查询 observation inbox(skill 调用洞察）。',
    en: 'Query observation inbox (skill invocation insights).',
  });

  static flags = {
    lang: Flags.string({
      description: bilingual({ zh: '输出语言 zh|en', en: 'Output language zh|en' }),
      default: 'zh',
    }),
    'input-dir': Flags.string({
      description: bilingual({
        zh: 'inbox 数据目录，默认 .omk/observations（项目级，相对于 cwd）；目录不存在时兜底读 ~/.oh-my-knowledge/observations。',
        en: 'Inbox data dir, default .omk/observations (project-local); falls back to ~/.oh-my-knowledge/observations when missing.',
      }),
    }),
    skill: Flags.string({
      description: bilingual({ zh: '只看指定 skill', en: 'Filter to specific skill' }),
    }),
    limit: Flags.string({
      description: bilingual({ zh: '限制条数，默认 20', en: 'Result limit, default 20' }),
    }),
    explore: Flags.string({
      description: bilingual({
        zh: '抽样 N 条 medium/low 长尾（replaces limit）',
        en: 'Sample N medium/low long-tail items (replaces limit)',
      }),
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
