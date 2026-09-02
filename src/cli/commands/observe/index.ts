import { resolve } from 'node:path';
import { Args, Flags } from '@oclif/core';
import { LANG_FLAG, bilingual } from '../../oclif/i18n.js';
import { BaseCommand } from '../../oclif/base-command.js';
import { CliExit } from '../../lib/cli-exit.js';
import { tCli, type CliLang } from '../../lib/i18n.js';
import { parseLastWindow } from '../../lib/shared.js';
import { projectObserveHealthDir, globalObserveHealthDir } from '../../../measurement-artifacts/directories.js';
import { indexObserveWrite } from '../../../measurement-artifacts/discovery-index.js';
import { runFileSuffix } from '../../../measurement-artifacts/file-names.js';
import { writeMeasurementReportBundle } from '../../../measurement-artifacts/report-bundle.js';
import type { SkillHealthReport } from '../../../observability/skill-health/analyzer.js';

/**
 * observe health 报告落盘：id 加 4 位随机段，根治「同秒两次 omk observe 覆盖」的数据丢失。
 * 每份报告使用自包含 bundle，权威正文固定为 report.json。
 * 落盘后 best-effort 追加全局轻卡片,让 studio 跨项目聚合。
 */
export function persistObserveHealthReport(report: SkillHealthReport, outDir: string): { id: string; jsonPath: string } {
  const id = runFileSuffix();
  const { reportPath: jsonPath } = writeMeasurementReportBundle({
    rootDir: outDir,
    measurementDomain: 'observe-health',
    recordId: id,
    reportId: id,
    createdAt: report.meta.generatedAt,
    report,
  });
  indexObserveWrite(report, jsonPath, outDir, id);
  return { id, jsonPath };
}

// 盲区信号类型 → 人话标签(建议补样本提示用)。技术枚举键的展示名,zh/en 分列。
const GAP_AREA_LABELS: Record<string, { zh: string; en: string }> = {
  failed_search: { zh: '检索失败', en: 'failed search' },
  explicit_marker: { zh: '显式缺口', en: 'explicit gap' },
  hedging: { zh: '含糊回避', en: 'hedging' },
  repeated_failure: { zh: '反复失败', en: 'repeated failure' },
};

/** 取盲区计数最高的前几类,组成「建议补哪类用例」的人话区域串(只展示信号所在,不生成具体用例)。
 *  只迭代**四个已知盲区类型**(GAP_AREA_LABELS 的键),记录 / 报告里若混入额外键一律忽略,不进展示。 */
function topGapAreas(gapByType: Record<string, number>, lang: CliLang): string {
  const sep = lang === 'zh' ? '、' : ', ';
  const areas = Object.keys(GAP_AREA_LABELS)
    .map((k) => [k, gapByType[k] ?? 0] as const)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k]) => GAP_AREA_LABELS[k][lang])
    .join(sep);
  return areas || (lang === 'zh' ? '未归类盲区' : 'uncategorized gaps');
}

/**
 * SkillHealthReport → managed 反哺的结构化最小入参(#235)。纯映射、可单测 —— 把「observe 报告 →
 * ObserveReportView」这段层间胶水从 CLI 副作用里拆出来,免得 healthBand 取错字段 / observedAt 取错时刻
 * 这类映射 bug 无人验。`observedAt` 取**流量窗口结束时刻**(timeRange.to,空则退 generatedAt),不是「此刻」
 * 的 generatedAt —— 否则 latest-wins 会把所有观测当成一样新(见 ManagedObservation.observedAt)。
 * `healthBand` 由 observability 的 `healthBandOf` 逐 skill 算(阈值单一来源,注入以保可测)。
 */
export function buildObserveReportView(
  report: SkillHealthReport,
  reportId: string,
  healthBandOf: (weightedGapRate: number) => 'green' | 'yellow' | 'red',
): import('../../../managed/index.js').ObserveReportView {
  return {
    reportId,
    observedAt: report.meta.timeRange?.to || report.meta.generatedAt,
    skills: Object.values(report.bySkill).map((s) => ({
      skillName: s.skillName,
      segmentCount: s.segmentCount,
      gapRate: s.gap.gapRate,
      weightedGapRate: s.gap.weightedGapRate,
      confidence: s.confidence,
      healthBand: healthBandOf(s.gap.weightedGapRate),
      gapByType: s.gap.byType,
    })),
  };
}

