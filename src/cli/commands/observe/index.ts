import { resolve } from 'node:path';
import { Args, Flags } from '@oclif/core';
import { LANG_FLAG, bilingual } from '../../oclif/i18n.js';
import { BaseCommand } from '../../oclif/base-command.js';
import { CliExit } from '../../lib/cli-exit.js';
import { tCli } from '../../lib/i18n.js';
import { sanitizeCell } from '../../lib/cell-format.js';
import { resolveObservationWindow } from '../../lib/observation-window.js';
import { projectObserveHealthDir, globalObserveHealthDir } from '../../../evidence/storage/directories.js';
import { persistObserveHealthReport } from '../../../observability/skill-health/persistence.js';

// `omk observe <sessions-dir>` 是默认命令 —— 分析 sessions 目录的 skill 调用健康度，产出 observe-health 报告(JSON)，
// 由 Studio 健康报告页按需渲染。observe 这条线的另一条产物是观测收件箱(observe-inbox)，走子命令 ingest / inbox / show。

export default class Observe extends BaseCommand {
  static description = bilingual({
    zh: '把 Codex、Claude Code、OpenClaw 或 markdown trace 统一为 Trace IR，分析 skill 调用健康度（默认行为）。子命令：ingest / inbox / show。',
    en: 'Normalize Codex, Claude Code, OpenClaw, or markdown traces into Trace IR and analyze skill invocation health (default). Subcommands: ingest / inbox / show.',
  });

  static examples = [
    {
      description: bilingual({
        zh: '分析最近 7 天的 Codex rollout',
        en: 'Analyze Codex rollouts from the last 7 days',
      }),
      command: '<%= config.bin %> observe ~/.codex/sessions --last 7d',
    },
  ];

  static args = {
    sessionsDir: Args.string({
      description: bilingual({
        zh: 'sessions 目录路径（如 ~/.codex/sessions 或 ~/.claude/projects/<project>）',
        en: 'Sessions dir path (e.g. ~/.codex/sessions or ~/.claude/projects/<project>)',
      }),
      required: false,
    }),
  };

