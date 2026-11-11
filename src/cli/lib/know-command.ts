import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { resolve } from 'node:path';
import { Flags } from '@oclif/core';
import { z } from 'zod';
import { BaseCommand } from '../oclif/base-command.js';
import { bilingual } from '../oclif/i18n.js';
import { UserSettingsStore } from '../../settings/user-settings.js';
import { createExtractionArchiveProducer } from '../../executors/archive.js';
import { createLocalKnowledgeApplication, createLocalKnowledgeRelations, createLocalKnowledgeReview } from '../../knowledge/application/local.js';
import { createLocalKnowledgeGenerationModel } from '../../knowledge/adapters/generation-host.js';
import {
  executeKnowledgeOperation,
  KnowledgeOperationSchema,
  knowledgeFailureCode,
  type KnowledgeOperation,
} from '../../knowledge/application/operations.js';
import { executeKnowledgeReviewOperation, KnowledgeReviewOperationSchema, type KnowledgeReviewOperation } from '../../knowledge/application/review-operations.js';
import {
  executeKnowledgeRelationOperation,
  KnowledgeRelationOperationSchema,
  knowledgeRelationFailureCode,
  type KnowledgeRelationOperation,
} from '../../knowledge/application/relation-operations.js';
import { KnowledgeGraphRequestSchema } from '../../knowledge/application/graph.js';
import { KnowledgeRetrievalBudgetError } from '../../knowledge/application/retrieval.js';
import { readLocalSourceScope } from '../../knowledge/application/local-source-host.js';
import { knowledgeReviewCliActor } from './knowledge-review-actor.js';
import { formatKnowledgeResult } from './knowledge-output.js';

export const knowWorkspaceFlag = Flags.string({
  description: bilingual({ zh: '显式知识工作区，省略使用设置。', en: 'Explicit knowledge workspace; defaults to settings.' }),
});
export const knowJsonFlag = Flags.boolean({
  default: false,
  description: bilingual({ zh: '输出完整机器 JSON。', en: 'Print complete machine JSON.' }),
});

const modelOperations = new Set([
  'prepare-generation',
  'prepare-source-review',
  'generate',
  'continue-stage',
  'prepare-rebuild-associations',
  'rebuild-associations',
]);

export interface KnowOperationOptions {
  workspace?: string;
  json?: boolean;
  format?: 'json' | 'text';
  executor?: string;
  model?: string;
  scope?: string;
  actualActor?: boolean;
}

export abstract class KnowCommand extends BaseCommand {
  protected t(zh: string, en: string): string {
    return this.lang === 'zh' ? zh : en;
  }

  protected required(value: string | undefined, name: string): string {
    if (!value?.trim()) this.error(`--${name} ${this.t('必填', 'is required')}`, { exit: 2 });
    return value!;
  }

  protected workspace(value?: string): string {
    return value?.trim() ? resolve(value.trim()) : new UserSettingsStore().resolve({}).workspace;
  }

