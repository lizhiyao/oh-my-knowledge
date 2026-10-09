import { readFileSync, lstatSync } from 'node:fs';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../oclif/base-command.js';
import { LANG_FLAG, bilingual } from '../../oclif/i18n.js';
import { UserSettingsStore } from '../../../evidence/storage/user-settings.js';
import { createLocalKnowledgeApplication } from '../../../observability/knowledge-extraction/local.js';
import { configuredExtractionModel } from '../../../observability/knowledge-extraction/adapters/executor.js';
import { migrateKnowledgeWorkspace, previewKnowledgeMigration } from '../../../observability/knowledge-extraction/adapters/migrate-workspace.js';

const description = (zh: string, en: string) => bilingual({ zh, en });
export default class ObserveKnowledge extends BaseCommand {
  static description = description('从选定工作日志提炼、核对和维护候选知识。', 'Extract, inspect, and maintain candidate knowledge from selected work logs.');
  static args = {
    operation: Args.string({ required: true, options: ['capture', 'generate', 'runs', 'resume', 'list', 'show', 'retain', 'discard', 'revise', 'source', 'delete-source', 'entities', 'correct-entities', 'apply-entities', 'migrate'],
      description: description('归档、提炼、核对与维护知识；entities 核对实体，correct-entities 纠正实体，apply-entities 创建绑定实体的知识修订，migrate 显式升级旧存储。', 'Capture, extract, inspect, and maintain knowledge; entities inspects entities, correct-entities corrects them, apply-entities creates a bound knowledge revision, and migrate explicitly upgrades legacy storage.') }),
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
    analysis: Flags.string({ description: description('entities／correct-entities／apply-entities：实体分析身份，与提炼运行身份一致。', 'entities/correct-entities/apply-entities: entity analysis identity, equal to the extraction run identity.') }),
    'entity-revision': Flags.string({ description: description('实体分析的明确修订身份；纠正或应用时必填。', 'Explicit entity analysis revision; required for corrections or applying entities.') }),
    'identity-uncertainties': Flags.string({ description: description('apply-entities：显式核对后的附加身份不确定性 JSON 数组；省略时保留原说明，[] 清除原说明，当前实体歧义仍自动保留。', 'apply-entities: reviewed additional identity uncertainties as a JSON array; omitted preserves prior notes, [] clears them, and current entity ambiguity is always retained.') }),
    generation: Flags.integer({ min: 1, description: description('修改前读取的 generation，用于检测并发冲突。', 'Previously read generation for conflict detection.') }),
    reason: Flags.string({ description: description('保留、舍弃或修订的理由。', 'Reason for retaining, discarding, or editing.') }),
    input: Flags.string({ description: description('revise／apply-entities：知识 JSON 草稿；correct-entities：entities、mentions 草稿，新身份使用 new: 前缀。', 'revise/apply-entities: knowledge JSON draft; correct-entities: entities/mentions draft, using new: for new identities.') }),
    'dry-run': Flags.boolean({ default: false, description: description('migrate：只预检和显示待迁移数量，不写入。', 'migrate: validate and preview counts without writing.') }),
    'backup-dir': Flags.string({ description: description('migrate：用户指定的工作区外备份目录，须为绝对路径；恢复时沿用同一目录。迁移前停止旧 CLI 与 Studio 写入。', 'migrate: explicit absolute backup directory outside the workspace; reuse it to resume. Stop legacy CLI and Studio writers first.') }),
    'preview-digest': Flags.string({ description: description('migrate：要求当前输入与此前 dry-run 的 previewDigest 一致。', 'migrate: require inputs to match a previous dry-run previewDigest.') }),
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
    '<%= config.bin %> observe knowledge migrate --workspace ./knowledge --dry-run',
    '<%= config.bin %> observe knowledge migrate --workspace ./knowledge --backup-dir /absolute/path/outside-workspace',
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
        case 'entities': result = app.entities(need(flags.analysis, 'analysis'), flags['entity-revision']); break;
        case 'correct-entities': result = app.correctEntities(need(flags.analysis, 'analysis'), need(flags['entity-revision'], 'entity-revision'),
          generation(), draft(), need(flags.reason, 'reason')); break;
        case 'apply-entities': result = app.reviseUsingEntities(need(flags.id, 'id'), need(flags.revision, 'revision'), generation(),
          need(flags.analysis, 'analysis'), need(flags['entity-revision'], 'entity-revision'), draft(), need(flags.reason, 'reason'),
          flags['identity-uncertainties'] === undefined ? undefined : JSON.parse(flags['identity-uncertainties'])); break;
        case 'migrate': result = flags['dry-run'] ? previewKnowledgeMigration(settings.workspace)
          : migrateKnowledgeWorkspace(settings.workspace, need(flags['backup-dir'], 'backup-dir'), flags['preview-digest']); break;
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