  static flags = {
    lang: LANG_FLAG,
    kb: Flags.string({
      description: bilingual({ zh: '知识库 root，启用 KB-aware 分析', en: 'KB root, enables KB-aware analysis' }),
    }),
    last: Flags.string({
      description: bilingual({ zh: '时间窗(7d / 24h / 30m）', en: 'Time window (7d / 24h / 30m)' }),
    }),
    from: Flags.string({
      description: bilingual({ zh: '起始时间 ISO，优先级高于 --last', en: 'Start time ISO, overrides --last' }),
    }),
    to: Flags.string({
      description: bilingual({ zh: '结束时间 ISO', en: 'End time ISO' }),
    }),
    skills: Flags.string({
      description: bilingual({
        zh: '只看指定 skill，逗号分隔',
        en: 'Filter to specific skills, comma-separated',
      }),
    }),
    'output-dir': Flags.string({
      description: bilingual({
        zh: '健康报告输出目录，默认项目级 .omk/observe/health（--global 写全局）',
        en: 'Health report output dir, default project-level .omk/observe/health (--global for global)',
      }),
    }),
    global: Flags.boolean({
      description: bilingual({
        zh: '写全局 ~/.oh-my-knowledge/observe/health，而非项目 .omk/observe/health',
        en: 'Write to global ~/.oh-my-knowledge/observe/health instead of project .omk/observe/health',
      }),
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Observe);
    const lang = this.lang;
    await this.runWithCliExit(async () => {
      const dir = args.sessionsDir;
      if (!dir) {
        console.error(tCli('cli.help.observe', lang).trim());
        throw new CliExit(1);
      }
      const { from, to } = resolveObservationWindow(flags, lang);
      const tracePath = resolve(dir);

      const { existsSync } = await import('node:fs');
      if (!existsSync(tracePath)) {
        console.error(lang === 'zh' ? `轨迹路径不存在：${sanitizeCell(tracePath)}` : `Trace path does not exist: ${sanitizeCell(tracePath)}`);
        throw new CliExit(1);
      }

      const skills = flags.skills ? flags.skills.split(',').map((s) => s.trim()).filter(Boolean) : undefined;

      console.log(lang === 'zh' ? `[omk] 正在分析 ${sanitizeCell(tracePath)}…` : `[omk] analyzing ${sanitizeCell(tracePath)}...`);
      const { computeSkillHealthReport } = await import('../../../observability/skill-health/analyzer.js');
      const report = computeSkillHealthReport(tracePath, {
        kbRoot: flags.kb ? resolve(flags.kb) : undefined,
        from,
        to,
        skills,
      });

      // JSON 是主产物；HTML 由 report server 的健康报告详情页按需渲染。
      const outDir = flags['output-dir']
        ? resolve(flags['output-dir'])
        : (flags.global ? globalObserveHealthDir() : projectObserveHealthDir());
      const { jsonPath } = persistObserveHealthReport(report, outDir);
      const { traceIngestionNotices } = await import('../../../observability/trace/ingestion.js');
      for (const notice of traceIngestionNotices(report.meta.ingestion, lang)) {
        process.stderr.write(`${notice.text}\n`);
      }

      const {
        sessionCount,
        segmentCount,
        toolCallCount,
        toolFailureRate,
        toolResolvedCount = toolCallCount,
        toolCancelledCount = 0,
        toolUnknownCount = 0,
      } = report.meta;
      const toolComparableCount = Math.max(0, toolResolvedCount - toolCancelledCount);
      const labels = lang === 'zh'
        ? { failure: '失败率', unavailable: '不可用', cancelled: '已取消', unknown: '结果未知', comparable: '可比较', sessions: '会话', segments: '片段', calls: '工具调用', overall: '总体', gap: '缺口率', weighted: '加权缺口率', health: '健康状态', confidence: '置信度', skills: '主要知识项', coverage: '覆盖率', report: '报告已写入' }
        : { failure: 'fail rate', unavailable: 'unavailable', cancelled: 'cancelled', unknown: 'unknown outcomes', comparable: 'comparable', sessions: 'sessions', segments: 'segments', calls: 'tool calls', overall: 'overall', gap: 'gapRate', weighted: 'weightedGapRate', health: 'health', confidence: 'confidence', skills: 'top skills', coverage: 'coverage', report: 'report written to' };
      const confidenceLabel = (confidence: string): string => lang === 'zh'
        ? ({ high: '高', medium: '中', low: '低', underpowered: '样本不足' }[confidence] ?? confidence)
        : confidence;
      const bandLabel = lang === 'zh'
        ? ({ green: '绿', yellow: '黄', red: '红' }[report.overall.healthBand] ?? report.overall.healthBand)
        : report.overall.healthBand;
      const failureSummary = toolCallCount > 0 && toolComparableCount === 0
        ? `${labels.failure}: ${labels.unavailable}${toolCancelledCount > 0 ? ` · ${labels.cancelled}: ${toolCancelledCount}` : ''}${toolUnknownCount > 0 ? ` · ${labels.unknown}: ${toolUnknownCount}` : ''}`
        : `${labels.failure}: ${(toolFailureRate * 100).toFixed(1)}% (${toolComparableCount} ${labels.comparable}${toolCancelledCount > 0 ? ` · ${toolCancelledCount} ${labels.cancelled}` : ''})`;
      console.log('');
      console.log(`${labels.sessions}: ${sessionCount} · ${labels.segments}: ${segmentCount} · ${labels.calls}: ${toolCallCount} · ${failureSummary}`);
      const overallConf = report.overall.confidence;
      const confSuffix = overallConf === 'high' ? '' : lang === 'zh'
        ? ` · ⚠ ${labels.confidence}: ${confidenceLabel(overallConf)}（N=${segmentCount}，样本不足，分档仅供参考）`
        : ` · ⚠ confidence: ${overallConf} (N=${segmentCount} too small; band is indicative)`;
      console.log(`${labels.overall}: ${labels.gap} ${(report.overall.gapRate * 100).toFixed(1)}% · ${labels.weighted} ${(report.overall.weightedGapRate * 100).toFixed(1)}% · ${labels.health}: ${bandLabel}${confSuffix}`);
      console.log('');
      const skillRows = Object.values(report.bySkill)
        .sort((a, b) => b.segmentCount - a.segmentCount)
        .slice(0, 10)
        .map((s) => `  ${sanitizeCell(s.skillName).padEnd(24)} ${labels.segments}=${String(s.segmentCount).padStart(4)}  ${labels.gap}=${String(Math.round(s.gap.gapRate * 100) + '%').padStart(4)}  ${labels.weighted}=${String(Math.round(s.gap.weightedGapRate * 100) + '%').padStart(4)}${s.coverage ? `  ${labels.coverage}=${Math.round(s.coverage.fileCoverageRate * 100)}%` : ''}${s.confidence !== 'high' ? `  ⚠${confidenceLabel(s.confidence)}` : ''}`);
      console.log(`${labels.skills}:`);
      console.log(skillRows.join('\n'));
      console.log('');
      console.log(`${labels.report}: ${sanitizeCell(jsonPath)}`);
      console.log(tCli('cli.observe.view_hint', lang));
    });
  }
}
