import { readFileSync, lstatSync } from 'node:fs';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../oclif/base-command.js';
import { LANG_FLAG, bilingual } from '../../oclif/i18n.js';
import { UserSettingsStore } from '../../../evidence/storage/user-settings.js';
import { createLocalKnowledgeApplication } from '../../../observability/knowledge-extraction/local.js';
import { configuredExtractionModel } from '../../../observability/knowledge-extraction/adapters/executor.js';

const description = (zh: string, en: string) => bilingual({ zh, en });
export default class ObserveKnowledge extends BaseCommand {
  static description = description('从选定工作日志提炼、核对和维护候选知识。', 'Extract, inspect, and maintain candidate knowledge from selected work logs.');
  static args = {
    operation: Args.string({ required: true, options: ['capture', 'generate', 'runs', 'resume', 'list', 'show', 'retain', 'discard', 'revise', 'source', 'delete-source', 'entities', 'correct-entities', 'apply-entities'],
      description: description('归档、提炼、核对与维护知识；entities 核对实体，correct-entities 纠正实体，apply-entities 创建绑定实体的知识修订。', 'Capture, extract, inspect, and maintain knowledge; entities inspects entities, correct-entities corrects them, apply-entities creates a bound knowledge revision.') }),
  };
  static flags = {
    lang: LANG_FLAG,
    workspace: Flags.string({ description: description('本地知识工作区，默认使用全局设置；CLI 与 Studio 共用。', 'Local knowledge workspace; defaults to global settings shared with Studio.') }),
    source: Flags.string({ description: description('capture：一份已支持格式的 Agent 会话日志（Codex／Claude／Qoder 等）。', 'capture: one supported agent session log (Codex / Claude / Qoder / ...).') }),
    'start-record': Flags.integer({ min: 0, description: description('从零开始的非空记录序号，包含。', 'Zero-based nonempty record index, inclusive.') }),
    'end-record': Flags.integer({ min: 0, description: description('最后一条记录序号，包含。', 'Last record index, inclusive.') }),
    snapshot: Flags.string({ description: description('generate／source／delete-source：归档身份。', 'generate/source/delete-source: snapshot identity.') }),
    id: Flags.string({ description: description('知识身份；resume 时为运行身份。', 'Knowledge identity; run identity for resume.') }),
    revision: Flags.string({ description: description('查看或处理的明确修订身份。', 'Explicit revision to inspect or maintain.') }),
    analysis: Flags.string({ description: description('entities：读取指定分析，省略时检索工作区实体；纠正或应用时必填，与提炼运行身份一致。', 'entities: inspect an analysis, or search the workspace if omitted; required for correction/application, equal to the extraction run identity.') }),
    query: Flags.string({ description: description('entities：搜索名称、原文提及、限定条件及来源。', 'entities: search names, source mentions, qualifiers, and origin.') }),
    'identity-status': Flags.string({ options: ['all', 'proposed', 'unresolved'], description: description('entities：筛选身份对应状态。', 'entities: filter identity assignment status.') }),
    'source-status': Flags.string({ options: ['all', 'available', 'unavailable'], description: description('entities：筛选原文可用状态。', 'entities: filter source availability.') }),
    page: Flags.integer({ min: 1, description: description('entities：检索页码，从 1 开始。', 'entities: search page, starting at 1.') }),
    'page-size': Flags.integer({ min: 1, max: 100, description: description('entities：每页对象数，默认 20，最多 100。', 'entities: entities per page, default 20, maximum 100.') }),
    'entity-revision': Flags.string({ description: description('实体分析的明确修订身份；纠正或应用时必填。', 'Explicit entity analysis revision; required for corrections or applying entities.') }),
    'identity-uncertainties': Flags.string({ description: description('apply-entities：显式核对后的附加身份不确定性 JSON 数组；省略时保留原说明，[] 清除原说明，当前实体歧义仍自动保留。', 'apply-entities: reviewed additional identity uncertainties as a JSON array; omitted preserves prior notes, [] clears them, and current entity ambiguity is always retained.') }),
    generation: Flags.integer({ min: 1, description: description('修改前读取的 generation，用于检测并发冲突。', 'Previously read generation for conflict detection.') }),
    reason: Flags.string({ description: description('保留、舍弃或修订的理由。', 'Reason for retaining, discarding, or editing.') }),
    input: Flags.string({ description: description('revise／apply-entities：知识 JSON 草稿；correct-entities：entities、mentions 草稿，新身份使用 new: 前缀。', 'revise/apply-entities: knowledge JSON draft; correct-entities: entities/mentions draft, using new: for new identities.') }),
    executor: Flags.string({ description: description('生成执行器，沿用 OMK 的运行配置。', 'Generation executor, using OMK runtime configuration.') }),
    model: Flags.string({ description: description('生成模型，沿用已配置模型。', 'Generation model, using the configured model.') }),
    'run-id': Flags.string({ description: description('generate：稳定 UUID，用于重试同一次运行。', 'generate: stable UUID for retrying the same run.') }),
    json: Flags.boolean({ default: false, description: description('输出完整 JSON；默认输出可读摘要。', 'Print complete JSON instead of a readable summary.') }),
  };
  static examples = [
    '<%= config.bin %> observe knowledge capture --workspace ./knowledge --source ./session.jsonl',
    '<%= config.bin %> observe knowledge generate --workspace ./knowledge --snapshot <snapshot-id> --executor codex --model <model>',
    '<%= config.bin %> observe knowledge list --workspace ./knowledge',
    '<%= config.bin %> observe knowledge entities --workspace ./knowledge --analysis <run-id>',
    '<%= config.bin %> observe knowledge entities --workspace ./knowledge --query Atlas --json',
  ];
  async run(): Promise<void> {
    const { args, flags } = await this.parse(ObserveKnowledge);
    const need = (value: string | undefined, name: string): string => {
      if (!value?.trim()) this.error(`--${name} ${this.lang === 'zh' ? '不能为空' : 'is required'}`, { exit: 2 });
      return value!;
    };
    const settings = new UserSettingsStore().resolve({ workspace: flags.workspace, executor: flags.executor, model: flags.model });
    const app = createLocalKnowledgeApplication(settings.workspace);
    const generation = (): number => {
      if (!flags.generation) this.error('--generation is required', { exit: 2 });
      return flags.generation!;
    };
    const draft = (): unknown => {
      const path = need(flags.input, 'input'); const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) this.error('Invalid draft input file.');
      return JSON.parse(readFileSync(path, 'utf8'));
    };
    await this.runWithCancellation(async (signal) => {
      let result: unknown;
      switch (args.operation) {
        case 'capture': result = app.capture({ path: need(flags.source, 'source'), startRecord: flags['start-record'], endRecord: flags['end-record'] }, signal); break;
        case 'generate': {
          const runtime = { executor: settings.executor, model: need(settings.model, 'model') };
          const snapshot = need(flags.snapshot, 'snapshot');
          const source = app.source(snapshot);
          if (source.status !== 'available') this.error(`Source unavailable: ${source.reason}`);
          this.logToStderr(`${runtime.executor} / ${runtime.model} · ${snapshot} · ${this.lang === 'zh' ? '仅发送选定来源片段；费用以执行器实际报告为准。' : 'Only selected excerpts are sent; cost depends on executor reporting.'}`);
          result = await app.generate(snapshot, configuredExtractionModel(runtime.executor, runtime.model), flags['run-id'], signal);
          break;
        }
        case 'runs': result = app.runs(); break;
        case 'resume': result = app.resume(need(flags.id, 'id'), signal); break;
        case 'list': result = app.list(); break;
        case 'show': result = app.detail(need(flags.id, 'id'), flags.revision); break;
        case 'entities': {
          if (flags.analysis) result = app.entities(flags.analysis, flags['entity-revision']);
          else {
            if (flags['entity-revision']) this.error('--entity-revision requires --analysis', { exit: 2 });
            result = app.queryEntities({ query: flags.query, identityStatus: flags['identity-status'] as 'all' | 'proposed' | 'unresolved' | undefined,
              sourceStatus: flags['source-status'] as 'all' | 'available' | 'unavailable' | undefined, page: flags.page, pageSize: flags['page-size'] });
          }
          break;
        }
        case 'correct-entities': result = app.correctEntities(need(flags.analysis, 'analysis'), need(flags['entity-revision'], 'entity-revision'),
          generation(), draft(), need(flags.reason, 'reason')); break;
        case 'apply-entities': result = app.reviseUsingEntities(need(flags.id, 'id'), need(flags.revision, 'revision'), generation(),
          need(flags.analysis, 'analysis'), need(flags['entity-revision'], 'entity-revision'), draft(), need(flags.reason, 'reason'),
          flags['identity-uncertainties'] === undefined ? undefined : JSON.parse(flags['identity-uncertainties'])); break;
        case 'source': result = app.source(need(flags.snapshot, 'snapshot')); break;
        case 'delete-source': app.deleteSource(need(flags.snapshot, 'snapshot')); result = { deleted: flags.snapshot }; break;
        case 'retain': case 'discard': {
          result = app.maintain(need(flags.id, 'id'), need(flags.revision, 'revision'), args.operation,
            need(flags.reason, 'reason'), generation());
          break;
        }
        case 'revise': {
          result = app.revise(need(flags.id, 'id'), need(flags.revision, 'revision'), generation(), draft(), need(flags.reason, 'reason'));
          break;
        }
      }
      this.log(flags.json ? JSON.stringify(result, null, 2) : formatKnowledgeResult(result, this.lang));
      if (result && typeof result === 'object' && 'status' in result && ['failed', 'cancelled'].includes(String(result.status))) this.exit(1);
    });
  }
}