  protected input(path: string | undefined, maxBytes = 16 * 1024 * 1024): unknown {
    const file = this.required(path, 'input');
    try {
      const before = lstatSync(file, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(maxBytes)) throw new Error('Invalid input file.');
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const opened = fstatSync(fd, { bigint: true });
        if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) throw new Error('Input binding changed.');
        const buffer = Buffer.allocUnsafe(Number(before.size) + 1);
        let offset = 0;
        while (offset < buffer.length) {
          const count = readSync(fd, buffer, offset, buffer.length - offset, null);
          if (!count) break;
          offset += count;
        }
        const bytes = buffer.subarray(0, offset);
        const after = fstatSync(fd, { bigint: true });
        const named = lstatSync(file, { bigint: true });
        if (offset !== Number(before.size) || [after, named].some(stat => stat.ino !== before.ino || stat.dev !== before.dev || stat.size !== before.size
          || stat.mtimeNs !== before.mtimeNs || stat.ctimeNs !== before.ctimeNs || !stat.isFile() || stat.isSymbolicLink())) {
          throw new Error('Input changed during read.');
        }
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } finally {
        closeSync(fd);
      }
    } catch {
      this.error(this.t(`--input 必须是 ${maxBytes} 字节内的普通 UTF-8 JSON 文件。`, `--input must be a regular UTF-8 JSON file within ${maxBytes} bytes.`), { exit: 2 });
    }
  }

  protected inputObject(path: string | undefined): Record<string, unknown> {
    const value = this.input(path);
    if (!value || typeof value !== 'object' || Array.isArray(value) || 'operation' in value) {
      this.error(this.t('--input 必须是不含 operation 的 JSON 对象，操作由命令指定。', '--input must be a JSON object without operation; the command supplies the operation.'), { exit: 2 });
    }
    return value as Record<string, unknown>;
  }

  protected actualActor() {
    const actor = knowledgeReviewCliActor(process.env);
    if (!actor) {
      this.error(this.t('写入需要可信宿主的实际操作者上下文，不能回落为真人。', 'Writes require actual-actor context from a trusted host; no human fallback is inferred.'), { exit: 2 });
    }
    return actor;
  }

  protected sourceScope(path?: string) {
    if (path === undefined) return undefined;
    try {
      return readLocalSourceScope(path);
    } catch {
      this.error(this.t('--scope 必须是 1 MiB 内的独立可信宿主绑定 JSON。', '--scope must be independent trusted host bindings JSON within 1 MiB.'), { exit: 2 });
    }
  }

  protected async executeKnowOperation(operation: KnowledgeOperation, options: KnowOperationOptions): Promise<void> {
    const checked = KnowledgeOperationSchema.safeParse(operation);
    if (!checked.success) {
      this.error(this.t('操作参数无效。', 'Invalid operation parameters.') + '\n'
        + checked.error.issues.map(issue => issue.path.join('.')).join(', '), { exit: 2 });
    }
    let request = checked.data;
    const settings = new UserSettingsStore().resolve({
      workspace: options.workspace,
      executor: options.executor,
      model: options.model,
    });
    if (modelOperations.has(operation.operation)) {
      request = {
        ...operation,
        executor: settings.executor,
        model: this.required(settings.model, 'model'),
      } as KnowledgeOperation;
    }
    const reviewActor = operation.operation === 'review-source-coverage' ? this.actualActor() : undefined;
    const actor = options.actualActor ? knowledgeReviewCliActor(process.env) : undefined;
    const app = createLocalKnowledgeApplication(settings.workspace, {
      sourceScope: this.sourceScope(options.scope),
      reviewActor,
      actor,
    });
    await this.runWithCancellation(async signal => {
      let result: unknown;
      try {
        result = await executeKnowledgeOperation(app, request, signal, (executor, model) =>
          createLocalKnowledgeGenerationModel(executor, model, createExtractionArchiveProducer));
      } catch (cause) {
        if (cause instanceof KnowledgeRetrievalBudgetError) this.error(cause.message, { exit: 2 });
        const code = knowledgeFailureCode(cause);
        const detail = cause instanceof z.ZodError
          ? cause.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('\n')
          : cause instanceof Error ? cause.message : String(cause);
        const next = operation.operation === 'search-source' ? '' : '\n' + this.t(
          '先 runs inspect／list 核对状态；runs resume 不发送模型，unknown claim 禁止重发。',
          'Inspect runs first; runs resume does not dispatch models and unknown claims must not be redispatched.',
        );
        this.error(`${code} · ${detail}${next}`, { exit: 1 });
      }
      this.log(operation.operation === 'retrieve' || operation.operation === 'search-source'
        ? options.format === 'text' ? String(result) : JSON.stringify(result)
        : options.json ? JSON.stringify(result, null, 2)
          : formatKnowledgeResult(result, this.lang, operation, settings.workspace));
      if (result && typeof result === 'object' && 'journal' in result
        && (result.journal as { status: string }).status !== 'completed'
        && (!('nextAction' in result) || !['continue_stage', 'prepare_next_stage'].includes(String(result.nextAction)))) {
        this.exit(1);
      }
    });
  }

  protected executeKnowReview(input: KnowledgeReviewOperation, workspace: string | undefined): void {
    const checked = KnowledgeReviewOperationSchema.safeParse(input);
    if (!checked.success) this.error(this.t('复核参数无效。', 'Invalid review input.'), { exit: 2 });
    const parsed = checked.data;
    const actor = parsed.operation === 'review-status' ? undefined : this.actualActor();
    try {
      const result = executeKnowledgeReviewOperation(createLocalKnowledgeReview(this.workspace(workspace), actor), parsed);
      this.log(JSON.stringify(result, null, 2));
    } catch (cause) {
      this.error(`${knowledgeFailureCode(cause)} · ${cause instanceof Error ? cause.message : String(cause)}`, { exit: 1 });
    }
  }

  protected executeKnowRelation(input: KnowledgeRelationOperation, workspace: string | undefined): void {
    const checked = KnowledgeRelationOperationSchema.safeParse(input);
    if (!checked.success) this.error(this.t('关系参数无效。', 'Invalid relation input.'), { exit: 2 });
    const parsed = checked.data;
    const reading = parsed.operation === 'relations' || parsed.operation === 'relation';
    const actor = reading ? undefined : this.actualActor();
    try {
      const result = executeKnowledgeRelationOperation(createLocalKnowledgeRelations(this.workspace(workspace), actor), parsed);
      this.log(JSON.stringify(result, null, 2));
    } catch (cause) {
      this.error(`${knowledgeRelationFailureCode(cause)} · ${cause instanceof Error ? cause.message : String(cause)}`, { exit: 1 });
    }
  }

  protected executeKnowGraph(value: unknown, workspace: string | undefined): void {
    const parsed = KnowledgeGraphRequestSchema.safeParse(value);
    if (!parsed.success) this.error(this.t('图谱范围无效。', 'Invalid graph scope.'), { exit: 2 });
    try {
      this.log(JSON.stringify(createLocalKnowledgeApplication(this.workspace(workspace)).graph(parsed.data), null, 2));
    } catch (cause) {
      this.error(`${knowledgeFailureCode(cause)} · ${cause instanceof Error ? cause.message : String(cause)}`, { exit: 1 });
    }
  }
}
