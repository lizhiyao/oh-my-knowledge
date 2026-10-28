import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { prepareKnowledgeMigration, applyKnowledgeMigration } from '../../../knowledge/adapters/knowledge-migration.js';
import { FileExtractionRunStore } from '../../../knowledge/adapters/run-store.js';
import { ExtractionRunSealRequestSchema, ExtractionRunSealError } from '../../../knowledge/extraction/run-sealing.js';
import { ExtractionStudyInspectionError, ExtractionStudyFileError } from '../../../knowledge/adapters/study-inspection-errors.js';
import { inspectExtractionStudyFiles } from '../../../knowledge/application/study-inspection-service.js';
import { formatKnowledgeStudy } from '../../lib/knowledge-study-output.js';
import { lstatSync, readFileSync } from 'node:fs';
import { Args, Flags } from '@oclif/core';
import { z } from 'zod';
import { BaseCommand } from '../../oclif/base-command.js';
import { LANG_FLAG, bilingual } from '../../oclif/i18n.js';
import { UserSettingsStore } from '../../../evidence/storage/user-settings.js';
import { createLocalKnowledgeApplication } from '../../../knowledge/application/local.js';
import { createExtractionArchiveProducer } from '../../../executors/archive.js';
import { configuredKnowledgeGenerationModel } from '../../../knowledge/adapters/generation-executor.js';
import { BODY_GENERATION_PROFILE, ASSOCIATION_GENERATION_PROFILE } from '../../../knowledge/extraction/body-generation-wire.js';
import { KnowledgeOperationSchema, executeKnowledgeOperation, knowledgeFailureCode, type KnowledgeOperation } from '../../../knowledge/application/operations.js';
import { KnowledgeRetrievalBudgetError } from '../../../knowledge/application/retrieval.js';
import { formatKnowledgeResult } from '../../lib/knowledge-output.js';

