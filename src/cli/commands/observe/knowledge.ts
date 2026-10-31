import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { prepareKnowledgeMigration, applyKnowledgeMigration } from '../../../knowledge/adapters/knowledge-migration.js';
import { prepareAssociationMigration, applyAssociationMigration, type AssociationMigrationPlan } from '../../../knowledge/adapters/association-migration.js';
import { prepareSourceMigration, applySourceMigration, SOURCE_MIGRATION_PLAN_MAX_BYTES, type SourceMigrationPlan } from '../../../knowledge/adapters/source-migration.js';
import { planKnowledgeWorkflowMigration, applyKnowledgeWorkflowMigration, type KnowledgeWorkflowMigrationPlan } from '../../../knowledge/adapters/workflow-migration.js';
import { SourceCoverageDecisionRefSchema } from '../../../knowledge/source-review.js';
import { SOURCE_LEDGER_GENERATION_PROFILE, SOURCE_COVERAGE_GENERATION_PROFILE } from '../../../knowledge/extraction/source-review-wire.js';
import { readLocalSourceScope } from '../../../knowledge/application/local-source-host.js';
import { SourceDigestSchema, SourceRefSchema, ResolvedSourceSelectionSchema } from '../../../knowledge/sources.js';
import { FileExtractionRunStore } from '../../../knowledge/adapters/run-store.js';
import { ExtractionRunSealRequestSchema, ExtractionRunSealError } from '../../../knowledge/extraction/run-sealing.js';
import { ExtractionStudyInspectionError, ExtractionStudyFileError } from '../../../knowledge/adapters/study-inspection-errors.js';
import { inspectExtractionStudyFiles } from '../../../knowledge/application/study-inspection-service.js';
import { formatKnowledgeStudy } from '../../lib/knowledge-study-output.js';
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { Args, Flags } from '@oclif/core';
import { z } from 'zod';
import { BaseCommand } from '../../oclif/base-command.js';
import { LANG_FLAG, bilingual } from '../../oclif/i18n.js';
import { UserSettingsStore } from '../../../evidence/storage/user-settings.js';
import { createLocalKnowledgeApplication, createLocalKnowledgeReview, createLocalKnowledgeRelations } from '../../../knowledge/application/local.js';
import { createLocalKnowledgeGenerationModel } from '../../../knowledge/adapters/generation-host.js';
import { createExtractionArchiveProducer } from '../../../executors/archive.js';
import { BODY_GENERATION_PROFILE, ASSOCIATION_GENERATION_PROFILE } from '../../../knowledge/extraction/body-generation-wire.js';
import { KnowledgeOperationSchema, knowledgeOperationSchemas, executeKnowledgeOperation, knowledgeFailureCode, type KnowledgeOperation } from '../../../knowledge/application/operations.js';
import { KnowledgeRetrievalBudgetError } from '../../../knowledge/application/retrieval.js';
import { formatKnowledgeResult } from '../../lib/knowledge-output.js';
import { knowledgeReviewCliActor } from '../../lib/knowledge-review-actor.js';
import { KnowledgeReviewOperationSchema, executeKnowledgeReviewOperation } from '../../../knowledge/application/review-operations.js';
import { KnowledgeRelationOperationSchema, executeKnowledgeRelationOperation, knowledgeRelationFailureCode } from '../../../knowledge/application/relation-operations.js';
import { KnowledgeGraphRequestSchema } from '../../../knowledge/application/graph.js';

