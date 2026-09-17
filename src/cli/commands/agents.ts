import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../oclif/base-command.js';
import { LANG_FLAG, bilingual } from '../oclif/i18n.js';
import { shellQuoteArg } from '../../shared/shell-quote.js';
import { UserSettingsStore } from '../../evidence/storage/user-settings.js';
import { globalLayout } from '../../evidence/storage/layout.js';
import type { AgentCollectionEntry } from '../../observability/agents/index.js';

const description = (zh: string, en: string) => bilingual({ zh, en });

function formatEntryLine(entry: AgentCollectionEntry, lang: 'zh' | 'en'): string {
  const roots = entry.logRoots.map((root) => {
    const suffix = lang === 'zh'
      ? `${root.traceSourceKind}：发现 ${root.discoveredCount} · 新增 ${root.collectedCount} · 跳过 ${root.skippedCount}`
      : `${root.traceSourceKind}: ${root.discoveredCount} found · ${root.collectedCount} new · ${root.skippedCount} skipped`;
    return root.failedCount > 0 ? `${suffix}${lang === 'zh' ? ` · 失败 ${root.failedCount}` : ` · ${root.failedCount} failed`}` : suffix;
  }).join(' / ');
  return lang === 'zh'
    ? `  ${entry.displayName}：${entry.logRoots.length} 个日志根 · ${roots}`
    : `  ${entry.displayName}: ${entry.logRoots.length} log roots · ${roots}`;
}

export default class AgentsCommand extends BaseCommand {
  static description = description(
    '识别本机已安装的 Agent，采集其日志并映射成统一格式，再提炼候选知识。',
    'Detect installed agents, collect their logs into the unified trace format, and extract candidate knowledge.',
  );

  static args = {
    operation: Args.string({
      required: true,
      options: ['list', 'collect', 'extract'],
      description: description(
        '操作：list 识别安装情况，collect 采集日志并映射成统一 Trace IR，extract 从已采集日志提炼候选知识。',
        'list: inspect installs. collect: gather logs into normalized Trace IR. extract: draft candidate knowledge from collected logs.',
      ),
    }),
  };

  static flags = {
    lang: LANG_FLAG,
    dir: Flags.string({
      description: description(
        '清单与采集产物目录，默认全局 ~/.oh-my-knowledge/observe/agents。',
        'Inventory and collection dir; defaults to the global ~/.oh-my-knowledge/observe/agents.',
      ),
    }),
    limit: Flags.integer({
      min: 1,
      description: description('collect 单轮处理的会话文件上限。', 'Per-run session file cap for collect.'),
    }),
    session: Flags.string({
      description: description('extract：采集报告里的 runId。', 'extract: a runId from the collection report.'),
    }),
    knowledge: Flags.string({
      description: description('extract：知识工作区，默认全局知识目录。', 'extract: knowledge workspace; defaults to the global knowledge dir.'),
    }),
    executor: Flags.string({
      description: description('extract：生成执行器，沿用 OMK 运行配置。', 'extract: generation executor, using OMK runtime configuration.'),
    }),
    model: Flags.string({
      description: description('extract：生成模型，沿用已配置模型。', 'extract: generation model, using the configured model.'),
    }),
    json: Flags.boolean({
      default: false,
      description: description('输出完整 JSON；默认输出可读摘要。', 'Print complete JSON instead of a readable summary.'),
    }),
  };

