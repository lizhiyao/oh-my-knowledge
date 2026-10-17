import { createExtractionArchiveProducer } from '../../../executors/archive.js';
import { readFileSync, lstatSync } from 'node:fs';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../oclif/base-command.js';
import { LANG_FLAG, bilingual } from '../../oclif/i18n.js';
import { UserSettingsStore } from '../../../evidence/storage/user-settings.js';
import { createLocalKnowledgeApplication } from '../../../observability/knowledge-extraction/local.js';
import { z } from 'zod';
import { KnowledgeOperationSchema, executeKnowledgeOperation, knowledgeFailureCode, type KnowledgeOperation } from '../../../observability/knowledge-extraction/operations.js';
import { formatKnowledgeResult, knowledgeCommand } from '../../lib/knowledge-output.js';
import { configuredExtractionModel } from '../../../observability/knowledge-extraction/adapters/executor.js';
import { ExtractionGenerationPolicySchema } from '../../../observability/knowledge-extraction/extraction/generation-policy.js';

const description = (zh: string, en: string) => bilingual({ zh, en });
export default class ObserveKnowledge extends BaseCommand {
  static description = description('从选定工作日志提炼、核对和维护候选知识。', 'Extract, inspect, and maintain candidate knowledge from selected work logs.');
  static args = {
    operation: Args.string({ required: true, options: ['schema', 'capture', 'generate', 'runs', 'quality', 'resume', 'list', 'show', 'retain', 'discard', 'revise', 'source', 'delete-source', 'entities', 'correct-entities', 'apply-entities'],
      description: description('schema 导出响应协议；归档、提炼、核对与维护知识；quality 查看零调用的结构接纳统计；entities 核对实体，correct-entities 纠正实体，apply-entities 创建绑定实体的知识修订。', 'schema exports the response contract; capture, extract, inspect, and maintain knowledge; quality reads admission statistics without model calls; entities inspects entities, correct-entities corrects them, apply-entities creates a bound knowledge revision.') }),
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
    reason: Flags.string({ description: description('保留、舍弃或修订的理由；保留不代表已证实，纠正实体不会自动改写知识。', 'Reason for maintenance or editing; retention does not verify truth, and entity corrections do not automatically rewrite knowledge.') }),
    input: Flags.string({ description: description('revise／apply-entities：知识 JSON 草稿；correct-entities：entities、mentions 草稿，新身份使用 new: 前缀。', 'revise/apply-entities: knowledge JSON draft; correct-entities: entities/mentions draft, using new: for new identities.') }),
    executor: Flags.string({ description: description('generate：生成执行器；只有该操作发送选定片段并调用模型。', 'generate: executor; only this operation sends selected excerpts and calls a model.') }),
    model: Flags.string({ description: description('生成模型，沿用已配置模型。', 'Generation model, using the configured model.') }),
    'run-id': Flags.string({ description: description('generate：稳定 UUID；重复请求只恢复已归档结果，不再次调用模型。', 'generate: stable UUID; repeated requests only restore archived results without another model call.') }),
    'generation-policy': Flags.string({ description: description('generate：完整生成策略 JSON；省略时仅调用一次。有界重试须明确模型、调用及 token 预算，输出上限取自策略。', 'generate: complete generation-policy JSON; omitted means one invocation. Bounded retries require explicit model, invocation and token budgets; the policy sets the output cap.') }),
    json: Flags.boolean({ default: false, description: description('输出完整 JSON；默认输出可读摘要，schema 默认仅输出 JSON Schema。', 'Print complete JSON instead of a readable summary; schema defaults to the JSON Schema alone.') }),
  };
  static examples = [
    '<%= config.bin %> observe knowledge schema --json',
    '<%= config.bin %> observe knowledge capture --workspace ./knowledge --source ./session.jsonl',
    '<%= config.bin %> observe knowledge generate --workspace ./knowledge --snapshot <snapshot-id> --executor codex --model <model>',
    '<%= config.bin %> observe knowledge list --workspace ./knowledge',
    '<%= config.bin %> observe knowledge quality --workspace ./knowledge --json',
    '<%= config.bin %> observe knowledge entities --workspace ./knowledge --analysis <run-id>',
    '<%= config.bin %> observe knowledge entities --workspace ./knowledge --query Atlas --json',
    '<%= config.bin %> observe knowledge show --workspace ./knowledge --id <knowledge-id> --json',
    '<%= config.bin %> observe knowledge retain --workspace ./knowledge --id <knowledge-id> --revision <revision-id> --generation 1 --reason "已核对来源与适用条件"',
    '<%= config.bin %> observe knowledge correct-entities --workspace ./knowledge --analysis <run-id> --entity-revision <entity-revision-id> --generation 1 --input ./entities.json --reason "纠正身份对应"',
    '<%= config.bin %> observe knowledge apply-entities --workspace ./knowledge --id <knowledge-id> --revision <revision-id> --generation 1 --analysis <run-id> --entity-revision <entity-revision-id> --input ./knowledge.json --reason "显式应用已核对实体"',
    '<%= config.bin %> observe knowledge resume --workspace ./knowledge --id <run-id>',
  ];
  async run(): Promise<void> {
    const { args, flags } = await this.parse(ObserveKnowledge);
    if (flags['generation-policy'] !== undefined && args.operation !== 'generate') {
      this.error(this.lang === 'zh' ? '--generation-policy 仅用于 generate。' : '--generation-policy is only valid for generate.', { exit: 2 });
    }
    if (args.operation === 'schema') {
      const wire = await import('../../../observability/knowledge-extraction/extraction/model-wire.js');
      if (flags.json) this.log(JSON.stringify({ responseKind: 'knowledge-extraction-wire-contract',
        wireId: wire.WINDOW_EXTRACTION_WIRE_ID, identity: wire.WINDOW_EXTRACTION_WIRE_IDENTITY,
        schema: wire.WINDOW_EXTRACTION_WIRE_SCHEMA, hostOnly: wire.WINDOW_EXTRACTION_WIRE_HOST_ONLY }, null, 2));
      else process.stdout.write(wire.WINDOW_EXTRACTION_WIRE_SCHEMA_JSON);
      return;
    }
    const t = (zh: string, en: string) => this.lang === 'zh' ? zh : en;
    const need = (value: string | undefined, name: string): string => {
      if (!value?.trim()) this.error(`--${name} ${t('不能为空', 'is required')}`, { exit: 2 });
      return value!;
    };
    const generation = (): number => {
      if (!flags.generation) this.error(`--generation ${t('不能为空；请先读取当前记录', 'is required; read the current record first')}`, { exit: 2 });
      return flags.generation!;
    };
    const jsonInput = (raw: string, label: string): unknown => {
      try { return JSON.parse(raw); }
      catch { this.error(t(`${label} 不是有效 JSON。请核对输入后重试；原记录未改写。`, `${label} is not valid JSON. Check the input and retry; saved records were not changed.`), { exit: 2 }); }
    };
    const draft = (): unknown => {
      const path = need(flags.input, 'input'); let raw: string;
      try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error();
        raw = readFileSync(path, 'utf8');
      } catch { this.error(t('草稿不可读。--input 需指向不超过 2 MiB 的普通 JSON 文件；请核对路径和权限，原记录未改写。', 'Draft is unreadable. --input must point to a regular JSON file of at most 2 MiB; check its path and permissions. Saved records were not changed.')); }
      return jsonInput(raw!, '--input');
    };
    const policy = flags['generation-policy'] === undefined ? undefined
      : ExtractionGenerationPolicySchema.safeParse(jsonInput(flags['generation-policy'], '--generation-policy'));
    if (policy && !policy.success) this.error(t('生成策略无效。请核对完整策略及调用、token 预算。', 'Invalid generation policy. Check the complete policy and invocation/token budgets.'), { exit: 2 });
    // Required arguments and draft syntax are checked before settings or storage access.
    let operation: KnowledgeOperation;
    switch (args.operation) {
      case 'capture': operation = { operation: 'capture', source: need(flags.source, 'source'), startRecord: flags['start-record'], endRecord: flags['end-record'] }; break;
      case 'generate': operation = { operation: 'generate', snapshot: need(flags.snapshot, 'snapshot'), executor: 'configured', model: 'configured', runId: flags['run-id'],
        ...(policy?.success ? { policy: policy.data } : {}) }; break;
      case 'runs': case 'quality': case 'list': operation = { operation: args.operation }; break;
      case 'resume': operation = { operation: 'resume', id: need(flags.id, 'id') }; break;
      case 'show': operation = { operation: 'show', id: need(flags.id, 'id'), revision: flags.revision }; break;
      case 'entities': {
        if (flags.analysis) operation = { operation: 'entities', analysisId: flags.analysis, revision: flags['entity-revision'] };
        else {
          if (flags['entity-revision']) this.error(t('--entity-revision 必须与 --analysis 一起使用', '--entity-revision requires --analysis'), { exit: 2 });
          operation = { operation: 'entity-catalog', query: flags.query?.trim() || undefined, identityStatus: flags['identity-status'] as 'all' | 'proposed' | 'unresolved' | undefined,
            sourceStatus: flags['source-status'] as 'all' | 'available' | 'unavailable' | undefined, page: flags.page, pageSize: flags['page-size'] };
        }
        break;
      }
      case 'correct-entities': operation = { operation: 'correct-entities', analysisId: need(flags.analysis, 'analysis'), revision: need(flags['entity-revision'], 'entity-revision'),
        generation: generation(), reason: need(flags.reason, 'reason'), draft: draft() }; break;
      case 'apply-entities': operation = { operation: 'apply-entities', id: need(flags.id, 'id'), revision: need(flags.revision, 'revision'), generation: generation(),
        analysisId: need(flags.analysis, 'analysis'), entityRevision: need(flags['entity-revision'], 'entity-revision'), reason: need(flags.reason, 'reason'), draft: draft(),
        identityUncertainties: flags['identity-uncertainties'] === undefined ? undefined : jsonInput(flags['identity-uncertainties'], '--identity-uncertainties') as string[] }; break;
      case 'source': case 'delete-source': operation = { operation: args.operation, snapshot: need(flags.snapshot, 'snapshot') }; break;
      case 'retain': case 'discard': operation = { operation: 'maintain', id: need(flags.id, 'id'), revision: need(flags.revision, 'revision'), choice: args.operation,
        reason: need(flags.reason, 'reason'), generation: generation() }; break;
      case 'revise': operation = { operation: 'revise', id: need(flags.id, 'id'), revision: need(flags.revision, 'revision'), generation: generation(),
        reason: need(flags.reason, 'reason'), draft: draft() }; break;
      default: this.error(t('未知知识操作。请运行 omk observe knowledge --help。', 'Unknown knowledge operation. Run omk observe knowledge --help.'), { exit: 2 });
    }
    const checked = KnowledgeOperationSchema.safeParse(operation!);
    if (!checked.success) this.error(t('操作参数无效，请核对身份、页码及输入格式。', 'Invalid operation parameters; check identities, page bounds and input format.') + '\n' + checked.error.issues.map(issue => issue.path.join('.')).join(', '), { exit: 2 });
    // Validation must not rewrite literal CLI paths, identities or reason bytes.
    const settings = new UserSettingsStore().resolve({ workspace: flags.workspace, executor: flags.executor, model: flags.model });
    const app = createLocalKnowledgeApplication(settings.workspace);
    if (operation.operation === 'generate') operation = { ...operation, executor: settings.executor, model: need(settings.model, 'model') };
    await this.runWithCancellation(async signal => {
      if (operation.operation === 'generate') this.logToStderr(`${operation.executor} / ${operation.model} · ${operation.snapshot} · ${t('仅发送选定来源片段；费用以执行器实际报告为准。', 'Only selected excerpts are sent; cost depends on executor reporting.')}`);
      let result: unknown;
      try { result = await executeKnowledgeOperation(app, operation, signal, (executor, model, policy) => configuredExtractionModel(executor, model,
        createExtractionArchiveProducer(process.env), policy?.policyId === 'knowledge-generation-bounded/v1' ? { maxOutputTokens: policy.maxOutputTokens } : undefined)); }
      catch (cause) {
        const code = knowledgeFailureCode(cause);
        const reload = operation.operation === 'correct-entities' ? knowledgeCommand(settings.workspace, 'entities', { analysis: operation.analysisId })
          : 'id' in operation && operation.operation !== 'resume' ? knowledgeCommand(settings.workspace, 'show', { id: operation.id })
          : knowledgeCommand(settings.workspace, 'runs');
        if (code === 'knowledge_conflict') this.error(`${code} · ${t('记录已变化。先重读最新修订与 generation，再核对草稿后重试；不要覆盖他人的修改。', 'The record changed. Reload its latest revision and generation, review your draft, then retry without overwriting another edit.')}\n${reload}`);
        if (code === 'knowledge_workspace_busy') this.error(`${code} · ${t('工作区正在写入。等待当前操作结束后重试；不要删除仍在使用的锁。', 'The workspace is being written. Retry after the current operation finishes; do not remove a live lock.')}`);
        if (code === 'knowledge_storage_unsupported') this.error(`${code} · ${t('所选工作区含不支持的记录。请核对目录；如需重新提炼，选择新的空目录，不改写旧记录。', 'This workspace contains unsupported records. Check the directory; use a new empty workspace to extract again, preserving old records.')}`);
        if (signal.aborted) this.error(t('操作已中断。先读取提炼运行；resume 只恢复已保存结果，不再次调用模型。', 'Operation interrupted. Inspect extraction runs first; resume restores saved results without another model call.') + `\n${knowledgeCommand(settings.workspace, 'runs')}`);
        if (cause instanceof z.ZodError) this.error(t('草稿内容未通过校验。核对以下字段后重试；原记录未改写。', 'Draft validation failed. Review the following fields and retry; saved records were not changed.') + '\n' + cause.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('\n'));
        if (operation.operation === 'capture') this.error(t('来源归档未完成。核对 --source 的路径、读取权限、日志格式与记录范围后重试。', 'Source capture did not finish. Check --source path, read permissions, log format and record range before retrying.') + '\n' + (cause instanceof Error ? cause.message : String(cause)));
        if (operation.operation === 'generate' || operation.operation === 'resume') this.error(t('提炼或恢复未完成。先核对已保存运行；有持久化结果时使用 resume，不要盲目启动新的模型调用。', 'Extraction or recovery did not finish. Inspect saved runs first; use resume when output was persisted instead of blindly starting another model call.') + '\n' + (cause instanceof Error ? cause.message : String(cause)) + `\n${knowledgeCommand(settings.workspace, 'runs', { json: true })}`);
        throw cause;
      }
      this.log(flags.json ? JSON.stringify(result, null, 2) : formatKnowledgeResult(result, this.lang, operation, settings.workspace));
      if (result && typeof result === 'object' && 'status' in result && ['failed', 'cancelled'].includes(String(result.status))) this.exit(1);
    });
  }
}