const description = (zh: string, en: string) => bilingual({ zh, en });
const studyFlags = ['evidence', 'author-review', 'reference-review', 'output-review', 'judge-review'] as const;
function readInputJson(path: string, maxBytes = 16 * 1024 * 1024): unknown {
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(maxBytes)) throw new Error('Invalid input file.');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) throw new Error('Input binding changed.');
    const buffer = Buffer.allocUnsafe(Number(before.size) + 1); let offset = 0;
    while (offset < buffer.length) { const count = readSync(fd, buffer, offset, buffer.length - offset, null); if (!count) break; offset += count; }
    const bytes = buffer.subarray(0, offset), after = fstatSync(fd, { bigint: true }), named = lstatSync(path, { bigint: true });
    if (offset !== Number(before.size) || [after, named].some(stat => stat.ino !== before.ino || stat.dev !== before.dev || stat.size !== before.size
      || stat.mtimeNs !== before.mtimeNs || stat.ctimeNs !== before.ctimeNs || !stat.isFile() || stat.isSymbolicLink())) throw new Error('Input changed during read.');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally { closeSync(fd); }
}
export default class ObserveKnowledge extends BaseCommand {
  static description = description('生成并维护完整知识正文，独立审查派生关联。正文保存为 pending，匹配引文不证明真值。', 'Generate and maintain complete knowledge bodies, with separately reviewed derived associations. Saved bodies are pending; matching quotes does not verify truth.');
  static args = { operation: Args.string({ required: true, options: ['schema', 'study', 'seal-run', 'sealed-runs', 'migrate', 'migrate-associations', 'migrate-sources', 'migrate-workflow', 'source-ledger', 'source-coverage-status', 'review-source-coverage', 'prepare-source-review', 'preview-sources', 'capture', 'prepare-generation', 'generate', 'runs', 'inspect', 'quality', 'resume', 'continue-stage', 'prepare-rebuild-associations', 'rebuild-associations', 'retrieve', 'list', 'show', 'retain', 'discard', 'revise', 'source', 'source-updates', 'delete-source', 'entities', 'correct-entities', 'apply-associations', 'review-associations', 'review-status', 'review-content', 'review-coverage', 'record-use', 'graph', 'relations', 'relation', 'propose-relation', 'review-relation', 'withdraw-relation'],
    description: description('preview 只读，capture 仅保存；prepare 展示完整模型请求，generate／continue-stage 须逐阶段确认摘要；resume 零模型恢复。', 'Preview reads only; capture saves only. Prepare displays the complete model request; generate/continue-stage require per-stage digest confirmation. Resume never calls a model.') }) };
  static flags = {
    lang: LANG_FLAG,
    'from-workspace': Flags.string({ description: description('迁移：显式旧工作区；须同时明确 --workspace 独立新目标，零模型迁移并保留原件。', 'Migration: explicit old workspace; requires a separate new --workspace target, preserving originals without models.') }),
    'operation-id': Flags.string({ description: description('seal-run／migrate-associations／migrate-sources：稳定操作 UUID，重入必须复用。', 'seal-run/migrate-associations/migrate-sources: stable operation UUID; reuse it on replay.') }),
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
    scope: Flags.string({ description: description('preview-sources／capture／source-updates：独立可信宿主绑定 JSON（1 MiB 内），声明项目 root 或 trace path；选区 JSON 仅使用逻辑 ID 和相对路径。', 'preview-sources/capture/source-updates: independent trusted host bindings JSON within 1 MiB, declaring project roots or trace paths; selection JSON uses logical IDs and relative paths only.') }),
    'matching-build': Flags.string({ description: description('migrate-sources／migrate-workflow：保留原文件名的匹配版本安装档案（tgz、tar.gz、tar 或 zip）。', 'migrate-sources/migrate-workflow: matching-build installation archive preserving its filename (tgz, tar.gz, tar or zip).') }),
    'matching-build-id': Flags.string({ description: description('migrate-sources／migrate-workflow：宿主声明的旧构建身份；不等同于实际安装和回退已验收。', 'migrate-sources/migrate-workflow: host-declared old build identity; this does not verify installation or rollback.') }),
    'plan-only': Flags.boolean({ description: description('migrate-sources／migrate-workflow：只读导出独立副本迁移计划，不创建目标。', 'migrate-sources/migrate-workflow: export the independent-copy migration plan read-only without creating the target.') }),
    'confirm-plan': Flags.string({ description: description('migrate-sources／migrate-workflow：确认 --input 中固定计划的精确 SHA-256，执行或恢复相同迁移。', 'migrate-sources/migrate-workflow: confirm the exact SHA-256 of the fixed --input plan to apply or resume the same migration.') }),
    snapshot: Flags.string({ description: description('source／delete-source／retrieve：来源 snapshot UUID，必须同时给出 --source-version。', 'source/delete-source/retrieve: source snapshot UUID, requiring --source-version.') }),
    id: Flags.string({ description: description('知识 ID；inspect/resume/continue-stage 为运行 UUID。', 'Knowledge ID; run UUID for inspect/resume/continue-stage.') }),
    revision: Flags.string({ description: description('明确知识或派生修订身份。', 'Exact knowledge or projection revision identity.') }),
    'body-digest': Flags.string({ description: description('relations／rebuild/apply-associations：精确正文 sha256 摘要。', 'relations/rebuild/apply-associations: exact body sha256 digest.') }),
    analysis: Flags.string({ description: description('明确实体分析 UUID，省略时 entities 搜索目录。', 'Exact entity analysis UUID; entities searches catalog when omitted.') }),
    'entity-revision': Flags.string({ description: description('明确实体分析修订 UUID。', 'Exact entity analysis revision UUID.') }),
    query: Flags.string({ description: description('retrieve 必填自然问题；ASCII/代码及中文连续/双字片段字面召回，不作语义推断。', 'Required natural question for retrieve; literal ASCII/code and Han run/bigram recall, without semantic inference.') }),
    format: Flags.string({ options: ['json', 'text'], description: description('仅 retrieve：json 为完整结构，text 为正文消费视图；省略保持 JSON。text 不可与 --json 同用。', 'retrieve only: json returns the complete structure; text returns a content consumption view. Omission preserves JSON. text cannot be combined with --json.') }),
    'max-bytes': Flags.integer({ min: 1024, max: 1048576, description: description('retrieve 所选完整视图加一个换行的 UTF-8 预算，默认 65536，可显式设 8192；不是正文上限。整段省略，不截条件。', 'retrieve complete selected view plus one newline UTF-8 budget, default 65536, with explicit 8192 supported; not a body limit. Omit complete segments, never truncate conditions.') }),
    'include-candidates': Flags.boolean({ description: description('retrieve 显式纳入未保留候选，不表示内容真值已确认；已舍弃修订始终排除。', 'retrieve explicitly includes unretained candidates without verified truth; discarded revisions remain excluded.') }),
    'source-version': Flags.string({ description: description('source／delete-source／retrieve：精确来源 sha256，须配 --snapshot。', 'source/delete-source/retrieve: exact source sha256, requiring --snapshot.') }),
    'entity-id': Flags.string({ description: description('retrieve 须配 --analysis 和 --entity-revision，按当前正文 revision/hash 匹配的派生段关联限定精确实体 ID，显示独立复核状态；已拒绝关联不命中，不按名称合并。', 'retrieve requires --analysis and --entity-revision and scopes exact entity IDs through derived segment associations matching the current body revision/hash, with independent review status; rejected associations do not match and names are never merged.') }),
    'identity-status': Flags.string({ options: ['all', 'proposed', 'unresolved'], description: description('entities 身份状态筛选。', 'entities identity status filter.') }),
    'source-status': Flags.string({ options: ['all', 'available', 'unavailable'], description: description('entities 来源可读状态筛选。', 'entities source availability filter.') }),
    page: Flags.integer({ min: 1, max: 100000, description: description('entities 页码。', 'entities page number.') }),
    'page-size': Flags.integer({ min: 1, max: 100, description: description('entities 每页条数。', 'entities page size.') }),
    generation: Flags.integer({ min: 0, description: description('预先读取的 generation，防并发覆盖。', 'Previously read generation, preventing concurrent overwrite.') }),
    reason: Flags.string({ description: description('修订或维护理由。保留和关联审查均不证明真值。', 'Revision or maintenance reason. Retention and association review do not verify truth.') }),
    input: Flags.string({ description: description('普通 UTF-8 JSON 通常限 16 MiB；固定 migrate-sources 计划单独限 128 MiB。preview-sources 为 {selections}，capture 为完整预览，prepare-generation 为 {sources, sourceCoverageDecisionRef?}；prepare-source-review 为 {sources, bodyRefs, ledgerRef?}；重建为 {sourceCoverageDecisionRef}；来源决定为完整 command，也接受完整修订／复核草稿。', 'Regular UTF-8 JSON is normally limited to 16 MiB; fixed migrate-sources plans have a separate 128 MiB bound. preview-sources uses {selections}, capture the complete preview, prepare-generation uses {sources, sourceCoverageDecisionRef?}, prepare-source-review {sources, bodyRefs, ledgerRef?}, rebuilding {sourceCoverageDecisionRef}, and source review a complete command; revision/review drafts are also accepted.') }),
    choice: Flags.string({ options: ['accept', 'reject'], description: description('review-associations：派生修订的明确审查决定。', 'review-associations: explicit projection review decision.') }),
    'projection-revision': Flags.string({ description: description('review-status：查看精确关联投影的覆盖复核，默认读取该正文匹配的投影。', 'review-status: inspect coverage for an exact association projection; defaults to the projection matching this body.') }),
    executor: Flags.string({ description: description('生成/继续/重建的执行器。', 'Executor for generation/continuation/rebuild.') }),
    model: Flags.string({ description: description('生成模型，沿用已配置模型。', 'Generation model, defaulting to configuration.') }),
    'run-id': Flags.string({ description: description('生成/重建稳定 UUID；重复只恢复，绝不重发模型。', 'Stable generation/rebuild UUID; repeat only recovers, never redispatches a model.') }),
    'confirm-request': Flags.string({ description: description('generate／continue-stage／rebuild-associations：明确确认 prepare／inspect 展示的完整 system/input 对应 requestDigest；每阶段单独确认。', 'generate/continue-stage/rebuild-associations: confirm the requestDigest for the complete system/input shown by prepare/inspect; each phase requires separate confirmation.') }),
    stage: Flags.string({ options: ['source_ledger', 'body', 'source_coverage', 'association'], description: description('schema：响应阶段，默认 body。', 'schema response stage, default body.') }),
    json: Flags.boolean({ default: false, description: description('完整 JSON；retrieve 默认或 --format json 为单行预算内 JSON，不可与 --format text 同用。', 'Complete JSON; retrieve defaults to budgeted single-line JSON, also selected by --format json. Cannot be combined with --format text.') }),
  };
  static examples = [
    '<%= config.bin %> observe knowledge migrate --from-workspace ./old-knowledge --workspace ./new-body-knowledge --json',
    '<%= config.bin %> observe knowledge migrate-associations --from-workspace ./schema1 --workspace ./schema2 --operation-id <uuid> --json',
    '<%= config.bin %> observe knowledge study --evidence ./evidence.json --json',
    '<%= config.bin %> observe knowledge sealed-runs --workspace ./knowledge --id <run-id> --json',
    '<%= config.bin %> observe knowledge seal-run --workspace ./knowledge --id <run-id> --operation-id <uuid> --operator <human-id> --reason "reviewed offline disposition" --manifest-digest sha256:<digest> --inventory-digest sha256:<digest> --offline --json',
    '<%= config.bin %> observe knowledge preview-sources --workspace ./knowledge --scope ./scope.json --input ./selections.json --json',
    '<%= config.bin %> observe knowledge capture --workspace ./knowledge --scope ./scope.json --input ./preview.json --json',
    '<%= config.bin %> observe knowledge source-updates --workspace ./knowledge --scope ./scope.json --input ./source-check.json --json',
    '<%= config.bin %> observe knowledge prepare-generation --workspace ./knowledge --input ./sources.json --executor codex --model <model> --json',
    '<%= config.bin %> observe knowledge generate --workspace ./knowledge --input ./sources.json --executor codex --model <model> --confirm-request sha256:<digest>',
    '<%= config.bin %> observe knowledge migrate-sources --from-workspace ./source2 --workspace ./source3 --operation-id <uuid> --matching-build ./omk-old.tgz --matching-build-id <build-id> --plan-only --json',
    '<%= config.bin %> observe knowledge migrate-sources --input ./migration-plan.json --confirm-plan sha256:<digest> --json',
    '<%= config.bin %> observe knowledge inspect --workspace ./knowledge --id <run-id> --json',
    '<%= config.bin %> observe knowledge resume --workspace ./knowledge --id <run-id>',
    '<%= config.bin %> observe knowledge continue-stage --workspace ./knowledge --id <run-id> --generation 5 --confirm-request sha256:<digest>',
    '<%= config.bin %> observe knowledge retrieve --workspace ./knowledge --query "初始化时的条件是什么？" --max-bytes 8192 --include-candidates',
    '<%= config.bin %> observe knowledge review-status --workspace ./knowledge --id <knowledge-id> --revision <revision-id> --body-digest sha256:<digest> --json',
    '<%= config.bin %> observe knowledge review-content --workspace ./knowledge --input ./review.json --json',
    '<%= config.bin %> observe knowledge relations --workspace ./knowledge --id <knowledge-id> --revision <revision-id> --body-digest sha256:<digest> --json',
    '<%= config.bin %> observe knowledge propose-relation --workspace ./knowledge --input ./relation.json --json',
    '<%= config.bin %> observe knowledge relation --workspace ./knowledge --id <relation-id> --json',
    '<%= config.bin %> observe knowledge graph --workspace ./knowledge --input ./graph-scope.json --json',
    '<%= config.bin %> observe knowledge revise --workspace ./knowledge --id <knowledge-id> --revision <revision-id> --generation 1 --input ./body.json --reason "核对来源"',
  ];
  async run(): Promise<void> {
    const { args, flags } = await this.parse(ObserveKnowledge), t = (zh: string, en: string) => this.lang === 'zh' ? zh : en;
    const sourceFlags: Record<string, string[]> = {
      'preview-sources': ['scope', 'input'], capture: ['scope', 'input'], source: ['snapshot', 'source-version'], 'source-updates': ['scope', 'input'], 'delete-source': ['snapshot', 'source-version'],
      'prepare-generation': ['input', 'executor', 'model', 'run-id'], generate: ['input', 'executor', 'model', 'run-id', 'confirm-request'],
      'continue-stage': ['id', 'generation', 'executor', 'model', 'confirm-request'],
      'prepare-source-review': ['input', 'executor', 'model', 'run-id'],
      'source-ledger': ['id', 'revision'], 'source-coverage-status': ['id', 'revision'], 'review-source-coverage': ['input'],
      'prepare-rebuild-associations': ['id', 'revision', 'body-digest', 'executor', 'model', 'run-id', 'input'],
      'rebuild-associations': ['id', 'revision', 'body-digest', 'executor', 'model', 'run-id', 'confirm-request', 'input'],
    };
    const selectedFlags = sourceFlags[args.operation];
    if (selectedFlags && Object.entries(flags).some(([name, value]) => value !== undefined && value !== false && ![...selectedFlags, 'workspace', 'lang', 'json'].includes(name))) {
      this.error(t('该操作只接受明确的来源／阶段参数，不接受旧路径或 snapshot 生成入口。', 'This operation accepts only its explicit source/stage parameters, without retired path or snapshot-generation inputs.'), { exit: 2 });
    }
    if (flags.format !== undefined && args.operation !== 'retrieve') this.error(t('--format 仅用于 retrieve。', '--format is only valid for retrieve.'), { exit: 2 });
    if (flags.format === 'text' && flags.json) this.error(t('--format text 不可与 --json 同用。', '--format text cannot be combined with --json.'), { exit: 2 });
    if (flags.scope !== undefined && !['preview-sources', 'capture', 'source-updates'].includes(args.operation)) this.error(t('--scope 仅用于来源预览、保存和变化查询。', '--scope is only valid for source preview/capture/update checks.'), { exit: 2 });
    if (flags['confirm-request'] !== undefined && !['generate', 'continue-stage', 'rebuild-associations'].includes(args.operation)) this.error(t('--confirm-request 仅用于明确发送阶段。', '--confirm-request is only valid for explicit stage dispatch.'), { exit: 2 });
    if (!['migrate', 'migrate-associations', 'migrate-sources', 'migrate-workflow'].includes(args.operation) && flags['from-workspace'] !== undefined) this.error(t('--from-workspace 仅用于迁移。', '--from-workspace is only valid for migration.'), { exit: 2 });
    if (!['migrate-sources', 'migrate-workflow'].includes(args.operation) && [flags['matching-build'], flags['matching-build-id'], flags['confirm-plan'], flags['plan-only'] || undefined].some(value => value !== undefined)) this.error(t('来源迁移参数仅用于 migrate-sources。', 'Source migration flags are only valid for migrate-sources.'), { exit: 2 });
    if (args.operation === 'migrate-workflow') {
      const applying = flags.input !== undefined, allowed = new Set(applying ? ['input', 'confirm-plan', 'json', 'lang'] : ['from-workspace', 'workspace', 'operation-id', 'matching-build', 'matching-build-id', 'plan-only', 'json', 'lang']);
      if (Object.entries(flags).some(([name, value]) => value !== undefined && value !== false && !allowed.has(name))
        || applying && !SourceDigestSchema.safeParse(flags['confirm-plan']).success
        || !applying && (!flags['plan-only'] || !flags['from-workspace']?.trim() || !flags.workspace?.trim() || !z.string().uuid().safeParse(flags['operation-id']).success || !flags['matching-build']?.trim() || !flags['matching-build-id']?.trim())) {
        this.error(t('先以独立旧／新目录、匹配构建及 --plan-only 固定 workflow4 副本计划；执行只接受 --input 和 --confirm-plan。', 'Fix a workflow4 copy plan with separate roots, matching build and --plan-only; apply accepts only --input and --confirm-plan.'), { exit: 2 });
      }
      try {
        const plan = applying ? readInputJson(flags.input!) as KnowledgeWorkflowMigrationPlan : planKnowledgeWorkflowMigration({ sourceRoot: resolve(flags['from-workspace']!), targetRoot: resolve(flags.workspace!),
          migrationId: flags['operation-id']!, namespace: 'local', actor: knowledgeReviewCliActor(process.env) ?? { actorKind: 'human', actorId: 'local-user' }, at: new Date().toISOString(),
          matchingBuildArchivePath: resolve(flags['matching-build']!), matchingBuildId: flags['matching-build-id']! });
        this.log(JSON.stringify(applying ? { ...applyKnowledgeWorkflowMigration(plan, flags['confirm-plan']!), modelCalls: 0, semanticAcceptance: false } : plan, null, 2));
      } catch (cause) { this.error(`${t('流程副本迁移未完成；保留原目录、目标与固定计划。', 'Workflow copy migration did not complete; preserve the source, target and fixed plan.')}\n${cause instanceof Error ? cause.message : String(cause)}`, { exit: 1 }); }
      return;
    }
    if (args.operation === 'migrate-sources') {
      const applying = flags.input !== undefined, allowed = new Set(applying ? ['input', 'confirm-plan', 'json', 'lang'] : ['from-workspace', 'workspace', 'operation-id', 'matching-build', 'matching-build-id', 'plan-only', 'json', 'lang']);
      if (Object.entries(flags).some(([name, value]) => value !== undefined && value !== false && !allowed.has(name))
        || applying && !SourceDigestSchema.safeParse(flags['confirm-plan']).success
        || !applying && (!flags['plan-only'] || !flags['from-workspace']?.trim() || !flags.workspace?.trim() || !z.string().uuid().safeParse(flags['operation-id']).success || !flags['matching-build']?.trim() || !flags['matching-build-id']?.trim())) {
        this.error(t('先用显式旧／新工作区、稳定操作 UUID、匹配构建及 --plan-only 导出计划；执行只接受 --input 和 --confirm-plan。', 'Export a plan with explicit old/new workspaces, stable operation UUID, matching build and --plan-only; apply accepts only --input and --confirm-plan.'), { exit: 2 });
      }
      try {
        const plan = applying ? readInputJson(flags.input!, SOURCE_MIGRATION_PLAN_MAX_BYTES) as SourceMigrationPlan : prepareSourceMigration({ sourceRoot: resolve(flags['from-workspace']!), targetRoot: resolve(flags.workspace!),
          migrationId: flags['operation-id']!, namespace: 'local', actor: { actorKind: 'human', actorId: 'local-user' }, at: new Date().toISOString(),
          matchingBuildArchivePath: resolve(flags['matching-build']!), matchingBuildId: flags['matching-build-id']! });
        this.log(JSON.stringify(applying ? { ...applySourceMigration(plan, flags['confirm-plan']!), modelCalls: 0, semanticAcceptance: false, limitations: plan.limitations } : plan, null, 2));
      } catch (cause) { this.error(`${t('来源迁移未完成；保留原工作区和固定计划，不覆盖或清理目标。', 'Source migration did not complete; preserve the original workspace and fixed plan without overwriting or cleaning the target.')}\n${cause instanceof Error ? cause.message : String(cause)}`, { exit: 1 }); }
      return;
    }
    if (args.operation === 'migrate-associations') {
      const allowed = new Set(['from-workspace', 'workspace', 'operation-id', 'json', 'lang']);
      if (!flags['from-workspace']?.trim() || !flags.workspace?.trim() || !z.string().uuid().safeParse(flags['operation-id']).success
        || Object.entries(flags).some(([name, value]) => value !== undefined && value !== false && !allowed.has(name))) {
        this.error(t('migrate-associations 须显式提供 --from-workspace、独立 --workspace 和稳定 --operation-id UUID；不接受模型参数。', 'migrate-associations requires explicit --from-workspace, a separate --workspace and a stable --operation-id UUID; model flags are not accepted.'), { exit: 2 });
      }
      try {
        const sourceRoot = resolve(flags['from-workspace']!), targetRoot = resolve(flags.workspace!), migrationId = flags['operation-id']!;
        const path = join(targetRoot, 'migration', migrationId, 'plan.json'); let plan: AssociationMigrationPlan;
        if (existsSync(path)) {
          const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw new Error('Invalid migration plan file.');
          plan = JSON.parse(readFileSync(path, 'utf8')) as AssociationMigrationPlan;
          if (plan.sourceRoot !== sourceRoot || plan.targetRoot !== targetRoot || plan.migrationId !== migrationId || plan.namespace !== 'local') throw new Error('Migration invocation does not match its frozen plan.');
        } else plan = prepareAssociationMigration({ sourceRoot, targetRoot, migrationId, namespace: 'local',
          actor: { actorKind: 'human', actorId: 'local-user' }, at: new Date().toISOString() });
        const result = applyAssociationMigration(plan, plan.planDigest);
        this.log(JSON.stringify({ ...result, migrationId, sourceRoot, targetRoot, originalBytesPreserved: true,
          modelCalls: 0, semanticAcceptance: false, limitations: plan.limitations }, null, 2));
      } catch (cause) {
        this.error(`${t('迁移未完成；保留原目录、目标计划和原件，以同一 --operation-id 重入。', 'Migration did not complete; preserve the source, target plan and originals, and replay the same --operation-id.')}\n${cause instanceof Error ? cause.message : String(cause)}`, { exit: 1 });
      }
      return;
    }
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
      const profile = { source_ledger: SOURCE_LEDGER_GENERATION_PROFILE, body: BODY_GENERATION_PROFILE, source_coverage: SOURCE_COVERAGE_GENERATION_PROFILE, association: ASSOCIATION_GENERATION_PROFILE }[(flags.stage ?? 'body') as 'source_ledger' | 'body' | 'source_coverage' | 'association'];
      this.log(JSON.stringify({ profileId: profile.profileId, promptVersion: profile.promptVersion, wireId: profile.wireId, schema: profile.wireSchema }, null, 2)); return;
    }
    if (flags.stage !== undefined) this.error(t('--stage 仅用于 schema。', '--stage is only valid for schema.'), { exit: 2 });
    if (flags['projection-revision'] !== undefined && args.operation !== 'review-status') this.error(t('--projection-revision 仅用于 review-status。', '--projection-revision is only valid for review-status.'), { exit: 2 });
    if (args.operation === 'retrieve') {
      const allowed = new Set(['workspace', 'query', 'max-bytes', 'include-candidates', 'snapshot', 'source-version', 'entity-id', 'analysis', 'entity-revision', 'lang', 'json', 'format']);
      if (Object.entries(flags).some(([name, value]) => value !== undefined && value !== false && !allowed.has(name))) this.error(t('retrieve 仅接受只读检索参数。', 'retrieve accepts read-only retrieval flags only.'), { exit: 2 });
    } else if (flags['max-bytes'] !== undefined || flags['include-candidates'] || flags['entity-id'] !== undefined
      || flags['source-version'] !== undefined && !['source', 'delete-source'].includes(args.operation)) this.error(t('检索参数仅用于 retrieve；来源版本也可用于 source／delete-source。', 'Retrieval flags are only valid for retrieve; source versions are also accepted by source/delete-source.'), { exit: 2 });
    if (args.operation === 'apply-associations' && (flags.analysis !== undefined || flags['entity-revision'] !== undefined)) this.error(t('apply-associations 使用草稿中的 catalogRefs 和带目录限定的实体引用，不接受旧 --analysis／--entity-revision。', 'apply-associations uses draft catalogRefs and catalog-qualified entity references; old --analysis/--entity-revision flags are not accepted.'), { exit: 2 });
    const generation = () => { if (flags.generation === undefined) this.error('--generation is required', { exit: 2 }); return flags.generation!; };
    const draft = () => { const path = need(flags.input, 'input'); try {
      return readInputJson(path);
    } catch { this.error(t('--input 必须是 16 MiB 内的普通 UTF-8 JSON 文件。', '--input must be a regular UTF-8 JSON file within 16 MiB.'), { exit: 2 }); } };
    if (args.operation === 'graph') {
      const allowed = new Set(['workspace', 'input', 'json', 'lang']);
      if (Object.entries(flags).some(([name, value]) => value !== undefined && value !== false && !allowed.has(name))) this.error(t('graph 只接受工作区及可选范围 JSON，不接受模型或写入参数。', 'graph accepts a workspace and optional scope JSON, without model or write flags.'), { exit: 2 });
      const parsed = KnowledgeGraphRequestSchema.safeParse(flags.input ? draft() : {});
      if (!parsed.success) this.error(t('图谱范围无效，仅接受 knowledgeIds 和 includeHistory。', 'Invalid graph scope; only knowledgeIds and includeHistory are accepted.'), { exit: 2 });
      const workspace = flags.workspace?.trim() ? resolve(flags.workspace.trim()) : new UserSettingsStore().resolve({}).workspace;
      try { this.log(JSON.stringify(createLocalKnowledgeApplication(workspace).graph(parsed.data), null, 2)); }
      catch (cause) { this.error(`${knowledgeFailureCode(cause)} · ${cause instanceof Error ? cause.message : String(cause)}`, { exit: 1 }); }
      return;
    }
    if (['relations', 'relation', 'propose-relation', 'review-relation', 'withdraw-relation'].includes(args.operation)) {
      const reading = args.operation === 'relations' || args.operation === 'relation';
      const allowed = new Set(reading ? ['workspace', 'id', 'json', 'lang', ...(args.operation === 'relations' ? ['revision', 'body-digest'] : ['revision'])] : ['workspace', 'input', 'json', 'lang']);
      if (Object.entries(flags).some(([name, value]) => value !== undefined && value !== false && !allowed.has(name))) this.error(t('关系操作仅接受精确读取参数或完整 --input，不接受模型参数或操作者自报。', 'Relation operations accept exact read flags or a complete --input, without model or self-declared actor flags.'), { exit: 2 });
      const actor = reading ? undefined : knowledgeReviewCliActor(process.env);
      if (!reading && !actor) this.error(t('关系写入需要可信宿主的实际操作者上下文；不能回落为真人。', 'Relation writes require actual-actor context from a trusted host; no human fallback is inferred.'), { exit: 2 });
      const input = args.operation === 'relations' ? { bodyRef: { knowledgeId: need(flags.id, 'id'), revisionId: need(flags.revision, 'revision'), bodyDigest: need(flags['body-digest'], 'body-digest') } }
        : args.operation === 'relation' ? { relationId: need(flags.id, 'id'), ...(flags.revision ? { relationRevisionId: flags.revision } : {}) } : draft();
      if (!input || typeof input !== 'object' || Array.isArray(input) || 'operation' in input) this.error(t('--input 必须是关系草稿对象，operation 由命令指定。', '--input must be a relation draft object; the command supplies operation.'), { exit: 2 });
      const parsed = KnowledgeRelationOperationSchema.safeParse({ ...input as Record<string, unknown>, operation: args.operation });
      if (!parsed.success) this.error(t('关系参数无效：', 'Invalid relation input: ') + parsed.error.issues.map(issue => issue.path.join('.')).join(', '), { exit: 2 });
      const workspace = flags.workspace?.trim() ? resolve(flags.workspace.trim()) : new UserSettingsStore().resolve({}).workspace;
      try { this.log(JSON.stringify(executeKnowledgeRelationOperation(createLocalKnowledgeRelations(workspace, actor), parsed.data), null, 2)); }
      catch (cause) { this.error(`${knowledgeRelationFailureCode(cause)} · ${cause instanceof Error ? cause.message : String(cause)}\n${t('先用 relation --id 核对同一 requestId 的收据与历史；不自动重发未知写入。', 'Inspect the same requestId in relation --id receipts and history first; do not automatically redispatch an unknown write.')}`, { exit: 1 }); }
      return;
    }
    if (['review-status', 'review-content', 'review-coverage', 'record-use'].includes(args.operation)) {
      const reading = args.operation === 'review-status';
      const allowed = new Set(reading ? ['workspace', 'id', 'revision', 'body-digest', 'projection-revision', 'json', 'lang'] : ['workspace', 'input', 'json', 'lang']);
      if (Object.entries(flags).some(([name, value]) => value !== undefined && value !== false && !allowed.has(name))) this.error(t('复核操作仅接受其精确读取参数或完整 --input，不接受模型、维护或身份自报参数。', 'Review operations accept only their exact read flags or a complete --input, without model, maintenance or self-declared actor flags.'), { exit: 2 });
      const actor = reading ? undefined : knowledgeReviewCliActor(process.env);
      if (!reading && !actor) this.error(t('复核写入需要可信宿主的实际操作者上下文。当前仅识别 Codex Desktop 启动声明；其它宿主请使用 Studio 或显式注入 actor 的应用入口，不能回落为真人。', 'Review writes require actual-actor context from a trusted host. This CLI currently recognizes Codex Desktop launcher declarations; other hosts should use Studio or an application entry with an injected actor. No human fallback is inferred.'), { exit: 2 });
      const input = reading ? { operation: 'review-status', bodyRef: { knowledgeId: need(flags.id, 'id'), revisionId: need(flags.revision, 'revision'), bodyDigest: need(flags['body-digest'], 'body-digest') },
        ...(flags['projection-revision'] ? { projectionRevisionId: flags['projection-revision'] } : {}) } : draft();
      if (!reading && (!input || typeof input !== 'object' || Array.isArray(input) || 'operation' in input)) this.error(t('--input 必须是复核草稿对象，operation 由命令指定。', '--input must be a review draft object; the command supplies operation.'), { exit: 2 });
      const parsed = KnowledgeReviewOperationSchema.safeParse(reading ? input : { ...input as Record<string, unknown>, operation: args.operation });
      if (!parsed.success) this.error(t('复核参数无效：', 'Invalid review input: ') + parsed.error.issues.map(issue => issue.path.join('.')).join(', '), { exit: 2 });
      const workspace = flags.workspace?.trim() ? resolve(flags.workspace.trim()) : new UserSettingsStore().resolve({}).workspace;
      try { this.log(JSON.stringify(executeKnowledgeReviewOperation(createLocalKnowledgeReview(workspace, actor), parsed.data), null, 2)); }
      catch (cause) { this.error(`${knowledgeFailureCode(cause)} · ${cause instanceof Error ? cause.message : String(cause)}\n${t('先用 review-status 核对同一 requestId 的收据与记录；不自动重发未知写入。', 'Inspect the same requestId in review-status receipts and history first; do not automatically redispatch an unknown write.')}`, { exit: 1 }); }
      return;
    }
    let operation: KnowledgeOperation;
    switch (args.operation) {
      case 'retrieve': operation = { operation: 'retrieve', query: need(flags.query, 'query'), maxBytes: flags['max-bytes'], includeCandidates: flags['include-candidates'], snapshot: flags.snapshot, sourceVersion: flags['source-version'], entityId: flags['entity-id'], analysisId: flags.analysis, entityRevisionId: flags['entity-revision'], ...(flags.format === undefined ? {} : { format: flags.format as 'json' | 'text' }) }; break;
      case 'preview-sources': { const parsed = knowledgeOperationSchemas['preview-sources'].omit({ operation: true }).safeParse(draft());
        if (!parsed.success) this.error(t('来源选区必须是 {selections, afterDeletion?}，不能声明宿主路径。', 'Source selections must be {selections, afterDeletion?}, without host paths.'), { exit: 2 });
        operation = { operation: 'preview-sources', ...parsed.data }; break; }
      case 'source-updates': { const parsed = knowledgeOperationSchemas['source-updates'].omit({ operation: true }).safeParse(draft());
        if (!parsed.success) this.error(t('来源变化查询必须含精确 source 引用；替代选区仅接受显式逻辑选择。', 'A source-update check requires an exact source reference; replacement selections accept explicit logical selectors only.'), { exit: 2 });
        operation = { operation: 'source-updates', ...parsed.data }; break; }
      case 'capture': { const parsed = z.object({ previewDigest: SourceDigestSchema, items: z.array(z.object({ resolvedSelection: ResolvedSourceSelectionSchema })).min(1).max(256),
        savePlan: z.object({ afterDeletion: z.enum(['reject', 'new_snapshot']) }) }).safeParse(draft());
        if (!parsed.success) this.error(t('capture 需要完整 preview-sources 导出，不接受来源路径或旧 snapshot 参数。', 'capture requires the complete preview-sources export, without source paths or old snapshot arguments.'), { exit: 2 });
        operation = { operation: 'capture', selections: parsed.data.items.map(item => item.resolvedSelection), previewDigest: parsed.data.previewDigest,
          ...(parsed.data.savePlan.afterDeletion === 'new_snapshot' ? { afterDeletion: 'new_snapshot' as const } : {}) }; break; }
      case 'prepare-generation': case 'prepare-source-review': { const parsed = args.operation === 'prepare-generation'
        ? knowledgeOperationSchemas['prepare-generation'].omit({ operation: true, executor: true, model: true, runId: true }).safeParse(draft())
        : knowledgeOperationSchemas['prepare-source-review'].omit({ operation: true, executor: true, model: true, runId: true }).safeParse(draft());
        if (!parsed.success) this.error(t('准备输入须包含完整精确来源引用及该操作的正文／复核引用。', 'Preparation requires complete exact source references and the body/review references for this operation.'), { exit: 2 });
        operation = { ...parsed.data, operation: args.operation, executor: 'configured', model: 'configured', runId: flags['run-id'] } as KnowledgeOperation; break; }
      case 'generate': { const parsed = z.strictObject({ sources: z.array(SourceRefSchema).min(1).max(256) }).safeParse(draft());
        if (!parsed.success) this.error(t('生成输入必须是 {sources} 精确来源引用数组。', 'Generation input must be {sources} with exact source references.'), { exit: 2 });
        operation = { operation: 'generate', sources: parsed.data.sources, executor: 'configured', model: 'configured', runId: flags['run-id'], confirmedRequestDigest: need(flags['confirm-request'], 'confirm-request') }; break; }
      case 'source-ledger': case 'source-coverage-status': operation = { operation: args.operation, id: need(flags.id, 'id'), revision: flags.revision }; break;
      case 'review-source-coverage': operation = { operation: 'review-source-coverage', command: draft() } as KnowledgeOperation; break;
      case 'continue-stage': operation = { operation: 'continue-stage', id: need(flags.id, 'id'), generation: generation(), executor: 'configured', model: 'configured', confirmedRequestDigest: need(flags['confirm-request'], 'confirm-request') }; break;
      case 'prepare-rebuild-associations': case 'rebuild-associations': { const parsed = z.strictObject({ sourceCoverageDecisionRef: SourceCoverageDecisionRefSchema }).safeParse(draft());
        if (!parsed.success) this.error(t('重建需要 --input 中完整的 sourceCoverageDecisionRef。', 'Rebuilding requires a complete sourceCoverageDecisionRef in --input.'), { exit: 2 });
        const ref = { sourceCoverageDecisionRef: parsed.data.sourceCoverageDecisionRef, knowledgeId: need(flags.id, 'id'), revisionId: need(flags.revision, 'revision'), bodyDigest: need(flags['body-digest'], 'body-digest'), executor: 'configured', model: 'configured', runId: flags['run-id'] };
        operation = args.operation === 'prepare-rebuild-associations' ? { operation: args.operation, ...ref } : { operation: args.operation, ...ref, confirmedRequestDigest: need(flags['confirm-request'], 'confirm-request') }; break; }
      case 'runs': case 'quality': case 'list': operation = { operation: args.operation }; break;
      case 'inspect': case 'resume': operation = { operation: args.operation, id: need(flags.id, 'id') }; break;
      case 'show': operation = { operation: 'show', id: need(flags.id, 'id'), revision: flags.revision }; break;
      case 'entities': operation = flags.analysis ? { operation: 'entities', analysisId: flags.analysis, revision: flags['entity-revision'] }
        : { operation: 'entity-catalog', query: flags.query, identityStatus: flags['identity-status'] as 'all' | 'proposed' | 'unresolved' | undefined, sourceStatus: flags['source-status'] as 'all' | 'available' | 'unavailable' | undefined, page: flags.page, pageSize: flags['page-size'] }; break;
      case 'correct-entities': operation = { operation: 'correct-entities', analysisId: need(flags.analysis, 'analysis'), revision: need(flags['entity-revision'], 'entity-revision'), generation: generation(), draft: draft(), reason: need(flags.reason, 'reason') }; break;
      case 'source': case 'delete-source': operation = { operation: args.operation, source: { snapshotId: need(flags.snapshot, 'snapshot'), sourceVersion: need(flags['source-version'], 'source-version') } }; break;
      case 'retain': case 'discard': operation = { operation: 'maintain', id: need(flags.id, 'id'), revision: need(flags.revision, 'revision'), generation: generation(), choice: args.operation, reason: need(flags.reason, 'reason') }; break;
      case 'review-associations': operation = { operation: 'review-associations', id: need(flags.id,'id'), revision: need(flags.revision,'revision'), generation: generation(), choice: need(flags.choice,'choice') as 'accept'|'reject', reason: need(flags.reason,'reason') }; break;
      case 'apply-associations': operation = { operation: 'apply-associations', id: need(flags.id,'id'), revision: need(flags.revision,'revision'), bodyDigest: need(flags['body-digest'],'body-digest'), generation: generation(), draft: draft(), reason: need(flags.reason,'reason') }; break;
      case 'revise': operation = { operation: 'revise', id: need(flags.id, 'id'), revision: need(flags.revision, 'revision'), generation: generation(), draft: draft(), reason: need(flags.reason, 'reason') }; break;
      default: this.error(t('该操作尚不可用。', 'This operation is unavailable.'), { exit: 2 });
    }
    const checked = KnowledgeOperationSchema.safeParse(operation!);
    if (!checked.success) this.error(t('操作参数无效。', 'Invalid operation parameters.') + '\n' + checked.error.issues.map(i => i.path.join('.')).join(', '), { exit: 2 });
    let sourceScope;
    if (operation.operation === 'preview-sources' || operation.operation === 'capture' || operation.operation === 'source-updates') {
      try { sourceScope = readLocalSourceScope(need(flags.scope, 'scope')); }
      catch { this.error(t('--scope 必须是 1 MiB 内的独立可信宿主绑定 JSON。', '--scope must be independent trusted host bindings JSON within 1 MiB.'), { exit: 2 }); }
    }
    const settings = new UserSettingsStore().resolve({ workspace: flags.workspace, executor: flags.executor, model: flags.model });
    if (['prepare-generation', 'prepare-source-review', 'generate', 'continue-stage', 'prepare-rebuild-associations', 'rebuild-associations'].includes(operation.operation)) operation = { ...operation, executor: settings.executor, model: need(settings.model, 'model') } as KnowledgeOperation;
    const reviewActor = operation.operation === 'review-source-coverage' ? knowledgeReviewCliActor(process.env) : undefined;
    if (operation.operation === 'review-source-coverage' && !reviewActor) this.error(t('来源决定需要可信宿主的实际操作者上下文，不能回落为真人。', 'Source decisions require actual-actor context from a trusted host; no human fallback is inferred.'), { exit: 2 });
    const app = createLocalKnowledgeApplication(settings.workspace, { sourceScope, reviewActor });
    await this.runWithCancellation(async signal => {
      let result: unknown;
      try { result = await executeKnowledgeOperation(app, operation, signal, (executor, model) => createLocalKnowledgeGenerationModel(executor, model, createExtractionArchiveProducer)); }
      catch (cause) {
        if (cause instanceof KnowledgeRetrievalBudgetError) this.error(`${cause.message}`, { exit: 2 });
        const code = knowledgeFailureCode(cause);
        const detail = cause instanceof z.ZodError ? cause.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('\n') : cause instanceof Error ? cause.message : String(cause);
        this.error(`${code} · ${detail}\n${t('先 inspect/runs 核对状态；resume 不发送模型，unknown claim 禁止重发。', 'Inspect runs first; resume does not dispatch models and unknown claims must not be redispatched.')}`, { exit: 1 });
      }
      this.log(operation.operation === 'retrieve' ? flags.format === 'text' ? String(result) : JSON.stringify(result)
        : flags.json ? JSON.stringify(result, null, 2) : formatKnowledgeResult(result, this.lang, operation, settings.workspace));
      if (result && typeof result === 'object' && 'journal' in result && (result.journal as { status: string }).status !== 'completed'
        && (!('nextAction' in result) || !['continue_stage', 'prepare_next_stage', 'review_source_coverage'].includes(String(result.nextAction)))) this.exit(1);
    });
  }
}