const description = (zh: string, en: string) => bilingual({ zh, en });
const studyFlags = ['evidence', 'author-review', 'reference-review', 'output-review', 'judge-review'] as const;
export default class ObserveKnowledge extends BaseCommand {
  static description = description('生成并维护完整知识正文，独立审查派生关联。正文保存为 pending，匹配引文不证明真值。', 'Generate and maintain complete knowledge bodies, with separately reviewed derived associations. Saved bodies are pending; matching quotes does not verify truth.');
  static args = { operation: Args.string({ required: true, options: ['schema', 'study', 'seal-run', 'sealed-runs', 'migrate', 'capture', 'generate', 'runs', 'inspect', 'quality', 'resume', 'continue-stage', 'rebuild-associations', 'retrieve', 'list', 'show', 'retain', 'discard', 'revise', 'source', 'delete-source', 'entities', 'correct-entities', 'apply-associations', 'review-associations'],
    description: description('generate 先保存正文再生成关联；resume 零模型恢复，continue-stage 仅发送尚未 claim 的阶段。', 'generate saves body before associations; resume recovers without models; continue-stage dispatches only a never-claimed phase.') }) };
  static flags = {
    lang: LANG_FLAG,
    'from-workspace': Flags.string({ description: description('migrate：显式旧 v2 工作区，原件逐字保留；须同时明确 --workspace 新目标，零模型迁移。', 'migrate: explicit legacy v2 workspace, preserving originals byte-for-byte; also requires an explicit new --workspace target, without models.') }),
    'operation-id': Flags.string({ description: description('seal-run：稳定的人工操作 UUID，重入必须复用。', 'seal-run: stable human operation UUID; reuse it on replay.') }),
    operator: Flags.string({ description: description('seal-run：显式声明的人类操作者身份，不认证真人。', 'seal-run: explicitly declared human actor identity; not authenticated human identity.') }),
    'manifest-digest': Flags.string({ description: description('seal-run：sealed-runs 预先查询的原 manifest SHA-256。', 'seal-run: original manifest SHA-256 from sealed-runs.') }),
    'inventory-digest': Flags.string({ description: description('seal-run：sealed-runs 预先查询的精确归档清单 SHA-256。', 'seal-run: exact inventory SHA-256 from sealed-runs.') }),
    'storage-namespace': Flags.string({ options: ['current', 'legacy'], description: description('封存／查询 current extraction-runs/ 或明确选择的 legacy runs/，默认 current。', 'Seal/query current extraction-runs/ or explicitly selected legacy runs/; current by default.') }),
    offline: Flags.boolean({ description: description('seal-run：声明相关旧程序已停写／离线，不代表进程退出证明；opaque 封存必填。', 'seal-run: declare legacy writers stopped/offline, not proof of process exit; required for opaque sealing.') }),

    evidence: Flags.string({ description: description('study：仓内研究工具导出的 evidence.json，只读重算原始证据；所有输入合计最多 128 MiB，不读取知识工作区。', 'study: evidence.json exported by the repository study tool; recompute original evidence read-only, with at most 128 MiB across all inputs and no knowledge workspace access.') }),
    'author-review': Flags.string({ description: description('study：输出前作者参考复核 JSON 文件。', 'study: pre-output author reference review JSON file.') }),
    'reference-review': Flags.string({ description: description('study：输出前独立真人参考复核 JSON 文件，缺失时不产生 goldReady。', 'study: pre-output independent human reference review JSON file; absence cannot produce goldReady.') }),
    'output-review': Flags.string({ description: description('study：绑定实际输出的逐项复核 JSON 文件；AI 探索不代表独立真人通过。', 'study: item review JSON file bound to the actual outputs; exploratory AI review is not independent human acceptance.') }),
    'judge-review': Flags.string({ description: description('study：带版本身份和独立用量声明的模型评委 JSON 文件，与人工判断比较；不执行评委。', 'study: model-judge review JSON with version identity and separate declared usage, compared with human judgments; does not execute the judge.') }),
    workspace: Flags.string({ description: description('显式知识工作区，省略使用设置。', 'Explicit knowledge workspace; defaults to settings.') }),
    source: Flags.string({ description: description('capture：支持格式的 Agent 会话日志。', 'capture: supported agent session log.') }),
    'start-record': Flags.integer({ min: 0, description: description('首条非空记录序号（包含）。', 'First nonempty record index, inclusive.') }),
    'end-record': Flags.integer({ min: 0, description: description('末条记录序号（包含）。', 'Last record index, inclusive.') }),
    snapshot: Flags.string({ description: description('来源 snapshot UUID。retrieve 可限定来源段落。', 'Source snapshot UUID; retrieve may scope body segments to it.') }),
    id: Flags.string({ description: description('知识 ID；inspect/resume/continue-stage 为运行 UUID。', 'Knowledge ID; run UUID for inspect/resume/continue-stage.') }),
    revision: Flags.string({ description: description('明确知识或派生修订身份。', 'Exact knowledge or projection revision identity.') }),
    'body-digest': Flags.string({ description: description('rebuild/apply-associations：精确正文 sha256 摘要。', 'rebuild/apply-associations: exact body sha256 digest.') }),
    analysis: Flags.string({ description: description('明确实体分析 UUID，省略时 entities 搜索目录。', 'Exact entity analysis UUID; entities searches catalog when omitted.') }),
    'entity-revision': Flags.string({ description: description('明确实体分析修订 UUID。', 'Exact entity analysis revision UUID.') }),
    query: Flags.string({ description: description('retrieve 必填自然问题；ASCII/代码及中文连续/双字片段字面召回，不作语义推断。', 'Required natural question for retrieve; literal ASCII/code and Han run/bigram recall, without semantic inference.') }),
    'max-bytes': Flags.integer({ min: 1024, max: 1048576, description: description('retrieve 完整 JSON+换行 UTF-8 预算，默认 65536，可显式设 8192；不是正文上限。整段省略，不截条件。', 'retrieve complete JSON plus newline UTF-8 budget, default 65536, with explicit 8192 supported; not a body limit. Omit complete segments, never truncate conditions.') }),
    'include-candidates': Flags.boolean({ description: description('retrieve 显式纳入未保留候选，不表示内容真值已确认；已舍弃修订始终排除。', 'retrieve explicitly includes unretained candidates without verified truth; discarded revisions remain excluded.') }),
    'source-version': Flags.string({ description: description('retrieve 精确来源 sha256，须配 --snapshot。', 'retrieve exact source sha256, requiring --snapshot.') }),
    'entity-id': Flags.string({ description: description('retrieve 按当前正文 revision/hash 匹配的派生段关联限定精确实体 ID，显示独立复核状态；已拒绝关联不命中，不按名称合并。', 'retrieve scopes exact entity IDs through derived segment associations matching the current body revision/hash, with independent review status; rejected associations do not match and names are never merged.') }),
    'identity-status': Flags.string({ options: ['all', 'proposed', 'unresolved'], description: description('entities 身份状态筛选。', 'entities identity status filter.') }),
    'source-status': Flags.string({ options: ['all', 'available', 'unavailable'], description: description('entities 来源可读状态筛选。', 'entities source availability filter.') }),
    page: Flags.integer({ min: 1, max: 100000, description: description('entities 页码。', 'entities page number.') }),
    'page-size': Flags.integer({ min: 1, max: 100, description: description('entities 每页条数。', 'entities page size.') }),
    generation: Flags.integer({ min: 0, description: description('预先读取的 generation，防并发覆盖。', 'Previously read generation, preventing concurrent overwrite.') }),
    reason: Flags.string({ description: description('修订或维护理由。保留和关联审查均不证明真值。', 'Revision or maintenance reason. Retention and association review do not verify truth.') }),
    input: Flags.string({ description: description('完整新正文/实体/派生草稿 JSON 文件，不修改原修订。', 'Complete new body/entity/projection JSON draft file; original revisions remain immutable.') }),
    choice: Flags.string({ options: ['accept', 'reject'], description: description('review-associations：派生修订的明确审查决定。', 'review-associations: explicit projection review decision.') }),
    executor: Flags.string({ description: description('生成/继续/重建的执行器。', 'Executor for generation/continuation/rebuild.') }),
    model: Flags.string({ description: description('生成模型，沿用已配置模型。', 'Generation model, defaulting to configuration.') }),
    'run-id': Flags.string({ description: description('生成/重建稳定 UUID；重复只恢复，绝不重发模型。', 'Stable generation/rebuild UUID; repeat only recovers, never redispatches a model.') }),
    stage: Flags.string({ options: ['body', 'association'], description: description('schema：响应阶段，默认 body。', 'schema response stage, default body.') }),
    json: Flags.boolean({ default: false, description: description('完整 JSON；retrieve 始终单行预算内 JSON。', 'Complete JSON; retrieve always emits budgeted single-line JSON.') }),
  };
  static examples = [
    '<%= config.bin %> observe knowledge migrate --from-workspace ./old-knowledge --workspace ./new-body-knowledge --json',
    '<%= config.bin %> observe knowledge study --evidence ./evidence.json --json',
    '<%= config.bin %> observe knowledge sealed-runs --workspace ./knowledge --id <run-id> --json',
    '<%= config.bin %> observe knowledge seal-run --workspace ./knowledge --id <run-id> --operation-id <uuid> --operator <human-id> --reason "reviewed offline disposition" --manifest-digest sha256:<digest> --inventory-digest sha256:<digest> --offline --json',
    '<%= config.bin %> observe knowledge capture --workspace ./knowledge --source ./session.jsonl',
    '<%= config.bin %> observe knowledge generate --workspace ./knowledge --snapshot <snapshot-id> --executor codex --model <model>',
    '<%= config.bin %> observe knowledge inspect --workspace ./knowledge --id <run-id> --json',
    '<%= config.bin %> observe knowledge resume --workspace ./knowledge --id <run-id>',
    '<%= config.bin %> observe knowledge continue-stage --workspace ./knowledge --id <run-id> --generation 5',
    '<%= config.bin %> observe knowledge retrieve --workspace ./knowledge --query "初始化时的条件是什么？" --max-bytes 8192 --include-candidates',
    '<%= config.bin %> observe knowledge revise --workspace ./knowledge --id <knowledge-id> --revision <revision-id> --generation 1 --input ./body.json --reason "核对来源"',
  ];
  async run(): Promise<void> {
    const { args, flags } = await this.parse(ObserveKnowledge), t = (zh: string, en: string) => this.lang === 'zh' ? zh : en;
    if (args.operation !== 'migrate' && flags['from-workspace'] !== undefined) this.error(t('--from-workspace 仅用于 migrate。', '--from-workspace is only valid for migrate.'), { exit: 2 });
    if (args.operation === 'migrate') {
      const allowed = new Set(['from-workspace', 'workspace', 'json', 'lang']);
      if (!flags['from-workspace']?.trim() || !flags.workspace?.trim()
        || Object.entries(flags).some(([name, value]) => value !== undefined && value !== false && !allowed.has(name))) {
        this.error(t('migrate 必须显式提供 --from-workspace 旧目录和 --workspace 独立新目标，只接受迁移路径、--json、--lang；不读取默认设置或调用模型。', 'migrate requires explicit --from-workspace source and a separate new --workspace target; only migration paths, --json and --lang are accepted. No default settings or models are used.'), { exit: 2 });
      }
      try {
        const plan = prepareKnowledgeMigration({ sourceRoot: flags['from-workspace']!, targetRoot: flags.workspace!, namespace: 'local',
          actor: { actorKind: 'human', actorId: 'local-user' }, at: new Date().toISOString(), migrationId: randomUUID() });
        const result = applyKnowledgeMigration(plan, plan.planDigest);
        this.log(JSON.stringify({ ...result, migrationId: plan.migrationId, sourceRoot: plan.sourceRoot, targetRoot: plan.targetRoot,
          originalBytesPreserved: true, modelCalls: 0, semanticAcceptance: false, limitations: plan.limitations }, null, 2));
      } catch (cause) {
        this.error(`${t('迁移未完成；保留原目录和目标中的计划/原件，不清理或覆盖。', 'Migration did not complete; preserve the source and target plan/originals without cleanup or overwrite.')}\n${cause instanceof Error ? cause.message : String(cause)}`, { exit: 1 });
      }
      return;
    }
    if (args.operation !== 'study' && studyFlags.some(name => flags[name] !== undefined)) {
      this.error(t('--evidence 及研究复核参数仅用于 study。', '--evidence and study review flags are only valid for study.'), { exit: 2 });
    }
    if (args.operation === 'study') {
      const allowed = new Set<string>([...studyFlags, 'lang', 'json']);
      if (Object.entries(flags).some(([name, value]) => value !== undefined && value !== false && !allowed.has(name))) {
        this.error(t('study 仅接受 --evidence、研究复核参数、--lang 和 --json，不接受工作区或生成参数。', 'study accepts only --evidence, study review flags, --lang and --json; workspace and generation flags are not allowed.'), { exit: 2 });
      }
      if (!flags.evidence?.trim()) this.error(t('study 必须提供 --evidence。', 'study requires --evidence.'), { exit: 2 });
      await this.runWithCancellation(async studySignal => {
        try {
          const result = await inspectExtractionStudyFiles({ evidence: flags.evidence!,
            ...(flags['author-review'] === undefined ? {} : { authorReceipt: flags['author-review'] }),
            ...(flags['reference-review'] === undefined ? {} : { referenceReceipt: flags['reference-review'] }),
            ...(flags['output-review'] === undefined ? {} : { outputReceipt: flags['output-review'] }),
            ...(flags['judge-review'] === undefined ? {} : { judgeReceipt: flags['judge-review'] }) }, studySignal);
          this.log(flags.json ? JSON.stringify(result, null, 2) : formatKnowledgeStudy(result, this.lang));
        } catch (cause) {
          if (cause instanceof ExtractionStudyFileError) {
            this.error(t(`${cause.label} 不可读或格式无效；请使用普通 UTF-8 JSON 文件，所有研究输入合计不超过 128 MiB。`, `${cause.label} is unreadable or invalid; use regular UTF-8 JSON files totaling at most 128 MiB.`), { exit: 2 });
          }
          const code = cause instanceof ExtractionStudyInspectionError ? cause.code : 'knowledge_study_evidence_invalid';
          if (code === 'knowledge_study_busy' || code === 'knowledge_study_unavailable') {
            this.error(`${code} · ${code === 'knowledge_study_busy'
              ? t('另一个研究核对正在运行，请等待结束后重试。', 'Another study inspection is running; wait for it to finish and retry.')
              : t('核对工作进程异常或已取消，请重试；没有调用模型或改写工作区。', 'The inspection worker failed or was cancelled; retry. No model was called and no workspace was changed.')}`, { exit: 1 });
          }
          if (code === 'knowledge_study_capacity_exceeded') {
            this.error(`${code} · ${t('所有研究输入封装后的 JSON 合计不得超过 128 MiB。', 'The complete serialized study input must not exceed 128 MiB.')}`, { exit: 2 });
          }
          this.error(`${code} · ${t('研究证据未通过核对。请使用冻结时匹配的版本并检查完整导出与复核绑定；没有调用模型或改写工作区。', 'Study evidence could not be verified. Use its matching frozen version and check the complete export and review bindings; no model call or workspace change was made.')}`, { exit: 1 });
        }
      });
      return;
    }
    const sealOperations = ['seal-run', 'sealed-runs'];
    const sealFlags = ['operation-id', 'operator', 'manifest-digest', 'inventory-digest', 'storage-namespace', 'offline'];
    if (!sealOperations.includes(args.operation) && sealFlags.some(name => flags[name as keyof typeof flags] !== undefined && flags[name as keyof typeof flags] !== false)) {
      this.error(t('封存参数仅用于 seal-run／sealed-runs。', 'Seal flags are only valid for seal-run/sealed-runs.'), { exit: 2 });
    }
    if (sealOperations.includes(args.operation)) {
      const allowed = new Set(['workspace', 'id', 'json', 'lang', 'storage-namespace', ...(args.operation === 'seal-run' ? [...sealFlags, 'reason'] : [])]);
      if (Object.entries(flags).some(([name, value]) => value !== undefined && value !== false && !allowed.has(name))) {
        this.error(t('封存只接受工作区、运行及明确人工处置参数，不接受生成参数。', 'Sealing accepts only workspace, run and explicit human-disposition flags; generation flags are not accepted.'), { exit: 2 });
      }
      if (!flags.workspace?.trim()) this.error(t('封存操作必须显式提供 --workspace，不读取全局设置。', 'Sealing requires explicit --workspace and does not read global settings.'), { exit: 2 });
      const namespace = flags['storage-namespace'] === 'legacy' ? 'legacy' as const : 'current' as const;
      if (flags.id !== undefined && !z.string().uuid().safeParse(flags.id).success) this.error(t('--id 必须是运行 UUID。', '--id must be a run UUID.'), { exit: 2 });
      let request: z.infer<typeof ExtractionRunSealRequestSchema> | undefined;
      if (args.operation === 'seal-run') {
        const checked = ExtractionRunSealRequestSchema.safeParse({ runId: flags.id, operationId: flags['operation-id'], storageNamespace: namespace,
          actor: { actorKind: 'human', actorId: flags.operator }, reason: flags.reason, expectedManifestDigest: flags['manifest-digest'],
          expectedInventoryDigest: flags['inventory-digest'], offlineDeclared: flags.offline === true });
        if (!checked.success) this.error(t('请提供 --id、--operation-id、--operator、--reason 及预先查询到的 --manifest-digest／--inventory-digest。', 'Provide --id, --operation-id, --operator, --reason and the previously inspected --manifest-digest/--inventory-digest.'), { exit: 2 });
        request = checked.data;
      }
      try {
        const workspace = resolve(flags.workspace!), store = new FileExtractionRunStore(join(workspace, 'extraction-runs'), workspace);
        const result = request ? store.seal(request) : flags.id ? store.inspectSeal(flags.id, namespace) : store.listSeals();
        const safe = (value: unknown) => { if (!value || typeof value !== 'object') return value; const copy = { ...value } as Record<string, unknown>; delete copy.originalRun; return copy; };
        const value = Array.isArray(result) ? result.filter(item => flags['storage-namespace'] === undefined || item.request.storageNamespace === namespace).map(safe) : safe(result);
        if (flags.json) this.log(JSON.stringify(value, null, 2));
        else this.log([t('人工封存／执行状态未知；不代表成功、费用已知、进程退出或语义通过。', 'Human disposition / execution unknown; this does not establish success, known costs, process exit or semantic acceptance.'), JSON.stringify(value, null, 2)].join('\n\n'));
      } catch (cause) {
        const code = cause instanceof ExtractionRunSealError ? cause.sealCode : 'run_seal_unconfirmed';
        this.error(`${code} · ${t('封存未获确认。保留所有文件，先查询 sealed-runs；只用同一操作身份与原证据重入，不删除 marker／intent 或另起运行。', 'Sealing was not confirmed. Preserve all files and inspect sealed-runs; retry only the same operation and original evidence, without removing marker/intent or starting another run.')}`, { exit: 1 });
      }
      return;
    }
    const need = (value: string | undefined, name: string) => { if (!value?.trim()) this.error(`--${name} ${t('必填', 'is required')}`, { exit: 2 }); return value!; };
    if (args.operation === 'schema') {
      const profile = flags.stage === 'association' ? ASSOCIATION_GENERATION_PROFILE : BODY_GENERATION_PROFILE;
      this.log(JSON.stringify({ profileId: profile.profileId, promptVersion: profile.promptVersion, wireId: profile.wireId, schema: profile.wireSchema }, null, 2)); return;
    }
    if (flags.stage !== undefined) this.error(t('--stage 仅用于 schema。', '--stage is only valid for schema.'), { exit: 2 });
    if (args.operation === 'retrieve') {
      const allowed = new Set(['workspace', 'query', 'max-bytes', 'include-candidates', 'snapshot', 'source-version', 'entity-id', 'lang', 'json']);
      if (Object.entries(flags).some(([name, value]) => value !== undefined && value !== false && !allowed.has(name))) this.error(t('retrieve 仅接受只读检索参数。', 'retrieve accepts read-only retrieval flags only.'), { exit: 2 });
    } else if (flags['max-bytes'] !== undefined || flags['include-candidates'] || flags['source-version'] !== undefined || flags['entity-id'] !== undefined) this.error(t('检索参数仅用于 retrieve。', 'Retrieval flags are only valid for retrieve.'), { exit: 2 });
    const generation = () => { if (flags.generation === undefined) this.error('--generation is required', { exit: 2 }); return flags.generation!; };
    const draft = () => { const path = need(flags.input, 'input'); try {
      const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw new Error('invalid file');
      const bytes = readFileSync(path), text = bytes.toString('utf8'); if (!Buffer.from(text).equals(bytes)) throw new Error('invalid UTF-8'); return JSON.parse(text) as unknown;
    } catch { this.error(t('--input 必须是 16 MiB 内的普通 UTF-8 JSON 文件。', '--input must be a regular UTF-8 JSON file within 16 MiB.'), { exit: 2 }); } };
    let operation: KnowledgeOperation;
    switch (args.operation) {
      case 'retrieve': operation = { operation: 'retrieve', query: need(flags.query, 'query'), maxBytes: flags['max-bytes'], includeCandidates: flags['include-candidates'], snapshot: flags.snapshot, sourceVersion: flags['source-version'], entityId: flags['entity-id'] }; break;
      case 'capture': operation = { operation: 'capture', source: need(flags.source, 'source'), startRecord: flags['start-record'], endRecord: flags['end-record'] }; break;
      case 'generate': operation = { operation: 'generate', snapshot: need(flags.snapshot, 'snapshot'), executor: 'configured', model: 'configured', runId: flags['run-id'] }; break;
      case 'continue-stage': operation = { operation: 'continue-stage', id: need(flags.id, 'id'), generation: generation(), executor: 'configured', model: 'configured' }; break;
      case 'rebuild-associations': operation = { operation: 'rebuild-associations', knowledgeId: need(flags.id, 'id'), revisionId: need(flags.revision, 'revision'), bodyDigest: need(flags['body-digest'], 'body-digest'), executor: 'configured', model: 'configured', runId: flags['run-id'] }; break;
      case 'runs': case 'quality': case 'list': operation = { operation: args.operation }; break;
      case 'inspect': case 'resume': operation = { operation: args.operation, id: need(flags.id, 'id') }; break;
      case 'show': operation = { operation: 'show', id: need(flags.id, 'id'), revision: flags.revision }; break;
      case 'entities': operation = flags.analysis ? { operation: 'entities', analysisId: flags.analysis, revision: flags['entity-revision'] }
        : { operation: 'entity-catalog', query: flags.query, identityStatus: flags['identity-status'] as 'all' | 'proposed' | 'unresolved' | undefined, sourceStatus: flags['source-status'] as 'all' | 'available' | 'unavailable' | undefined, page: flags.page, pageSize: flags['page-size'] }; break;
      case 'correct-entities': operation = { operation: 'correct-entities', analysisId: need(flags.analysis, 'analysis'), revision: need(flags['entity-revision'], 'entity-revision'), generation: generation(), draft: draft(), reason: need(flags.reason, 'reason') }; break;
      case 'source': case 'delete-source': operation = { operation: args.operation, snapshot: need(flags.snapshot, 'snapshot') }; break;
      case 'retain': case 'discard': operation = { operation: 'maintain', id: need(flags.id, 'id'), revision: need(flags.revision, 'revision'), generation: generation(), choice: args.operation, reason: need(flags.reason, 'reason') }; break;
      case 'review-associations': operation = { operation: 'review-associations', id: need(flags.id,'id'), revision: need(flags.revision,'revision'), generation: generation(), choice: need(flags.choice,'choice') as 'accept'|'reject', reason: need(flags.reason,'reason') }; break;
      case 'apply-associations': operation = { operation: 'apply-associations', id: need(flags.id,'id'), revision: need(flags.revision,'revision'), bodyDigest: need(flags['body-digest'],'body-digest'), analysisId: need(flags.analysis,'analysis'), entityRevision: need(flags['entity-revision'],'entity-revision'), generation: generation(), draft: draft(), reason: need(flags.reason,'reason') }; break;
      case 'revise': operation = { operation: 'revise', id: need(flags.id, 'id'), revision: need(flags.revision, 'revision'), generation: generation(), draft: draft(), reason: need(flags.reason, 'reason') }; break;
      default: this.error(t('该操作尚不可用。', 'This operation is unavailable.'), { exit: 2 });
    }
    const checked = KnowledgeOperationSchema.safeParse(operation!);
    if (!checked.success) this.error(t('操作参数无效。', 'Invalid operation parameters.') + '\n' + checked.error.issues.map(i => i.path.join('.')).join(', '), { exit: 2 });
    const settings = new UserSettingsStore().resolve({ workspace: flags.workspace, executor: flags.executor, model: flags.model });
    if (['generate', 'continue-stage', 'rebuild-associations'].includes(operation.operation)) operation = { ...operation, executor: settings.executor, model: need(settings.model, 'model') } as KnowledgeOperation;
    const app = createLocalKnowledgeApplication(settings.workspace);
    await this.runWithCancellation(async signal => {
      let result: unknown;
      try { result = await executeKnowledgeOperation(app, operation, signal, (executor, model) => configuredKnowledgeGenerationModel(executor, model, createExtractionArchiveProducer(process.env))); }
      catch (cause) {
        if (cause instanceof KnowledgeRetrievalBudgetError) this.error(`${cause.message}`, { exit: 2 });
        const code = knowledgeFailureCode(cause);
        const detail = cause instanceof z.ZodError ? cause.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('\n') : cause instanceof Error ? cause.message : String(cause);
        this.error(`${code} · ${detail}\n${t('先 inspect/runs 核对状态；resume 不发送模型，unknown claim 禁止重发。', 'Inspect runs first; resume does not dispatch models and unknown claims must not be redispatched.')}`, { exit: 1 });
      }
      this.log(operation.operation === 'retrieve' ? JSON.stringify(result) : flags.json ? JSON.stringify(result, null, 2) : formatKnowledgeResult(result, this.lang, operation, settings.workspace));
      if (result && typeof result === 'object' && 'journal' in result && (result.journal as { status: string }).status !== 'completed') this.exit(1);
    });
  }
}