/**
 * observe → 管理支柱反哺(#235):把每个 skill 的生产健康落成观测追加进同名受管记录,并打印「已记录 / 生产
 * 盲区警示」。**非致命**:管理是 observe 旁路,任何异常都不该让 observe 失败(try/catch 吞掉)。observability /
 * managed 运行时函数动态 import,与 observe 主体一致、不拖累 CLI 启动。
 */
async function recordObserveFeedback(report: SkillHealthReport, reportId: string, lang: CliLang): Promise<void> {
  try {
    const { healthBandOf } = await import('../../../observability/skill-health/analyzer.js');
    const { recordObserveHealth } = await import('../../../managed/index.js');
    const written = recordObserveHealth(buildObserveReportView(report, reportId, healthBandOf));
    for (const w of written) {
      process.stdout.write(w.isProductionGap
        ? tCli('cli.observe.production_gap', lang, { name: w.name, areas: topGapAreas(w.gapByType, lang) })
        : tCli('cli.observe.observation_recorded', lang, { name: w.name }));
    }
  } catch {
    // 反哺是 observe 旁路,任何异常都不该让 observe 失败。
  }
}

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
    feedback: Flags.boolean({
      default: true,
      allowNo: true,
      description: bilingual({
        zh: '把生产健康观测反哺已纳管的同名 skill（--no-feedback 关闭）',
        en: 'Feed production-health observations back to managed skills of the same name (--no-feedback to disable)',
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
      const tracePath = resolve(dir);

      const { existsSync } = await import('node:fs');
      if (!existsSync(tracePath)) {
        console.error(`Trace path does not exist: ${tracePath}`);
        throw new CliExit(1);
      }

      // 时间窗: --from/--to 优先, --last fallback
      let from: string | undefined = flags.from;
      if (!from && flags.last) {
        const inferred = parseLastWindow(flags.last);
        if (!inferred) {
          console.error(`Invalid --last format: "${flags.last}". Expected e.g. "7d" / "24h" / "30m".`);
          throw new CliExit(1);
        }
        from = inferred;
      }
      const to: string | undefined = flags.to;
      const skills = flags.skills ? flags.skills.split(',').map((s) => s.trim()).filter(Boolean) : undefined;

      console.log(`[omk] analyzing ${tracePath}...`);
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
      const { id, jsonPath } = persistObserveHealthReport(report, outDir);
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
      const failureSummary = toolCallCount > 0 && toolComparableCount === 0
        ? `fail rate: unavailable${toolCancelledCount > 0 ? ` · cancelled: ${toolCancelledCount}` : ''}${toolUnknownCount > 0 ? ` · unknown outcomes: ${toolUnknownCount}` : ''}`
        : `fail rate: ${(toolFailureRate * 100).toFixed(1)}% (${toolComparableCount} comparable${toolCancelledCount > 0 ? ` · ${toolCancelledCount} cancelled` : ''})`;
      console.log('');
      console.log(`sessions: ${sessionCount} · segments: ${segmentCount} · tool calls: ${toolCallCount} · ${failureSummary}`);
      const overallConf = report.overall.confidence;
      const confSuffix = overallConf === 'high'
        ? ''
        : ` · ⚠ confidence: ${overallConf} (N=${segmentCount} too small; band is indicative)`;
      console.log(`overall: gapRate ${(report.overall.gapRate * 100).toFixed(1)}% · weightedGapRate ${(report.overall.weightedGapRate * 100).toFixed(1)}% · health: ${report.overall.healthBand}${confSuffix}`);
      console.log('');
      const skillRows = Object.values(report.bySkill)
        .sort((a, b) => b.segmentCount - a.segmentCount)
        .slice(0, 10)
        .map((s) => `  ${s.skillName.padEnd(24)} segs=${String(s.segmentCount).padStart(4)}  gapRate=${String(Math.round(s.gap.gapRate * 100) + '%').padStart(4)}  weighted=${String(Math.round(s.gap.weightedGapRate * 100) + '%').padStart(4)}${s.coverage ? `  cov=${Math.round(s.coverage.fileCoverageRate * 100)}%` : ''}${s.confidence !== 'high' ? `  ⚠${s.confidence}` : ''}`);
      console.log('top skills:');
      console.log(skillRows.join('\n'));
      console.log('');
      console.log(`report written to: ${jsonPath}`);
      console.log(tCli('cli.observe.view_hint', lang));

      // #235 受管反哺:把生产健康观测落进同名受管 skill(--no-feedback 关)。非致命旁路。
      if (flags.feedback) await recordObserveFeedback(report, id, lang);
    });
  }
}