  static examples = [
    '<%= config.bin %> agents list',
    '<%= config.bin %> agents collect --limit 50',
    '<%= config.bin %> agents extract --session <runId> --executor codex --model <model>',
  ];

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AgentsCommand);
    const lang = this.lang;
    const {
      agentStorageLayout: layoutOf,
      collectAgentLogs,
      detectAgentInventory,
      loadAgentCollectionReport,
      saveAgentCollectionReport,
      saveAgentInventoryReport,
    } = await import('../../observability/agents/index.js');
    const layout = layoutOf(flags.dir ?? globalLayout().observeAgentsDir);
    await this.runWithCancellation(async (signal) => {
      if (args.operation === 'list') {
        const report = detectAgentInventory();
        const written = saveAgentInventoryReport(report, layout);
        if (flags.json) {
          this.log(JSON.stringify(report, null, 2));
        } else {
          for (const agent of report.agents.filter((entry) => entry.installed)) {
            this.log(`${agent.displayName} (${agent.agentId}) · ${agent.traceSourceKind ?? 'unknown'} · ${agent.sessionFileCount}`);
            for (const root of agent.logRoots.filter((entry) => entry.exists)) {
              this.log(lang === 'zh'
                ? `  ${root.path}：${root.sessionFileCount} 份${root.truncated ? '（已截断）' : ''}${root.readable ? '' : '（不可读）'}`
                : `  ${root.path}: ${root.sessionFileCount}${root.truncated ? ' (truncated)' : ''}${root.readable ? '' : ' (unreadable)'}`);
            }
          }
          this.log(lang === 'zh'
            ? `已识别 ${report.summary.installedAgentCount}/${report.summary.knownAgentCount} 个 Agent · 会话日志 ${report.summary.sessionFileCount} 份`
            : `${report.summary.installedAgentCount}/${report.summary.knownAgentCount} agents detected · ${report.summary.sessionFileCount} session logs`);
        }
        for (const agent of report.agents.filter((entry) => entry.installed && entry.sessionFileCount === 0)) {
          this.logToStderr(lang === 'zh'
            ? `${agent.displayName} 已安装，但没有找到可读的会话日志。`
            : `${agent.displayName} is installed but has no readable session logs.`);
        }
        this.logToStderr(lang === 'zh' ? `清单已写入：${written}` : `Inventory written to: ${written}`);
        return;
      }

      if (args.operation === 'collect') {
        const report = collectAgentLogs(undefined, {
          layout,
          ...(flags.limit === undefined ? {} : { limits: { maxFilesPerRun: flags.limit } }),
        });
        const written = saveAgentCollectionReport(report, layout);
        if (flags.json) {
          this.log(JSON.stringify(report, null, 2));
        } else {
          for (const entry of report.agents) {
            this.log(formatEntryLine(entry, lang));
          }
          this.log(lang === 'zh'
            ? `采集：发现 ${report.summary.discoveredCount} · 新增 ${report.summary.collectedCount} · 跳过 ${report.summary.skippedCount} · 失败 ${report.summary.failedCount} · 事件 ${report.summary.eventCount}（无法解读 ${report.summary.unknownEventCount}）`
            : `Collected: ${report.summary.discoveredCount} found · ${report.summary.collectedCount} new · ${report.summary.skippedCount} skipped · ${report.summary.failedCount} failed · ${report.summary.eventCount} events (${report.summary.unknownEventCount} uninterpreted)`);
        }
        for (const limitation of report.limitations) {
          this.logToStderr(lang === 'zh' ? `限制：${limitation}` : `Limitation: ${limitation}`);
        }
        this.logToStderr(lang === 'zh' ? `采集报告已写入：${written}` : `Collection report written to: ${written}`);
        const sample = report.sessions[0]?.runId ?? '<runId>';
        this.logToStderr(lang === 'zh'
          ? `下一步：omk agents extract --session ${shellQuoteArg(sample)}\n在 Studio 的 Agents 页查看：omk studio`
          : `Next: omk agents extract --session ${shellQuoteArg(sample)}\nTo review it in Studio: omk studio`);
        return;
      }

      const runId = flags.session;
      if (!runId?.trim()) {
        this.error(`--session ${lang === 'zh' ? '不能为空' : 'is required'}`, { exit: 2 });
      }
      const collection = loadAgentCollectionReport(layout.observeAgentsDir);
      if (!collection) {
        this.error(lang === 'zh'
          ? '还没有采集报告，先运行 omk agents collect。'
          : 'No collection report yet; run omk agents collect first.', { exit: 1 });
      }
      const session = collection.sessions.find((entry) => entry.runId === runId);
      if (!session) {
        this.error(lang === 'zh'
          ? `采集报告里没有会话 ${runId}。`
          : `Session ${runId} is not in the collection report.`, { exit: 1 });
      }
      if (!existsSync(session.sourcePath) || !statSync(session.sourcePath).isFile()) {
        this.error(lang === 'zh'
          ? `原始日志已不可读：${session.sourcePath}`
          : `Source log is no longer readable: ${session.sourcePath}`, { exit: 1 });
      }
      const settings = new UserSettingsStore().resolve({
        workspace: flags.knowledge ? resolve(flags.knowledge) : globalLayout().knowledgeDir,
        executor: flags.executor,
        model: flags.model,
      });
      const { createLocalKnowledgeApplication } = await import('../../observability/knowledge-extraction/local.js');
      const { configuredExtractionModel } = await import('../../observability/knowledge-extraction/adapters/executor.js');
      const app = createLocalKnowledgeApplication(settings.workspace);
      this.logToStderr(lang === 'zh'
        ? `${session.agentId} / ${session.sourceKind} · 仅发送选定来源片段；费用以执行器实际报告为准。`
        : `${session.agentId} / ${session.sourceKind} · Only selected excerpts are sent; cost depends on executor reporting.`);
      const captured = app.capture({
        path: session.sourcePath,
        ...(session.title ? { origin: { threadId: session.runId, title: session.title } } : {}),
      }, signal);
      if (!settings.model) {
        this.error(lang === 'zh'
          ? '缺少生成模型，请用 --model 指定。'
          : 'No generation model; pass --model.', { exit: 2 });
      }
      const run = await app.generate(
        captured.snapshotId,
        configuredExtractionModel(settings.executor, settings.model),
        undefined,
        signal,
      );
      if (flags.json) {
        this.log(JSON.stringify({ session, snapshot: captured, run }, null, 2));
        return;
      }
      this.log(lang === 'zh'
        ? `提炼完成：${run.committed.length} 条候选知识（来源格式 ${captured.sourceKind}，快照 ${captured.snapshotId}）`
        : `Extracted ${run.committed.length} candidate(s) from ${captured.sourceKind} (snapshot ${captured.snapshotId}).`);
      for (const committed of run.committed) {
        const detail = app.detail(committed.knowledgeId, committed.revisionId);
        this.log(`- ${detail.revision.title} · ${detail.revision.entities.length} 个实体 · ${committed.knowledgeId}`);
      }
      this.logToStderr(lang === 'zh'
        ? `下一步：omk observe knowledge list --workspace ${shellQuoteArg(settings.workspace)}`
        : `Next: omk observe knowledge list --workspace ${shellQuoteArg(settings.workspace)}`);
    });
  }
}
