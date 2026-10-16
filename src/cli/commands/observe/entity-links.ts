import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Args, Errors, Flags } from '@oclif/core';
import { z } from 'zod';
import { BaseCommand } from '../../oclif/base-command.js';
import { LANG_FLAG, bilingual } from '../../oclif/i18n.js';
import { UserSettingsStore } from '../../../evidence/storage/user-settings.js';
import { createOpenAiArchiveProducer } from '../../../executors/openai/archive.js';
import { createLocalEntityLinks, parseEntityLinkPreview } from '../../../observability/knowledge-extraction/local.js';
import { shellQuoteArg } from '../../../shared/shell-quote.js';
import type { EntityLinkInvocation } from '../../../knowledge/entities/link-invocation.js';
import { EntityLinkCliPlanSchema, createEntityLinkCliPlan, formatEntityLinkInvocation, formatEntityLinkPreview, type EntityLinkCliPlan } from '../../lib/entity-link-output.js';

const description = (zh: string, en: string) => bilingual({ zh, en });
export default class ObserveEntityLinks extends BaseCommand {
  static description = description('跨窗口核对实体关联：本地预览、明确确认一次调用，再由人工接受或拒绝。', 'Review cross-window entity links: preview locally, confirm one invocation, then explicitly accept or reject.');
  static args = { operation: Args.string({ required: true, options: ['candidates', 'preview', 'propose', 'list', 'show', 'accept', 'reject', 'resume'],
    description: description('candidates 本地召回；preview 冻结内容与配置；propose 明确调用；其余读取、人审或零调用恢复。', 'candidates recalls locally; preview freezes content/configuration; propose explicitly invokes; other operations inspect, review, or recover without a model call.') }) };
  static flags = {
    lang: LANG_FLAG,
    workspace: Flags.string({ description: description('知识工作区；propose 默认沿用计划中的绝对目录，不得覆盖为其它目录。', 'Knowledge workspace; propose uses the plan’s absolute directory and rejects a different override.') }),
    analysis: Flags.string({ description: description('左侧实体分析 UUID；candidates／preview 必填。', 'Left entity analysis UUID; required for candidates/preview.') }),
    entity: Flags.string({ description: description('左侧实体 UUID；原实体身份保持不变。', 'Left entity UUID; original entity identities are preserved.') }),
    'right-analysis': Flags.string({ description: description('preview：右侧分析 UUID。', 'preview: right analysis UUID.') }),
    'right-entity': Flags.string({ description: description('preview：右侧实体 UUID。', 'preview: right entity UUID.') }),
    mention: Flags.string({ multiple: true, description: description('preview：选中的左侧 mention UUID，可重复传旗标；省略时选该实体全部提及。', 'preview: selected left mention UUID; repeat the flag; omitted selects all entity mentions.') }),
    'right-mention': Flags.string({ multiple: true, description: description('preview：选中的右侧 mention UUID，可重复传旗标。', 'preview: selected right mention UUID; repeat the flag.') }),
    executor: Flags.string({ options: ['openai-api', 'codex'], description: description('preview：执行器；API 已具备容量证明，Codex 尚不允许启动。', 'preview: executor; API has an archive bound; Codex cannot start until proven.') }),
    model: Flags.string({ description: description('preview：明确模型，未提供时使用同执行器的已配置模型。', 'preview: explicit model; otherwise use the model configured for this executor.') }),
    'retry-of': Flags.string({ description: description('preview：明确核对过的旧 review UUID；失败或未知后重新确认调用时必填。', 'preview: inspected prior review UUID; required for a newly confirmed invocation after failure/unknown.') }),
    input: Flags.string({ description: description('preview：核对已有计划；propose：读取 preview --json 导出的同一普通 JSON 文件，最多 2 MiB。', 'preview: inspect a saved plan; propose: read the same regular JSON file exported by preview --json, at most 2 MiB.') }),
    'confirm-input': Flags.string({ description: description('propose：人工核对内容、模型和 endpoint 后，显式填写计划顶层 confirmedDigest（含工作区）。', 'propose: explicitly supply the plan’s top-level confirmedDigest (including workspace) after inspecting content, model and endpoint.') }),
    'start-prepared': Flags.boolean({ default: false, description: description('propose：先 show 核对后，明确继续已持久 prepared 的同一次调用；已 started 时无效。', 'propose: explicitly continue the same persisted prepared invocation after show; never restarts a started invocation.') }),
    id: Flags.string({ description: description('show／accept／reject／resume：稳定 review UUID。', 'show/accept/reject/resume: stable review UUID.') }),
    'request-id': Flags.string({ description: description('accept／reject／resume 的明确恢复或取消：稳定操作 UUID，重放沿用原值。', 'accept/reject/explicit resume recovery or cancellation: stable operation UUID; reuse it on replay.') }),
    generation: Flags.integer({ min: 1, max: Number.MAX_SAFE_INTEGER, description: description('accept／reject／取消 prepared：show 读取的 generation。', 'accept/reject/cancel prepared: generation read by show.') }),
    reason: Flags.string({ description: description('accept／reject／取消 prepared：明确人工理由。', 'accept/reject/cancel prepared: explicit human reason.') }),
    'confirm-identity': Flags.boolean({ default: false, description: description('accept 必填：人工核对后确认两侧所指同一对象，不以模型判断代替。', 'Required for accept: explicitly confirm both sides refer to the same object after human review.') }),
    'object-label': Flags.string({ description: description('accept：新组织对象的完整名称，最多 256 字符；不截断原实体名。', 'accept: complete new organization label, at most 256 characters; never truncate an entity name.') }),
    'recover-unknown': Flags.boolean({ default: false, description: description('resume：仅在可信本机 owner 已退出时明确记录 unknown，不退款、不重新调用。', 'resume: explicitly record unknown only after proving the local owner exited; no refund or new invocation.') }),
    'cancel-before-start': Flags.boolean({ default: false, description: description('resume：明确取消尚未 started 的 prepared 计划，释放预约；须 request-id、generation 和 reason。', 'resume: explicitly cancel a prepared plan that has not started, releasing its reservation; requires request-id, generation and reason.') }),
    json: Flags.boolean({ default: false, description: description('输出完整机器 JSON；preview 的 JSON 可保存为 propose 计划。', 'Print complete machine JSON; preview JSON can be saved as a propose plan.') }),
  };
  static examples = [
    '<%= config.bin %> observe entity-links candidates --workspace ./knowledge --analysis <analysis-id> --entity <entity-id>',
    '<%= config.bin %> observe entity-links preview --workspace ./knowledge --analysis <left-analysis> --entity <left-entity> --right-analysis <right-analysis> --right-entity <right-entity> --executor openai-api --model <model> --json',
    '<%= config.bin %> observe entity-links preview --input ./link-plan.json',
    '<%= config.bin %> observe entity-links propose --input ./link-plan.json --confirm-input <confirmedDigest> --json',
    '<%= config.bin %> observe entity-links show --workspace ./knowledge --id <review-id> --json',
    '<%= config.bin %> observe entity-links accept --workspace ./knowledge --id <review-id> --request-id <request-id> --generation <generation> --reason "已核对两侧原文与身份" --confirm-identity',
    '<%= config.bin %> observe entity-links reject --workspace ./knowledge --id <review-id> --request-id <request-id> --generation <generation> --reason "证据不足"',
    '<%= config.bin %> observe entity-links resume --workspace ./knowledge --id <review-id>',
  ];
  async run(): Promise<void> {
    const { args, flags } = await this.parse(ObserveEntityLinks);
    const t = (zh: string, en: string) => this.lang === 'zh' ? zh : en;
    const need = (value: string | undefined, name: string) => {
      if (!value?.trim()) this.error(`--${name} ${t('必填', 'is required')}`, { exit: 2 }); return value!;
    };
    const uuid = (value: string | undefined, name: string) => {
      const input = need(value, name); if (!z.string().uuid().safeParse(input).success) this.error(`--${name} ${t('必须是 UUID', 'must be a UUID')}`, { exit: 2 }); return input;
    };
    const operation = args.operation;
    const readingPreview = operation === 'preview' && flags.input !== undefined;
    if (flags['start-prepared'] && operation !== 'propose') this.error('--start-prepared: propose', { exit: 2 });
    if (flags['cancel-before-start'] && operation !== 'resume') this.error('--cancel-before-start: resume', { exit: 2 });
    if (flags['cancel-before-start'] && flags['recover-unknown']) this.error('--cancel-before-start / --recover-unknown', { exit: 2 });
    if (flags['recover-unknown'] && operation !== 'resume') this.error('--recover-unknown: resume', { exit: 2 });
    const left = (operation === 'candidates' || (operation === 'preview' && !readingPreview)) ? { analysisId: uuid(flags.analysis, 'analysis'), entityId: uuid(flags.entity, 'entity'),
      ...(flags.mention ? { mentionIds: flags.mention.map(value => uuid(value, 'mention')) } : {}) } : undefined;
    const right = operation === 'preview' && !readingPreview ? { analysisId: uuid(flags['right-analysis'], 'right-analysis'), entityId: uuid(flags['right-entity'], 'right-entity'),
      ...(flags['right-mention'] ? { mentionIds: flags['right-mention'].map(value => uuid(value, 'right-mention')) } : {}) } : undefined;
    const id = ['show', 'accept', 'reject', 'resume'].includes(operation) ? uuid(flags.id, 'id') : undefined;
    const requestId = ['accept', 'reject'].includes(operation) || flags['recover-unknown'] || flags['cancel-before-start'] ? uuid(flags['request-id'], 'request-id') : undefined;
    if (['accept', 'reject'].includes(operation) || flags['cancel-before-start']) {
      need(flags.reason, 'reason'); if (!flags.generation) this.error('--generation', { exit: 2 });
      if (operation === 'accept' && !flags['confirm-identity']) this.error('--confirm-identity', { exit: 2 });
    }
    const retryOf = flags['retry-of'] === undefined ? null : uuid(flags['retry-of'], 'retry-of');
    let plan: EntityLinkCliPlan | undefined;
    if (operation === 'propose' || readingPreview) {
      const path = need(flags.input, 'input'); if (operation === 'propose') need(flags['confirm-input'], 'confirm-input');
      try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error('Invalid plan file.');
        plan = EntityLinkCliPlanSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
        plan.preview = parseEntityLinkPreview(plan.preview);
      } catch { this.error(t('计划文件无效；请核对 preview --json 原文件与读取权限。', 'Invalid plan file; inspect the original preview --json file and read permissions.'), { exit: 2 }); }
      if (operation === 'propose' && flags['confirm-input'] !== plan!.confirmedDigest) this.error(t('确认摘要不匹配；本次零调用。', 'Confirmation digest mismatch; no invocation.'), { exit: 2 });
      if (flags.workspace && resolve(flags.workspace) !== plan!.workspace) this.error(t('工作区与计划不一致。', 'Workspace differs from the plan.'), { exit: 2 });
    }
    if (readingPreview) { this.log(flags.json ? JSON.stringify(plan, null, 2) : formatEntityLinkPreview(plan!, this.lang)); return; }
    let reviewId = id ?? plan?.preview.reviewId;
    let failed = false;
    let chosenWorkspace = plan?.workspace ?? (flags.workspace === undefined ? undefined : resolve(flags.workspace));
    try {
      const settings = plan ? undefined : new UserSettingsStore().resolve({ workspace: flags.workspace, executor: flags.executor, model: flags.model });
      const workspace = plan?.workspace ?? resolve(settings!.workspace);
      chosenWorkspace = workspace;
      const app = createLocalEntityLinks(workspace, createOpenAiArchiveProducer(process.env));
      const emit = (history: EntityLinkInvocation, checkStatus = false) => {
        const projection = app.projectHistory(history);
        this.log(flags.json ? JSON.stringify({ responseKind: 'entity-link-invocation', workspace, history, projection }, null, 2)
          : formatEntityLinkInvocation(history, projection, workspace, this.lang));
        if (checkStatus && ['running', 'execution_unknown', 'execution_failed', 'accepted_conflict', 'accepted_pending_application'].includes(projection.status)) failed = true;
      };
      switch (operation) {
        case 'candidates': { const result = { responseKind: 'entity-link-candidates', workspace, ...app.recall(left!) }; this.log(JSON.stringify(result, null, 2)); break; }
        case 'preview': {
          const model = need(settings!.model, 'model');
          const preview = app.preview(left!, right!, { executor: settings!.executor, model }, retryOf); reviewId = preview.reviewId;
          const result = createEntityLinkCliPlan(workspace, preview);
          this.log(flags.json ? JSON.stringify(result, null, 2) : formatEntityLinkPreview(result, this.lang)); break;
        }
        case 'propose': {
          const preview = plan!.preview, existing = app.list().find(history => history.reviewId === preview.reviewId);
          const prepared = app.prepare({ reviewId: preview.reviewId, requestId: preview.requestId, plan: preview.plan, confirmDigest: preview.plan.confirmedDigest });
          if (existing && (!flags['start-prepared'] || app.projectHistory(prepared).status !== 'prepared')) {
            emit(prepared, true); this.logToStderr(t('该身份已有持久记录，本次零调用。先 show；仅 prepared 可显式 --start-prepared 继续。', 'This identity already has a durable record; no invocation. Inspect with show; only prepared can explicitly continue with --start-prepared.'));
            if (app.projectHistory(prepared).status === 'prepared') failed = true;
            break;
          }
          await this.runWithCancellation(async signal => emit(await app.start({ reviewId: preview.reviewId, requestId: preview.startRequestId, expectedGeneration: 1 }, signal), true));
          break;
        }
        case 'list': this.log(JSON.stringify({ responseKind: 'entity-link-invocation-list', workspace, rows: app.list().map(history => app.projectHistory(history)) }, null, 2)); break;
        case 'show': emit(app.inspect(id!).history); break;
        case 'accept': emit(app.decide({ reviewId: id!, requestId: requestId!, expectedGeneration: flags.generation!, decision: 'accept', identityConfirmed: true,
          reason: flags.reason!, ...(flags['object-label'] === undefined ? {} : { objectLabel: flags['object-label'] }) }), true); break;
        case 'reject': emit(app.decide({ reviewId: id!, requestId: requestId!, expectedGeneration: flags.generation!, decision: 'reject', reason: flags.reason! })); break;
        case 'resume': {
          if (flags['cancel-before-start']) { emit(app.cancelBeforeStart({ reviewId: id!, requestId: requestId!, expectedGeneration: flags.generation!, reason: flags.reason! }), true); break; }
          if (flags['recover-unknown']) app.recoverUnknown(id!, requestId!);
          emit(app.resume(id!), true); break;
        }
      }
    } catch (cause) {
      if (cause instanceof Errors.CLIError && cause.oclif.exit === 2) throw cause;
      const inspect = reviewId ? `omk observe entity-links show --id ${reviewId} --workspace ${shellQuoteArg(chosenWorkspace ?? '<workspace>')} --json` : 'omk observe entity-links --help';
      this.error(`${cause instanceof Error ? cause.message : t('操作未完成。', 'Operation did not complete.')}\n${t('先核对已保存身份；不要盲目重新调用模型。', 'Inspect the saved identity before invoking again.')}\n${inspect}`, { exit: 1 });
    }
    if (failed) this.exit(1);
  }
}