function formatKnowledgeResult(value: unknown, lang: 'zh' | 'en'): string {
  if (Array.isArray(value)) return value.length ? value.map((entry) => formatKnowledgeResult(entry, lang)).join('\n\n') : (lang === 'zh' ? '暂无记录。' : 'No records.');
  if (!value || typeof value !== 'object') return String(value);
  const item = value as Record<string, unknown>;
  if ('rows' in item && 'entityCount' in item) {
    const catalog = item as ReturnType<ReturnType<typeof createLocalKnowledgeApplication>['queryEntities']>;
    return [lang === 'zh' ? `${catalog.total} 个匹配对象 · 第 ${catalog.page} 页；身份对应仍需核对。` : `${catalog.total} matching entities · page ${catalog.page}; identity assignments need review.`,
      ...(catalog.unavailableAnalyses ? [lang === 'zh' ? `${catalog.unavailableAnalyses} 份分析不可读，结果不完整。` : `${catalog.unavailableAnalyses} unreadable analyses; results are incomplete.`] : []),
      ...(catalog.knowledgeStatus === 'unavailable' ? [lang === 'zh' ? '关联知识不可读，数量未知。' : 'Linked knowledge unavailable; counts unknown.'] : []),
      ...catalog.rows.map(row => `${row.label} · ${row.identityStatus} · ${row.mentionCount} ${lang === 'zh' ? '处提及' : 'mentions'} · ${row.knowledgeCount ?? '—'} ${lang === 'zh' ? '条知识' : 'knowledge items'}\n${row.analysisId} / ${row.entityId} / ${row.revisionId}\n${row.qualifiers.join(' / ')} · ${row.sourceStatus}`)].join('\n\n');
  }
  if ('history' in item && (item.history as { storeKind?: string })?.storeKind === 'entity-analysis-history') {
    const analysis = item as ReturnType<ReturnType<typeof createLocalKnowledgeApplication>['entities']>;
    return [lang === 'zh' ? '实体分析，身份对应仍需核对。' : 'Entity analysis; identity assignments need review.',
      `${analysis.history.analysisId} / ${analysis.revision.revisionId} · generation ${analysis.history.generation}`,
      JSON.stringify({ entities: analysis.revision.entities, mentions: analysis.revision.mentions, limitations: analysis.revision.limitations,
        revisionReason: analysis.revision.revisionReason, sourceStatus: analysis.source.status }, null, 2)].join('\n');
  }
  if ('revision' in item) {
    const detail = item as ReturnType<ReturnType<typeof createLocalKnowledgeApplication>['detail']>;
    return [
      detail.revision.title, `${detail.revision.knowledgeId} / ${detail.revision.revisionId} · generation ${detail.history.generation}`,
      lang === 'zh' ? '待复核；保留不等于已证实。' : 'Pending review; retained does not mean verified.',
      JSON.stringify(detail.revision.content, null, 2),
      JSON.stringify({ entities: detail.revision.entities, evidence: detail.revision.evidence, grounding: detail.grounding, sources: detail.sources }, null, 2),
    ].join('\n');
  }
  if ('snapshotId' in item && 'excerpts' in item) return `${item.snapshotId}\n${lang === 'zh' ? '来源范围与限制' : 'Source scope and limitations'}: ${item.startRecord}–${item.endRecord}\n${JSON.stringify(item.limitations)}\n${item.sourcePath}`;
  if ('title' in item) return `${item.title}\n${item.knowledgeId} / ${item.revisionId} · generation ${item.generation} · pending · ${item.choice ?? '—'}`;
  return JSON.stringify(value, null, 2);
}
