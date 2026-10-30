import { createExtractionArchiveProducer } from '../../executors/archive.js';
import { existsSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../oclif/base-command.js';
import { LANG_FLAG, bilingual } from '../oclif/i18n.js';
import { shellQuoteArg } from '../../shared/shell-quote.js';
import { knowledgeCommand } from '../lib/knowledge-output.js';
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
    '识别本机 Agent、采集日志，并从明确选定的原记录准备知识生成请求；不发送模型。',
    'Detect local agents, collect logs, and prepare knowledge generation from explicitly selected original records without model dispatch.',
  );

  static args = {
    operation: Args.string({
      required: true,
      options: ['list', 'collect', 'extract'],
      description: description(
        '操作：list 识别安装情况，collect 采集日志，extract 本地保存选定原记录并展示完整生成请求；发送须另行确认。',
        'list: inspect installs. collect: gather logs. extract: save selected original records locally and display the complete generation request; dispatch requires separate confirmation.',
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
    'start-record': Flags.integer({ min: 0, description: description('extract 必填：从零开始的非空原记录序号，包含；保留同条记录的全部事件。', 'Required for extract: zero-based nonempty original record index, inclusive; retains every event in the record.') }),
    'end-record': Flags.integer({ min: 0, description: description('extract 必填：最后一条非空原记录序号，包含；须同时指定起止范围。', 'Required for extract: last nonempty original record index, inclusive; provide both range bounds.') }),
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
    '<%= config.bin %> agents extract --session <runId> --start-record 0 --end-record 0 --executor codex --model <model> --json',
    '<%= config.bin %> agents extract --session <runId> --start-record 10 --end-record 30 --executor codex --model <model>',
  ];

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AgentsCommand);
    const lang = this.lang;
    if (args.operation === 'extract' && (flags['start-record'] === undefined || flags['end-record'] === undefined)) {
      this.error(lang === 'zh'
        ? 'extract 须同时指定 --start-record 与 --end-record：零基、包含边界的非空原记录序号，同条记录的全部事件都会纳入；采集报告的事件数不能代替原记录数。'
        : 'extract requires both --start-record and --end-record: zero-based inclusive nonempty original record indices, retaining all events in each record; collection event counts are not original record counts.', { exit: 2 });
    }
    if (flags['start-record'] !== undefined || flags['end-record'] !== undefined) {
      if (args.operation !== 'extract') this.error(lang === 'zh' ? '记录范围参数仅用于 extract。' : 'Record range flags are only valid for extract.', { exit: 2 });
      if (!Number.isSafeInteger(flags['start-record'] ?? 0) || !Number.isSafeInteger(flags['end-record'] ?? 0)
        || (flags['end-record'] !== undefined && flags['end-record'] < (flags['start-record'] ?? 0))) {
        this.error(lang === 'zh' ? '记录范围无效；--end-record 不能小于 --start-record。' : 'Invalid record range; --end-record must not precede --start-record.', { exit: 2 });
      }
    }
    const {
      agentStorageLayout: layoutOf,
      AgentCollectionReportOutdatedError,
      collectAgentLogs,
      detectAgentInventory,
      loadAgentCollectionReport,
      LocalAgentCatalogError,
      resolveAgentCatalog,
      saveAgentCollectionReport,
      saveAgentInventoryReport,
    } = await import('../../observability/agents/index.js');
    const layout = layoutOf(flags.dir ?? globalLayout().observeAgentsDir);
    // 登记表是内置表与本机扩展文件的合并结果；扩展文件读不动时按业务失败处理，
    // 因为拿半份表探测会让清单静默少一个宿主，比直接报错更难发现。
    const readCatalog = (): ReturnType<typeof resolveAgentCatalog> => {
      try {
        return resolveAgentCatalog();
      } catch (cause) {
        if (cause instanceof LocalAgentCatalogError) {
          this.error(lang === 'zh'
            ? `本机 Agent 登记表扩展不可用：${cause.message}`
            : `Local agent catalog extension is unusable: ${cause.message}`, { exit: 1 });
        }
        throw cause;
      }
    };
    await this.runWithCancellation(async (signal) => {
      if (args.operation === 'list') {
        const report = detectAgentInventory({ descriptors: readCatalog() });
        const written = saveAgentInventoryReport(report, layout);
        if (flags.json) {
          this.log(JSON.stringify(report, null, 2));
        } else {
          for (const agent of report.agents.filter((entry) => entry.installed)) {
            this.log(`${agent.displayName} (${agent.agentId}) · ${agent.traceSourceKind ?? 'unknown'} · ${agent.sessionFileCount}`);
            for (const root of agent.logRoots.filter((entry) => entry.exists)) {
              this.log(lang === 'zh'
                ? `  ${root.path}：${root.sessionFileCount} 份${root.truncated ? '（已截断）' : ''}${root.readable ? '' : '（不可读）'}${root.unreadableReason ? '（本机运行时解不了这格式）' : ''}`
                : `  ${root.path}: ${root.sessionFileCount}${root.truncated ? ' (truncated)' : ''}${root.readable ? '' : ' (unreadable)'}${root.unreadableReason ? ' (this runtime cannot read the format)' : ''}`);
            }
          }
          this.log(lang === 'zh'
            ? `已识别 ${report.summary.installedAgentCount}/${report.summary.knownAgentCount} 个 Agent · 会话日志 ${report.summary.sessionFileCount} 份`
            : `${report.summary.installedAgentCount}/${report.summary.knownAgentCount} agents detected · ${report.summary.sessionFileCount} session logs`);
        }
        for (const agent of report.agents.filter((entry) => entry.installed)) {
          // 「装了但本机读不了这格式」与「装了且没有日志」是两件事：前者要换运行时，
          // 后者要等用户真的产生会话，混成一句会让人白跑一边排查。
          if (agent.logRoots.some((root) => root.unreadableReason !== undefined)) {
            this.logToStderr(lang === 'zh'
              ? `${agent.displayName} 已安装并发现了会话文件，但本机 Node 运行时没有内建 zstd 解压，读不了 .jsonl.zstd 会话。`
              : `${agent.displayName} is installed and session files were found, but this Node runtime has no built-in zstd decompression, so .jsonl.zstd sessions cannot be read.`);
            continue;
          }
          if (agent.sessionFileCount > 0) continue;
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
          detect: { descriptors: readCatalog() },
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
            ? `采集：发现 ${report.summary.discoveredCount} · 新增 ${report.summary.collectedCount} · 跳过 ${report.summary.skippedCount} · 失败 ${report.summary.failedCount} · 事件 ${report.summary.eventCount}（未支持格式 ${report.summary.unknownEventCount} · 重复视图 ${report.summary.duplicateViewCount} · 待映射证据 ${report.summary.unmappedEvidenceCount}）`
            : `Collected: ${report.summary.discoveredCount} found · ${report.summary.collectedCount} new · ${report.summary.skippedCount} skipped · ${report.summary.failedCount} failed · ${report.summary.eventCount} events (${report.summary.unknownEventCount} unsupported format · ${report.summary.duplicateViewCount} duplicate views · ${report.summary.unmappedEvidenceCount} unmapped evidence)`);
        }
        for (const limitation of report.limitations) {
          this.logToStderr(lang === 'zh' ? `限制：${limitation}` : `Limitation: ${limitation}`);
        }
        this.logToStderr(lang === 'zh' ? `采集报告已写入：${written}` : `Collection report written to: ${written}`);
        const sample = report.sessions[0]?.runId ?? '<runId>';
        this.logToStderr(lang === 'zh'
          ? `下一步：选定零基非空原记录范围后，运行 omk agents extract --session ${shellQuoteArg(sample)} --start-record <first> --end-record <last>，本地保存并核对请求，不发送模型。\n在 Studio 的 Agents 页查看：omk studio`
          : `Next: choose zero-based nonempty original record indices, then run omk agents extract --session ${shellQuoteArg(sample)} --start-record <first> --end-record <last> to save locally and inspect the request without model dispatch.\nTo review it in Studio: omk studio`);
        return;
      }

      const runId = flags.session;
      if (!runId?.trim()) {
        this.error(`--session ${lang === 'zh' ? '不能为空' : 'is required'}`, { exit: 2 });
      }
      let collection: ReturnType<typeof loadAgentCollectionReport>;
      try {
        collection = loadAgentCollectionReport(layout.observeAgentsDir);
      } catch (cause) {
        if (cause instanceof AgentCollectionReportOutdatedError) {
          this.error(lang === 'zh'
            ? `采集报告是 ${cause.foundVersion} 口径，未识别事件的分桶计数无法沿用。先运行 omk agents collect 重新采集。`
            : `The collection report uses the superseded ${cause.foundVersion} scheme, whose unrecognized-event buckets cannot be carried over. Run omk agents collect to recollect.`, { exit: 1 });
        }
        throw cause;
      }
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
      if (!existsSync(session.sourcePath) || !lstatSync(session.sourcePath).isFile()) {
        this.error(lang === 'zh'
          ? `原始日志已不可读：${session.sourcePath}`
          : `Source log is no longer readable: ${session.sourcePath}`, { exit: 1 });
      }
      const settings = new UserSettingsStore().resolve({
        workspace: flags.knowledge ? resolve(flags.knowledge) : globalLayout().knowledgeDir,
        executor: flags.executor,
        model: flags.model,
      });
      if (!settings.model) {
        this.error(lang === 'zh'
          ? '缺少生成模型，请用 --model 指定。'
          : 'No generation model; pass --model.', { exit: 2 });
      }
      const { createLocalKnowledgeApplication } = await import('../../knowledge/application/local.js');
      const { createLocalKnowledgeGenerationModel } = await import('../../knowledge/adapters/generation-host.js');
      const { executeKnowledgeOperation, knowledgeFailureCode } = await import('../../knowledge/application/operations.js');
      const app = createLocalKnowledgeApplication(settings.workspace, { sourceScope: {
        scopeVersion: 'knowledge-source-scope/v1', projects: [],
        // Collection titles are display labels derived from messages, not original trace titles.
        traces: [{ sourceId: session.runId, traceKind: session.sourceKind, path: session.sourcePath }],
      } });
      this.logToStderr(lang === 'zh'
        ? `${session.agentId} / ${session.sourceKind} · 本地保存选定原记录并准备完整请求；本命令不发送模型。`
        : `${session.agentId} / ${session.sourceKind} · Save selected original records locally and prepare the complete request; this command does not dispatch a model.`);
      try {
        const preview = await executeKnowledgeOperation(app, { operation: 'preview-sources', selections: [{
          sourceKind: 'agent_trace', sourceId: session.runId, traceKind: session.sourceKind,
          recordRanges: [{ startRecord: flags['start-record']!, endRecord: flags['end-record']! }],
        }] }, signal);
        const capture = await executeKnowledgeOperation(app, { operation: 'capture', previewDigest: preview.previewDigest,
          selections: preview.items.map(item => item.resolvedSelection) }, signal);
        const sources = capture.saveManifest.items.map(({ snapshotId, sourceVersion }) => ({ snapshotId, sourceVersion }));
        const prepared = await executeKnowledgeOperation(app, { operation: 'prepare-generation', sources,
          executor: settings.executor, model: settings.model }, signal,
        (executor, model) => createLocalKnowledgeGenerationModel(executor, model, createExtractionArchiveProducer));
        const { journal } = prepared, pending = journal.stages.find(stage => stage.state === 'prepared');
        const nextCommand = prepared.nextAction === 'continue_stage' && pending?.stageKind === 'body'
          ? knowledgeCommand(settings.workspace, 'generate', { input: 'sources.json', 'run-id': journal.runId,
            executor: journal.executor, model: journal.model, 'confirm-request': pending.requestDigest, json: true })
          : prepared.nextAction === 'continue_stage' && pending?.stageKind === 'association'
            ? knowledgeCommand(settings.workspace, 'continue-stage', { id: journal.runId, generation: journal.generation,
              executor: journal.executor, model: journal.model, 'confirm-request': pending.requestDigest, json: true })
            : knowledgeCommand(settings.workspace, 'inspect', { id: journal.runId, json: true });
        const result = { session, preview, capture, sources, prepared, generationInput: { sources }, modelCalls: 0, nextCommand };
        if (flags.json) { this.log(JSON.stringify(result, null, 2)); return; }
        this.log(lang === 'zh'
          ? `来源已本地保存；生成任务 ${journal.runId} 为 ${journal.status}。本次模型调用：0。以下为完整预览、保存结果和准备请求：`
          : `Sources saved locally; generation run ${journal.runId} is ${journal.status}. Model calls in this command: 0. Complete preview, capture and prepared request:`);
        this.log(JSON.stringify(result, null, 2));
        this.logToStderr(lang === 'zh'
          ? `先核对完整请求。若下一步为 generate，将 generationInput 原样保存为 sources.json，再显式确认发送正文；关联须另行核对并确认。重复导入复用同一默认任务，未知结果不重发。\n${nextCommand}`
          : `Inspect the complete request first. For generate, save generationInput unchanged as sources.json, then explicitly confirm body dispatch; inspect and confirm associations separately. Reimport reuses the default run and never redispatches unknown outcomes.\n${nextCommand}`);
      } catch (cause) {
        this.error(`${knowledgeFailureCode(cause)} · ${cause instanceof Error ? cause.message : String(cause)}\n${knowledgeCommand(settings.workspace, 'runs', { json: true })}`, { exit: 1 });
      }
    });
  }
}
